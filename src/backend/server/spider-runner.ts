import vm from "node:vm"
import http from "node:http"
import https from "node:https"
import dns from "node:dns/promises"
import CryptoJS from "crypto-js"
// 用 slim 入口：只含 HTML 解析与选择器（脚本只需 cheerio.load），
// 不含 undici / encoding-sniffer，产物更小且不依赖被 external 的 iconv-lite。
import * as cheerio from "cheerio/slim"
import { shareInfo, shareList, sharePlay } from "./drive-share"

/**
 * OmniBox JS 爬虫沙箱运行器。
 *
 * 设计边界：
 *  1. 用 node:vm 提供隔离上下文，超时受控；不做进程级隔离，因此脚本只来自
 *     管理员自己导入，访问码校验在路由层完成。
 *  2. omnibox_sdk shim：request 走 fetch；log 走 console；需要 Chromium 的
 *     sniffVideo / 刮削 / 弹幕 / 网盘能力返回安全空值，避免误判成功。
 *  3. cheerio 用真实 npm 包（脚本按 jQuery 写法，自制 shim 覆盖不了 .next/.parents/:has）；
 *     axios 也做成可调用函数（脚本里 axios(cfg) 与 axios.get 混用）。
 *  4. 脚本必须 CommonJS 导出 { home, category, detail, search, play }；
 *     runner.run(module.exports) 在 shim 中是空操作，避免抢占 stdin。
 */

// 客户端 receiveTimeout 约 20s；脚本默认 8s，网盘源给到 15s。
const DEFAULT_TIMEOUT = 8000
const MAX_CODE_BYTES = 512 * 1024
const DEFAULT_UPSTREAM_TIMEOUT = 10000
// 单个域名最多 12s；脚本动辄写 30s，但一个源常要试 2 个域名，不能把总预算吃光。
const MAX_UPSTREAM_TIMEOUT = 12000
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024

/**
 * EdgeOne 的 fetch 对部分站点会直接失败/403（数字域名、Cloudflare 后面的老网盘站）。
 * 本地验证这些域名用「解析 IP + SNI/Host」的原生 https/http 请求可正常取回页面，
 * 因此把它作为 fetch 失败后的兜底，而不是改脚本。
 */
const FALLBACK_IPS: Record<string, string> = {
  "123.666291.xyz": "198.44.181.178",
  "666.666291.xyz": "69.165.66.174",
  "www.wogg.net": "104.16.151.167",
  "zmi.kdns.fr": "104.21.8.86",
}
const PRIVATE_IP =
  /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1$|fc00:|fd[0-9a-f]{2}:|fe80:)/i

type RawResponse = {
  statusCode: number
  headers: Record<string, string>
  body: string
}

function isBlockedIp(ip: string): boolean {
  return PRIVATE_IP.test(ip) || ip === "localhost"
}

async function resolveUpstreamIp(host: string): Promise<string> {
  const fallback = FALLBACK_IPS[host.toLowerCase()]
  try {
    const rows = await dns.lookup(host, { all: true })
    const v4 = rows.find((r) => r.family === 4 && !isBlockedIp(r.address))
    const any = rows.find((r) => !isBlockedIp(r.address))
    if (v4) return v4.address
    if (any) return any.address
  } catch {}
  if (fallback && !isBlockedIp(fallback)) return fallback
  throw new Error(`DNS failed: ${host}`)
}

function insecureTls(opts: any): boolean {
  const agent = opts?.httpsAgent || opts?.agent
  return !!(agent && (agent.options?.rejectUnauthorized === false || agent.rejectUnauthorized === false))
}

/**
 * 可选的上游代理出口（默认关闭）。
 *
 * EdgeOne 免费版的 fetch 出口会拦截部分域名（数字域名、老网盘站），原生回源在
 * 云函数里也只是 fetch 的兼容层，同样失败。若管理员自建了一个 URL 转发代理
 * （如 Cloudflare Worker），可通过环境变量 SPIDER_PROXY_URL 指定，格式：
 *   - 含 {url} 占位符：https://proxy.example.com/fetch?target={url}
 *   - 否则自动追加 ?url= 参数：https://proxy.example.com/fetch
 * 目标 URL 会 encodeURIComponent 后拼进去；代理需返回原始响应体。
 */
function proxyFetch(
  template: string,
  url: string,
  init: RequestInit,
  budgetMs: number,
): Promise<Response> {
  let target: string
  if (template.includes("{url}")) {
    target = template.replace("{url}", encodeURIComponent(url))
  } else {
    const u = new URL(template)
    u.searchParams.set("url", url)
    target = u.toString()
  }
  return fetch(target, {
    method: init.method,
    headers: init.headers,
    signal:
      typeof AbortSignal !== "undefined" && typeof (AbortSignal as any).timeout === "function"
        ? ((AbortSignal as any).timeout(Math.max(1000, budgetMs)) as AbortSignal)
        : init.signal,
  })
}

/**
 * 原生回源：连解析出来的 IP，但保留原域名作为 SNI 和 Host。
 * forceHttp 用于目标站拒绝 EdgeOne HTTPS 出口的情况（如 wogg）。
 */
async function rawRequest(
  rawUrl: string,
  opts: any,
  budgetMs: number,
  forceHttp = false,
  depth = 0,
): Promise<RawResponse> {
  const u = new URL(rawUrl)
  const ip = await resolveUpstreamIp(u.hostname)
  const useHttp = forceHttp || u.protocol === "http:"
  const mod = useHttp ? http : https
  const port = u.port ? Number(u.port) : useHttp ? 80 : 443
  const headers: Record<string, any> = {}
  for (const [k, v] of Object.entries(opts?.headers || {})) {
    if (k.toLowerCase() !== "host") headers[k] = v
  }
  headers.Host = u.host
  headers.Connection = "close"

  const payload = opts?.body ?? opts?.data
  const body =
    payload === undefined
      ? undefined
      : typeof payload === "string"
        ? payload
        : JSON.stringify(payload)
  if (body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
    headers["Content-Length"] = Buffer.byteLength(body, "utf8")
  }

  return new Promise<RawResponse>((resolve, reject) => {
    const req = mod.request(
      {
        hostname: ip,
        port,
        method: String(opts?.method || "GET").toUpperCase(),
        path: `${u.pathname}${u.search}`,
        headers,
        servername: useHttp ? undefined : u.hostname,
        rejectUnauthorized: useHttp ? undefined : !insecureTls(opts),
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on("data", (d: Buffer) => {
          size += d.length
          if (size > MAX_UPSTREAM_BYTES) {
            req.destroy(new Error("upstream response too large"))
            return
          }
          chunks.push(d)
        })
        res.on("end", () => {
          const statusCode = Number(res.statusCode || 0)
          const loc = res.headers.location
          if (statusCode >= 300 && statusCode < 400 && loc && depth < 3) {
            rawRequest(new URL(loc, u).toString(), opts, budgetMs, forceHttp, depth + 1).then(resolve, reject)
            return
          }
          const out: Record<string, string> = {}
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") out[k] = v
            else if (Array.isArray(v)) out[k] = v.join(", ")
          }
          resolve({ statusCode, headers: out, body: Buffer.concat(chunks).toString("utf8") })
        })
      },
    )
    req.on("error", reject)
    req.setTimeout(Math.max(1000, budgetMs), () => req.destroy(new Error("upstream timeout")))
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/**
 * 默认库脚本来自公开仓库，不能把部署环境变量整体暴露给沙箱。
 * 这里只放行非敏感键；脚本自带的默认值仍然可用。
 */
const SENSITIVE_ENV =
  /(SECRET|TOKEN|PASSWORD|PASSWD|COOKIE|ACCESS_CODE|JWT|DB_|DATABASE|CREDENTIAL|PRIVATE_KEY|API_KEY)/i

function safeScriptEnv(env: any): Record<string, string> {
  const src = env && typeof env === "object" ? env : process.env || {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(src)) {
    if (SENSITIVE_ENV.test(k) || v === undefined || v === null) continue
    try {
      out[k] = typeof v === "string" ? v : JSON.stringify(v)
    } catch {}
  }
  return out
}

export type SpiderModule = {
  home?: (params: any, ctx: any) => Promise<any>
  category?: (params: any, ctx: any) => Promise<any>
  detail?: (params: any, ctx: any) => Promise<any>
  search?: (params: any, ctx: any) => Promise<any>
  play?: (params: any, ctx: any) => Promise<any>
  init?: (ctx: any) => Promise<any> | any
}

function sdkShim(
  ctx: { fetch: typeof fetch; log: (...a: any[]) => void },
  timeoutMs: number,
  startedAt: number,
  env: any,
) {
  // 进程内缓存，TTL 秒；够跑完一次请求链，不追求跨实例一致
  const cache = new Map<string, { v: string; exp: number }>()
  // 可选代理出口：优先从绑定 env 读，其次 process.env。默认空 = 关闭。
  const proxyTemplate = String(env?.SPIDER_PROXY_URL || process.env?.SPIDER_PROXY_URL || "").trim()
  const sdk: any = {
    log: (level: any, ...args: any[]) => {
      const isLevel = typeof level === "string" && /^(info|warn|error|debug)$/i.test(level)
      if (isLevel) ctx.log(`[${level}]`, ...args)
      else ctx.log(level, ...args)
    },
    /**
     * 真实 OmniBox SDK：request(url, options)，返回 { statusCode, body(string), headers }。
     * 同时兼容 request({ url, ...options }) 的旧写法。
     *
     * 关键：body 必须是字符串（脚本普遍写 JSON.parse(res.body)）；statusCode 必须是数字
     * （脚本写 Number(res.statusCode) !== 200）；两个参数都要收（headers 在第二个）。
     */
    request: async (input: any, options: any = {}) => {
      const isStr = typeof input === "string"
      const opts: any = isStr ? options || {} : { ...(input || {}), ...(options || {}) }
      // 字符串首参就是 url；对象首参才从 url/uri 取
      const url = isStr ? String(input) : String(opts.url || opts.uri || "")
      if (!url) throw new Error("request: missing url")

      const method = String(opts.method || "GET").toUpperCase()
      // 脚本传的 timeout 必须生效，但不允许越过本次 runSpider 的总预算。
      const remaining = Math.max(1000, timeoutMs - (Date.now() - startedAt))
      const asked = Number(opts.timeout)
      const cap =
        Number.isFinite(asked) && asked > 0
          ? Math.min(asked, MAX_UPSTREAM_TIMEOUT)
          : DEFAULT_UPSTREAM_TIMEOUT
      const budgetMs = Math.min(cap, remaining)

      // 注意不要写成 `(init as any)?.signal` —— 那是在初始化 init 时引用自己，会 TDZ 报错。
      const incomingSignal = opts.signal
      const ownSignal =
        typeof AbortSignal !== "undefined" && typeof (AbortSignal as any).timeout === "function"
          ? ((AbortSignal as any).timeout(budgetMs) as AbortSignal)
          : undefined
      const requestSignal: AbortSignal | undefined =
        incomingSignal && typeof incomingSignal.addEventListener === "function"
          ? typeof (AbortSignal as any).any === "function" && ownSignal
            ? (AbortSignal as any).any([incomingSignal, ownSignal])
            : incomingSignal
          : ownSignal
      const init: RequestInit = {
        method,
        headers: opts.headers || {},
        signal: requestSignal,
      }
      const payload = opts.body ?? opts.data
      if (payload !== undefined && method !== "GET" && method !== "HEAD") {
        init.body = typeof payload === "string" ? payload : JSON.stringify(payload)
      }

      let res: any
      let text = ""
      try {
        res = await ctx.fetch(url, init)
        text = await res.text()
        // EdgeOne 出口 IP 常被老网盘站拒绝；这类状态码走原生回源再试一次。
        if ((res.status === 403 || res.status === 429) && opts.fallback !== false) {
          throw new Error(`HTTP ${res.status}`)
        }
      } catch (e: any) {
        const reason = String(e?.message || e)
        const fallbackStarted = Date.now()

        // 配了代理就优先走代理：比原生回源快，且能绕过 EdgeOne 出口对特定域名的拦截。
        if (proxyTemplate) {
          try {
            const pres = await proxyFetch(proxyTemplate, url, init, budgetMs)
            const ptext = await pres.text()
            if (pres.ok && ptext) {
              ctx.log("[proxy]", `代理成功：status=${pres.status} ${Date.now() - fallbackStarted}ms ${url}`)
              return {
                statusCode: pres.status,
                status: pres.status,
                headers: Object.fromEntries(pres.headers.entries()),
                body: ptext,
                data: ptext,
              }
            }
            ctx.log("[proxy]", `代理返回 ${pres.status}，继续原生回源`)
          } catch (pe: any) {
            ctx.log("[proxy]", `代理失败：${String(pe?.message || pe)}，继续原生回源`)
          }
        }

        ctx.log("[fallback]", `${reason} → 原生回源 ${url}`)
        let raw: RawResponse | null = null
        try {
          raw = await rawRequest(url, opts, budgetMs)
        } catch (e2: any) {
          ctx.log("[fallback]", `HTTPS 回源失败：${String(e2?.message || e2)}，改用 HTTP`)
        }
        if (!raw || raw.statusCode === 403 || raw.statusCode === 429) {
          try {
            const viaHttp = await rawRequest(url, opts, budgetMs, true)
            if (!raw || viaHttp.statusCode !== 403) raw = viaHttp
          } catch (e3: any) {
            ctx.log("[fallback]", `HTTP 回源失败：${String(e3?.message || e3)}`)
          }
        }
        if (!raw) throw new Error(`${reason}；原生回源也失败`)
        ctx.log("[fallback]", `回源成功：status=${raw.statusCode} ${Date.now() - fallbackStarted}ms`)
        return {
          statusCode: raw.statusCode,
          status: raw.statusCode,
          headers: raw.headers,
          body: raw.body,
          data: raw.body,
        }
      }
      return {
        statusCode: res.status,
        status: res.status, // 兼容旧写法
        headers: Object.fromEntries(res.headers.entries()),
        body: text, // 必须字符串
        data: text, // 兼容旧写法
      }
    },
    fetch: ctx.fetch,
    // ---- 缓存方法（OmniBox 2.x 脚本常用；缺了会 is not a function）----
    getCache: async (key: string) => {
      const hit = cache.get(String(key))
      if (!hit) return ""
      if (hit.exp && hit.exp < Date.now()) {
        cache.delete(String(key))
        return ""
      }
      return hit.v
    },
    setCache: async (key: string, value: any, ttlSeconds = 0) => {
      if (cache.size > 500) cache.clear() // 防脚本把内存撑爆
      cache.set(String(key), {
        v: String(value ?? ""),
        exp: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0,
      })
      return true
    },
    delCache: async (key: string) => cache.delete(String(key)),
    getDanmakuByFileName: async () => [],
    getScrapeMetadata: async () => null,
    processScraping: async () => null,
    // 需要 Chromium / 后端状态的能力，明确降级为空，避免脚本误判成功
    sniffVideo: async () => null,
    getEnv: (key: string) => process.env?.[key] || "",
    scrape: async () => null,
    getDanmu: async () => [],
    // 网盘分享解析（115 / 阿里云盘 / 123，免登录）。网盘类脚本重度依赖这三个方法，
    // 之前返回 null 会让脚本 TypeError（Cannot read properties of null）。
    getDriveInfoByShareURL: (u: string) => shareInfo(u),
    getDriveFileList: (u: string, parentId = "0") => shareList(u, parentId),
    getDriveVideoPlayInfo: (u: string, fileId: string, routeType = "直连") =>
      sharePlay(u, fileId, routeType, env),
    history: async () => [],
    saveHistory: async () => {},
  }
  return sdk
}

export type RunResult = {
  ok: boolean
  data?: any
  error?: string
  ms: number
  /** 脚本日志尾部；用于把「静默空 list」背后的真实错误透传给客户端 */
  logs?: string[]
}

export async function runSpider(
  source: { id: string; name: string; code: string },
  method: string,
  params: any,
  context: any,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<RunResult> {
  const started = Date.now()
  const logs: string[] = []
  const withLogs = <T extends RunResult>(r: T): T => ({ ...r, logs: [...logs] })
  if (Buffer.byteLength(source.code, "utf8") > MAX_CODE_BYTES) {
    return withLogs({ ok: false, error: "script too large", ms: 0 })
  }
  if (!/^(home|category|detail|search|play)$/.test(method)) {
    return withLogs({ ok: false, error: "invalid method", ms: 0 })
  }

  // Python 脚本：node:vm 只能跑 JS。明确报错优于抛一个莫名的 SyntaxError。
  if (String((source as any).type || "") === "Python") {
    return withLogs({
      ok: false,
      error: "该源是 Python 脚本，当前运行时只支持 JavaScript",
      ms: 0,
    })
  }
  const head = source.code.slice(0, 2000)
  const looksPython =
    /^\s*(#.*coding[:=].*\n)?\s*(import\s+\w+|from\s+\w+\s+import|def\s+\w+\s*\()/m.test(head) &&
    !/\b(function|const|let|var|module\.exports)\b/.test(head)
  if (looksPython) {
    return withLogs({
      ok: false,
      error: "该源是 Python 脚本，当前运行时只支持 JavaScript",
      ms: 0,
    })
  }

  let moduleExport: SpiderModule = {}
  const sdk = sdkShim({
    fetch: (...a) => fetch(...a),
    log: (...a) => {
      const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")
      logs.push(line.slice(0, 500))
      if (logs.length > 50) logs.shift()
    },
  }, timeoutMs, started, context?.env)

  const scriptEnv = safeScriptEnv(context?.env)
  const requireShim = (name: string) => {
    if (name === "omnibox_sdk") return sdk
    if (name === "cheerio") return cheerio
    if (name === "spider_runner") return { run: () => {}, OmniBox: sdk }
    if (name === "vm" || name === "node:vm") {
      return {
        createContext: (sandbox: any, opts?: any) =>
          vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false }, ...opts }),
        Script: vm.Script,
        runInNewContext(code: string, sandbox: any = {}) {
          const nested: any = {
            ...sandbox,
            require: requireShim,
            module: { exports: {} },
            exports: {},
            console: sandbox.console || console,
            fetch,
            process: { env: scriptEnv },
          }
          const ctx = vm.createContext(nested, { codeGeneration: { strings: false, wasm: false } })
          new vm.Script(code).runInContext(ctx, { timeout: 5000 })
          return nested.module.exports
        },
      }
    }
    if (name === "axios") {
      // 脚本里 axios({url}) / axios.request(cfg) / axios.get() 混用 —— axios 本身必须是函数
      const asJson = (t: string) => {
        try {
          return JSON.parse(t)
        } catch {
          return t
        }
      }
      const wrap = (r: any) => ({
        status: r.statusCode,
        statusText: "",
        headers: r.headers,
        data: asJson(r.body),
      })
      const send = async (url: string, cfg: any = {}) => {
        const o = { ...cfg }
        if (o.data !== undefined && o.body === undefined) o.body = o.data
        if (o.params) {
          const q = new URLSearchParams(o.params).toString()
          if (q && !String(url).includes("?")) url += `?${q}`
        }
        return wrap(await sdk.request(url, o))
      }
      const axios: any = async (a: any, b: any = {}) =>
        typeof a === "string" ? send(a, b) : send(a?.url, a)
      axios.get = (url: string, cfg: any = {}) => send(url, { ...cfg, method: "GET" })
      axios.post = (url: string, data: any, cfg: any = {}) => send(url, { ...cfg, data, method: "POST" })
      axios.request = (cfg: any = {}) => send(cfg.url, cfg)
      axios.create = (base: any = {}) => {
        const inst: any = (a: any, b: any = {}) => {
          const cfg = typeof a === "string" ? { ...b, url: a } : { ...(a || {}) }
          // 脚本常把 timeout / responseType / validateStatus / maxRedirects 只写在
          // create() 里，request() 不再重复。只合并 headers 会让实例丢掉这些默认值。
          const merged: any = { ...base, ...cfg }
          if (merged.baseURL && merged.url && !/^https?:/i.test(merged.url)) {
            merged.url =
              String(merged.baseURL).replace(/\/$/, "") + "/" + String(merged.url).replace(/^\//, "")
          }
          merged.headers = { ...(base.headers || {}), ...(cfg.headers || {}) }
          return send(merged.url, merged)
        }
        inst.get = (u: string, c2: any = {}) => inst({ ...c2, url: u, method: "GET" })
        inst.post = (u: string, d: any, c2: any = {}) => inst({ ...c2, url: u, data: d, method: "POST" })
        inst.request = (c2: any = {}) => inst(c2)
        inst.defaults = { headers: { common: {} }, ...(base.defaults || {}), ...base }
        inst.interceptors = { request: { use: () => {} }, response: { use: () => {} } }
        return inst
      }
      axios.defaults = { headers: { common: {} } }
      axios.interceptors = { request: { use: () => {} }, response: { use: () => {} } }
      return axios
    }
    if (name === "fs" || name === "node:fs") {
      // 边缘运行时没有文件系统：给最小面，读不到就当空，脚本自己会降级
      return {
        existsSync: () => false,
        readFileSync: () => {
          throw new Error("fs is not available on edge runtime")
        },
        writeFileSync: () => {},
        mkdirSync: () => {},
        promises: { readFile: async () => "", writeFile: async () => {}, mkdir: async () => {} },
      }
    }
    if (name === "crypto-js") {
      // crypto-js 已是项目依赖且会被 esbuild 打包进云函数，直接给脚本用真包。
      // 之前抛错导致金牌等依赖签名的源直接不可用。
      return CryptoJS
    }
    // 脚本会把 Agent 实例传给 axios 的 httpAgent/httpsAgent；shim 不真的用它建连，
    // 但必须是构造函数，否则 `new http.Agent()` 直接抛 "is not a constructor"。
    const DummyAgent = class {
      constructor(_opts?: any) {}
    }
    if (name === "https") return { Agent: DummyAgent }
    if (name === "http") return { Agent: DummyAgent }
    if (name === "crypto" || name === "node:crypto") return globalThis.crypto
    // 常见安全 Node 内置模块：云函数运行时提供，失败则明确拒绝
    if (/^(path|querystring|url|util|buffer|node:path|node:querystring|node:url|node:util|node:buffer)$/.test(name)) {
      if (typeof require === "function") {
        try {
          return require(name)
        } catch {}
      }
    }
    throw new Error(`unsupported module: ${name}`)
  }

  const sandbox: any = {
    require: requireShim,
    module: { exports: {} },
    exports: {},
    process: { env: scriptEnv, platform: "browser", version: "v22.0.0" },
    console: {
      log: (...a: any[]) => sdk.log(...a),
      warn: (...a: any[]) => sdk.log("[warn]", ...a),
      error: (...a: any[]) => sdk.log("[error]", ...a),
    },
    Buffer,
    // 网盘脚本常用 performance.now() 统计递归列目录耗时；vm 里默认没有这个全局。
    performance: { now: () => Number(process.hrtime.bigint() / 1000000n) },
    setTimeout,
    clearTimeout,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    btoa,
    atob,
    fetch: (...a: any[]) => fetch(a[0], a[1]),
    crypto: globalThis.crypto,
    __logs: logs,
  }
  sandbox.globalThis = sandbox
  sandbox.window = sandbox

  try {
    const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
    const script = new vm.Script(source.code, { filename: `${source.id}.js` })
    script.runInContext(context, { timeout: timeoutMs })
    moduleExport = sandbox.module.exports && Object.keys(sandbox.module.exports).length
      ? sandbox.module.exports
      : sandbox.exports || {}

    if (typeof moduleExport.init === "function") {
      await Promise.resolve(moduleExport.init(context))
    }
    const fn = moduleExport[method as keyof SpiderModule]
    if (typeof fn !== "function") {
      return withLogs({
        ok: false,
        error: `script does not export ${method}()`,
        ms: Date.now() - started,
      })
    }
    // 脚本里 context.from 的语义是「客户端类型」（tvbox/sutv…），不是方法名。
    // 按客户端分支的脚本若收到 from:"home" 会走错路径。
    const scriptCtx = {
      ...(context || {}),
      from: "tvbox",
      sourceId: source.id,
      env: context?.env,
      headers: context?.headers || {},
      // 云函数没有客户端的网盘登录态：依赖 context.drives 的 link:// 线路不可用，
      // 显式给空数组，脚本走自己的降级分支，而不是 undefined 引发 TypeError。
      drives: (context as any)?.drives || [],
    }
    const data = await Promise.race([
      Promise.resolve((fn as any)(params || {}, scriptCtx)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("script timeout")), timeoutMs),
      ),
    ])
    return withLogs({ ok: true, data: data ?? {}, ms: Date.now() - started })
  } catch (e: any) {
    return withLogs({
      ok: false,
      error: String(e?.message || e).slice(0, 500),
      ms: Date.now() - started,
    })
  }
}

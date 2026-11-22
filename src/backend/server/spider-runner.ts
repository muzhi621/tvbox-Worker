import vm from "node:vm"
// 用 slim 入口：只含 HTML 解析与选择器（脚本只需 cheerio.load），
// 不含 undici / encoding-sniffer，产物更小且不依赖被 external 的 iconv-lite。
import * as cheerio from "cheerio/slim"

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

const DEFAULT_TIMEOUT = 15000
const MAX_CODE_BYTES = 512 * 1024

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

function sdkShim(ctx: { fetch: typeof fetch; log: (...a: any[]) => void }) {
  // 进程内缓存，TTL 秒；够跑完一次请求链，不追求跨实例一致
  const cache = new Map<string, { v: string; exp: number }>()
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
      const init: RequestInit = { method, headers: opts.headers || {} }
      const payload = opts.body ?? opts.data
      if (payload !== undefined && method !== "GET" && method !== "HEAD") {
        init.body = typeof payload === "string" ? payload : JSON.stringify(payload)
      }

      const res = await ctx.fetch(url, init)
      const text = await res.text()
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
    getDriveFileList: async () => [],
    getDriveVideoPlayInfo: async () => null,
    getDriveInfoByShareURL: async () => null,
    history: async () => [],
    saveHistory: async () => {},
  }
  return sdk
}

export type RunResult = { ok: boolean; data?: any; error?: string; ms: number }

export async function runSpider(
  source: { id: string; name: string; code: string },
  method: string,
  params: any,
  context: any,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<RunResult> {
  const started = Date.now()
  if (Buffer.byteLength(source.code, "utf8") > MAX_CODE_BYTES) {
    return { ok: false, error: "script too large", ms: 0 }
  }
  if (!/^(home|category|detail|search|play)$/.test(method)) {
    return { ok: false, error: "invalid method", ms: 0 }
  }

  // Python 脚本：node:vm 只能跑 JS。明确报错优于抛一个莫名的 SyntaxError。
  if (String((source as any).type || "") === "Python") {
    return { ok: false, error: "该源是 Python 脚本，当前运行时只支持 JavaScript", ms: 0 }
  }
  const head = source.code.slice(0, 2000)
  const looksPython =
    /^\s*(#.*coding[:=].*\n)?\s*(import\s+\w+|from\s+\w+\s+import|def\s+\w+\s*\()/m.test(head) &&
    !/\b(function|const|let|var|module\.exports)\b/.test(head)
  if (looksPython) {
    return { ok: false, error: "该源是 Python 脚本，当前运行时只支持 JavaScript", ms: 0 }
  }

  let moduleExport: SpiderModule = {}
  const logs: string[] = []
  const sdk = sdkShim({
    fetch: (...a) => fetch(...a),
    log: (...a) => {
      const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")
      logs.push(line.slice(0, 500))
      if (logs.length > 50) logs.shift()
    },
  })

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
          if (base.baseURL && cfg.url && !/^https?:/i.test(cfg.url)) {
            cfg.url = String(base.baseURL).replace(/\/$/, "") + "/" + String(cfg.url).replace(/^\//, "")
          }
          cfg.headers = { ...(base.headers || {}), ...(cfg.headers || {}) }
          return send(cfg.url, cfg)
        }
        inst.get = (u: string, c2: any = {}) => inst({ ...c2, url: u, method: "GET" })
        inst.post = (u: string, d: any, c2: any = {}) => inst({ ...c2, url: u, data: d, method: "POST" })
        inst.request = (c2: any = {}) => inst(c2)
        inst.defaults = { headers: { common: {} }, ...(base.defaults || {}) }
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
      // 假实现算出来的签名是错的，源会返回"参数错误"，比明确报错更难排查
      throw new Error("该源依赖 crypto-js，当前运行时未提供")
    }
    if (name === "https") return { Agent: class {} }
    if (name === "http") return {}
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
      return {
        ok: false,
        error: `script does not export ${method}()`,
        ms: Date.now() - started,
      }
    }
    // 脚本里 context.from 的语义是「客户端类型」（tvbox/sutv…），不是方法名。
    // 按客户端分支的脚本若收到 from:"home" 会走错路径。
    const scriptCtx = {
      ...(context || {}),
      from: "tvbox",
      sourceId: source.id,
      env: context?.env,
      headers: context?.headers || {},
    }
    const data = await Promise.race([
      Promise.resolve((fn as any)(params || {}, scriptCtx)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("script timeout")), timeoutMs),
      ),
    ])
    return { ok: true, data: data ?? {}, ms: Date.now() - started }
  } catch (e: any) {
    return {
      ok: false,
      error: String(e?.message || e).slice(0, 500),
      ms: Date.now() - started,
    }
  }
}

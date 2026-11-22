import vm from "node:vm"
import * as parse5 from "parse5"

/**
 * OmniBox JS 爬虫沙箱运行器。
 *
 * 设计边界：
 *  1. 用 node:vm 提供隔离上下文，超时受控；不做进程级隔离，因此脚本只来自
 *     管理员自己导入，访问码校验在路由层完成。
 *  2. omnibox_sdk shim：request 走 fetch；log 走 console；需要 Chromium 的
 *     sniffVideo / 刮削 / 弹幕 / 网盘能力返回安全空值，避免误判成功。
 *  3. cheerio shim 基于项目已有 parse5，覆盖 .load / .each / .find / .attr /
 *     .text 等采集脚本常用 API。
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

const isElement = (n: any) => !!n && n.nodeName !== "#text" && n.nodeName !== "#comment" && Array.isArray(n.attrs)
const childrenOf = (n: any): any[] => (n && Array.isArray(n.childNodes) ? n.childNodes : [])

function textOf(node: any): string {
  if (!node) return ""
  if (node.nodeName === "#text") return String(node.value || "")
  if (node.nodeName === "#comment") return ""
  return childrenOf(node).map(textOf).join("")
}

function attrOf(node: any, name: string): string | undefined {
  if (!node || !isElement(node)) return undefined
  const attr = (node.attrs || []).find((a: any) => a.name === name)
  return attr ? String(attr.value ?? "") : undefined
}

type Sel = { tag?: string; id?: string; cls?: string; attr?: [string, string]; pseudo?: string }

function parseSelector(raw: string): Sel[] {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      let work = s
      let pseudo: string | undefined
      const pm = work.match(/:(first|last|nth-child\(\d+\))$/i)
      if (pm) {
        pseudo = pm[1].toLowerCase()
        work = work.slice(0, -pm[0].length)
      }
      const attrMatch = work.match(/\[([A-Za-z0-9_:-]+)(?:=["']?([^\]"']*)["']?)?\]/)
      let attr: [string, string] | undefined
      if (attrMatch) {
        attr = [attrMatch[1].toLowerCase(), attrMatch[2] || ""]
        work = work.replace(attrMatch[0], "")
      }
      const idMatch = work.match(/#([A-Za-z0-9_-]+)/)
      const clsMatch = work.match(/\.([A-Za-z0-9_-]+)/)
      const tagMatch = work.match(/^([A-Za-z][A-Za-z0-9-]*)/)
      return {
        tag: tagMatch?.[1]?.toLowerCase(),
        id: idMatch?.[1],
        cls: clsMatch?.[1],
        attr,
        pseudo,
      }
    })
}

function matches(node: any, sel: Sel): boolean {
  if (!isElement(node)) return false
  if (sel.tag && String(node.tagName || node.nodeName).toLowerCase() !== sel.tag) return false
  if (sel.id && attrOf(node, "id") !== sel.id) return false
  if (sel.cls) {
    const cls = String(attrOf(node, "class") || "")
      .split(/\s+/)
      .filter(Boolean)
    if (!cls.includes(sel.cls)) return false
  }
  if (sel.attr) {
    const v = attrOf(node, sel.attr[0])
    if (v === undefined) return false
    if (sel.attr[1] && v !== sel.attr[1]) return false
  }
  return true
}

function walk(root: any, fn: (n: any) => void) {
  if (!root) return
  fn(root)
  for (const c of childrenOf(root)) walk(c, fn)
}

function applyPseudo(nodes: any[], pseudo?: string): any[] {
  if (!pseudo || nodes.length <= 1) return nodes
  if (pseudo === "first") return nodes.slice(0, 1)
  if (pseudo === "last") return nodes.slice(-1)
  const m = pseudo.match(/nth-child\((\d+)\)/)
  if (m) {
    const idx = Number(m[1]) - 1
    return idx >= 0 && idx < nodes.length ? [nodes[idx]] : []
  }
  return nodes
}

function select(root: any, selector: string): any[] {
  const groups = String(selector || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const result: any[] = []
  for (const group of groups) {
    // 支持后代选择器：按空格拆成多段，逐层缩小
    const parts = group.split(/\s+/).filter(Boolean)
    let current: any[] = [root]
    for (const part of parts) {
      const sels = parseSelector(part)
      const next: any[] = []
      for (const base of current) {
        for (const sel of sels) {
          const hits: any[] = []
          walk(base, (n) => {
            if (n !== base && matches(n, sel)) hits.push(n)
          })
          if (sels.length === 1 && sel.pseudo) next.push(...applyPseudo(hits, sel.pseudo))
          else next.push(...hits)
        }
      }
      current = next
    }
    result.push(...current)
  }
  return result
}

function makeSelection(nodes: any[], root?: any) {
  const api: any = {
    length: nodes.length,
    [Symbol.iterator]: function* () {
      yield* nodes
    },
    each(fn: (i: number, el: any) => void) {
      nodes.forEach((n, i) => fn(i, n))
      return api
    },
    map(fn: (i: number, el: any) => any) {
      return nodes.map((n, i) => fn(i, n))
    },
    get(i = 0) {
      return nodes[i]
    },
    eq(i: number) {
      return makeSelection([nodes[i]], root)
    },
    first() {
      return makeSelection(nodes.slice(0, 1), root)
    },
    last() {
      return makeSelection(nodes.slice(-1), root)
    },
    find(selector: string) {
      const out: any[] = []
      for (const n of nodes) out.push(...select(n, selector))
      return makeSelection(out, root)
    },
    closest(selector: string) {
      const out: any[] = []
      for (let n = nodes[0]; n; n = n.parentNode) {
        if (matches(n, parseSelector(selector)[0])) {
          out.push(n)
          break
        }
      }
      return makeSelection(out, root)
    },
    attr(name: string, value?: string) {
      if (value !== undefined) {
        for (const n of nodes) {
          if (!isElement(n)) continue
          const attr = (n.attrs || []).find((a: any) => a.name === name)
          if (attr) attr.value = value
          else n.attrs.push({ name, value })
        }
        return api
      }
      return nodes.length ? attrOf(nodes[0], name) : undefined
    },
    data(name: string) {
      return api.attr(`data-${name}`)
    },
    text() {
      return nodes.map((n) => textOf(n)).join("")
    },
    html() {
      if (!nodes.length) return ""
      try {
        return nodes.map((n) => parse5.serialize(n)).join("") || textOf(nodes[0])
      } catch {
        return textOf(nodes[0])
      }
    },
    parent() {
      const out = nodes.map((n) => n.parentNode).filter(Boolean)
      return makeSelection(out, root)
    },
    children() {
      const out: any[] = []
      for (const n of nodes) out.push(...childrenOf(n).filter(isElement))
      return makeSelection(out, root)
    },
    is(selector: string) {
      return nodes.some((n) => matches(n, parseSelector(selector)[0]))
    },
    remove() {
      for (const n of nodes) {
        if (n.parentNode && Array.isArray(n.parentNode.childNodes)) {
          n.parentNode.childNodes = n.parentNode.childNodes.filter((c: any) => c !== n)
        }
      }
      return api
    },
  }
  return api
}

function linkParents(node: any, parent?: any) {
  if (!node) return
  if (parent) node.parentNode = parent
  for (const c of childrenOf(node)) linkParents(c, node)
}

function cheerioShim() {
  return {
    load(source: string) {
      const doc: any = parse5.parse(String(source || ""))
      linkParents(doc)
      const rootFn: any = (input: any) =>
        input && typeof input === "object" && input.nodeName
          ? makeSelection([input], doc)
          : makeSelection(select(doc, String(input || "")), doc)
      rootFn.root = () => makeSelection([doc], doc)
      rootFn.html = () => parse5.serialize(doc)
      rootFn.text = () => textOf(doc)
      return rootFn
    },
  }
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
    if (name === "cheerio") return cheerioShim()
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
      // 脚本按真实 axios 写：res.data 是解析后的对象、res.status 是数字
      const asJson = (text: string) => {
        try {
          return JSON.parse(text)
        } catch {
          return text
        }
      }
      const wrap = (r: any) => ({
        status: r.statusCode,
        statusText: "",
        headers: r.headers,
        data: asJson(r.body),
      })
      const get = async (url: string, cfg: any = {}) =>
        wrap(await sdk.request(url, { ...cfg, method: "GET" }))
      const post = async (url: string, body: any, cfg: any = {}) =>
        wrap(await sdk.request(url, { ...cfg, method: "POST", body }))
      return {
        create: () => ({
          get,
          post,
          request: async (cfg: any) => wrap(await sdk.request(cfg.url, cfg)),
        }),
        get,
        post,
        request: async (cfg: any) => wrap(await sdk.request(cfg.url, cfg)),
      }
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

import { Hono } from "hono"
import { getItem, listItems } from "../internal/op/storage"
import { search } from "../internal/op/search"
import { getUserFromContext } from "./middlewares"
import {
  getActualPath,
  isWithinUserRoot,
} from "../pkg/permission"
import {
  getSignExpiresIn,
  getSignPolicy,
  isEncryptPath,
  signDownloadPath,
} from "../pkg/sign"
import { getNearestMeta, canAccess } from "../pkg/meta"
import { safeErrorMessage } from "../pkg/errs"
import {
  accessDenied,
  constantTimeEqual,
  envValue,
  hmac,
  readSources,
  readConfig,
  readSubscription,
  type TvboxSource,
} from "./tvbox-store"
import { runSpider } from "./spider-runner"
import { requestUrl } from "./request-origin"

/**
 * TVBox / CatVod 兼容端点。
 *
 * 设计边界（重要）：
 *  1. 客户端永远不能提交文件系统路径，只能提交 sourceId。服务端把
 *     sourceId 映射到已配置（数据库或环境变量）的固定路径。
 *  2. 订阅地址可用 sources=a,b 选择部分源，签名由服务端签发，客户端
 *     无法伪造；源路径始终由服务端映射。
 *  3. detail 返回的 vod_id 是「sourceId + 相对路径 + HMAC」的不透明令牌，
 *     客户端篡改签名即失效；相对路径再经 isWithinUserRoot 二次校验。
 *  4. 签名直链只在 detail 请求时现取现签，绝不写入 KV / 订阅配置 / 日志。
 *  5. 访问码 TVBOX_ACCESS_CODE 只用于挡住随手扫到订阅地址的人，它不是
 *     网盘凭据；网盘凭据始终留在 OpenList 侧。
 */

export const tvboxRouter = new Hono()

// TVBox / 影视 App 常用 WebView 直连订阅地址，必须允许跨域读取，
// 否则浏览器直连会被 CORS 拦截（表现为“无法解析配置”）。
tvboxRouter.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*")
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  c.header("Access-Control-Allow-Headers", "Content-Type, X-TVBox-Code")
  c.header("Access-Control-Max-Age", "86400")
  if (c.req.method === "OPTIONS") return c.body(null, 204)
  await next()
})

const VIDEO_EXT = new Set([
  "mp4", "mkv", "avi", "mov", "wmv", "flv", "m4v", "ts", "rmvb", "rm",
  "3gp", "webm", "m2ts", "vob", "mpg", "mpeg", "strm", "iso", "blu",
])
const SUB_EXT = new Set(["srt", "ass", "ssa", "vtt", "sub"])

type SpiderRef = { id: string; name: string; code: string }

/** OmniBox 脚本返回的视频对象 → MACCMS 字段 */
/**
 * OmniBox 2.x 的 vod_play_sources → 苹果CMS 的 vod_play_from / vod_play_url。
 *
 * 每集地址必须是 http(s)：SUTV 的选集解析只接受 URL，裸 playId 会被丢弃。
 * 因此统一换成 /@tvbox/play 跳转地址（playHref 负责生成本源绝对地址）。
 * 线路分隔 $$$、集分隔 #、集名与地址分隔 $，三者不能出现在字段内，先替换掉。
 */
export function playFieldsOf(
  v: any,
  spiderId: string,
  playHref: (spiderId: string, id: string, flag?: string) => string,
): { from: string; url: string } {
  const direct = String(v?.vod_play_url || "")
  if (direct) {
    // 脚本偶尔直接给裸 vod_play_url（地址是 playId），也要把非 URL 的集包成跳转地址
    const wrapped = direct
      .split("$$$")
      .map((line) =>
        line
          .split("#")
          .map((ep) => {
            const idx = ep.indexOf("$")
            const name = idx >= 0 ? ep.slice(0, idx) : ep
            const addr = idx >= 0 ? ep.slice(idx + 1) : ""
            return /^https?:/i.test(addr) ? ep : `${name}$${playHref(spiderId, addr)}`
          })
          .join("#"),
      )
      .join("$$$")
    return { from: String(v?.vod_play_from || "OmniBox"), url: wrapped }
  }

  const sources = Array.isArray(v?.vod_play_sources) ? v.vod_play_sources : []
  const froms: string[] = []
  const urls: string[] = []
  for (const s of sources) {
    const eps = Array.isArray(s?.episodes) ? s.episodes : []
    if (!eps.length) continue
    const lineName = String(s?.name || "线路").replace(/[$#]/g, " ")
    const items: string[] = []
    for (const e of eps) {
      const raw = e?.playId ?? e?.url ?? e?.playUrl ?? ""
      const id = typeof raw === "string" ? raw : JSON.stringify(raw)
      if (!id) continue
      const name = String(e?.name || "正片").replace(/[$#]/g, " ")
      // 把线路名作为 flag 带上，播放阶段脚本才能选对线路
      items.push(`${name}$${playHref(spiderId, id, lineName)}`)
    }
    if (!items.length) continue
    froms.push(lineName)
    urls.push(items.join("#"))
  }
  if (!froms.length) return { from: String(v?.vod_play_from || "OmniBox"), url: "" }
  return { from: froms.join("$$$"), url: urls.join("$$$") }
}

export function fromSpiderVod(
  v: any,
  spiderId: string,
  spiderName: string,
  playHref: (spiderId: string, id: string, flag?: string) => string,
): any {
  const play = playFieldsOf(v, spiderId, playHref)
  const playId = String(v?.vod_id ?? v?.id ?? v?.playId ?? "")
  return {
    vod_id: `spider:${spiderId}:${b64urlEncode(playId)}`,
    vod_name: String(v?.vod_name || v?.title || v?.name || "未命名"),
    vod_pic: String(v?.vod_pic || v?.pic || ""),
    vod_remarks: String(v?.vod_remarks || v?.remark || ""),
    type_id: spiderId,
    type_name: spiderName,
    vod_year: String(v?.vod_year || v?.year || ""),
    vod_actor: String(v?.vod_actor || v?.actors || ""),
    vod_director: String(v?.vod_director || v?.director || ""),
    vod_content: String(v?.vod_content || v?.description || v?.plot || ""),
    vod_play_from: play.from,
    vod_play_url: play.url,
    vod_tag: "spider",
  }
}

function storageContext(c: any) {
  let waitUntil: ((p: Promise<unknown>) => void) | undefined
  try {
    if (typeof c.executionCtx?.waitUntil === "function") {
      waitUntil = (p: Promise<unknown>) => c.executionCtx.waitUntil(p)
    }
  } catch {}
  return { env: c.env, ...(waitUntil ? { waitUntil } : {}) }
}

function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function b64urlDecode(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

async function makeVodId(
  c: any,
  sourceId: string,
  relativePath: string,
): Promise<string> {
  const payload = b64urlEncode(JSON.stringify({ s: sourceId, p: relativePath }))
  const sig = await hmac(c, payload)
  return sig ? `${payload}.${sig}` : payload
}

async function parseVodId(
  c: any,
  id: string,
): Promise<{ sourceId: string; relativePath: string } | null> {
  try {
    const [payload, sig] = String(id).split(".")
    const expected = await hmac(c, payload)
    if (expected && sig !== expected) return null
    const obj = JSON.parse(b64urlDecode(payload))
    if (typeof obj.s !== "string" || typeof obj.p !== "string") return null
    if (obj.p.includes("..") || obj.p.includes("\0")) return null
    return { sourceId: obj.s, relativePath: obj.p }
  } catch {
    return null
  }
}

function joinPath(base: string, rel: string): string {
  const parts = String(rel || "")
    .split("/")
    .filter((p) => p && p !== "." && p !== "..")
  return parts.length ? `${base.replace(/\/$/, "")}/${parts.join("/")}` : base
}

function relativeOf(base: string, full: string): string {
  const b = base.replace(/\/$/, "")
  return full.startsWith(b + "/") ? full.slice(b.length + 1) : ""
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".")
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ""
}

function isMedia(name: string, isDir: boolean): boolean {
  if (isDir) return true
  const ext = extOf(name)
  return VIDEO_EXT.has(ext) || SUB_EXT.has(ext)
}

function formatSize(n: number): string {
  if (!n || n < 0) return ""
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`
}

function pageOf(c: any): number {
  const raw = c.req.query("pg") || c.req.query("page") || "1"
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 1
}

function absoluteUrl(c: any, path: string): string {
  return requestUrl(c, path)
}

async function toVod(
  c: any,
  source: TvboxSource,
  item: any,
  relativePath?: string,
): Promise<any> {
  const rel = relativePath || item.name || ""
  const thumb =
    typeof item.thumb === "string" && /^https?:\/\//i.test(item.thumb)
      ? item.thumb
      : ""
  return {
    vod_id: await makeVodId(c, source.id, rel),
    vod_name: item.name || "未命名",
    vod_pic: thumb,
    vod_remarks: item.is_dir ? "目录" : formatSize(item.size || 0),
    type_id: source.id,
    type_name: source.name,
    vod_play_from: "OpenList",
    vod_play_url: "",
    vod_tag: item.is_dir ? "folder" : "file",
  }
}

async function listSource(
  c: any,
  source: TvboxSource,
  user: any,
): Promise<any[]> {
  const reqPath = getActualPath(user, source.path)
  if (!isWithinUserRoot(user, reqPath)) return []
  const meta = await getNearestMeta(reqPath, c.env)
  if (!canAccess(user, meta, reqPath, source.password || "")) return []
  const { content } = await listItems(reqPath, storageContext(c))
  const rows: any[] = []
  for (const item of content) {
    if (!isMedia(item.name || "", !!item.is_dir)) continue
    rows.push(await toVod(c, source, item))
  }
  return rows
}

async function searchSources(
  c: any,
  sources: TvboxSource[],
  user: any,
  keyword: string,
): Promise<any[]> {
  const rows: any[] = []
  for (const source of sources) {
    const parent = getActualPath(user, source.path)
    if (!isWithinUserRoot(user, parent)) continue
    try {
      const result: any = await search(
        {
          parent,
          keywords: keyword,
          scope: 0,
          page: 1,
          per_page: 100,
          max_depth: 6,
          max_results: 300,
          user,
          password: source.password || "",
        },
        c.env,
      )
      for (const hit of result?.content || []) {
        const full = joinPath(hit.parent || parent, hit.name || "")
        const rel = relativeOf(parent, full) || hit.name || ""
        if (!isMedia(hit.name || "", !!hit.is_dir)) continue
        rows.push({
          vod_id: await makeVodId(c, source.id, rel),
          vod_name: hit.name || "未命名",
          vod_pic: "",
          vod_remarks: hit.is_dir ? "目录" : formatSize(hit.size || 0),
          type_id: source.id,
          type_name: source.name,
          vod_play_from: "OpenList",
          vod_play_url: "",
          vod_tag: hit.is_dir ? "folder" : "file",
        })
      }
    } catch (e: any) {
      console.warn(`[tvbox] search failed on ${source.id}: ${safeErrorMessage(e)}`)
    }
  }
  return rows
}

async function detail(
  c: any,
  source: TvboxSource,
  relativePath: string,
  user: any,
): Promise<any | null> {
  const fullPath = joinPath(source.path, relativePath)
  const reqPath = getActualPath(user, fullPath)
  if (!isWithinUserRoot(user, reqPath)) return null
  const meta = await getNearestMeta(reqPath, c.env)
  if (!canAccess(user, meta, reqPath, source.password || "")) return null

  const { item, rawUrl } = await getItem(reqPath, storageContext(c))
  if (!rawUrl) return null

  const signPolicy = await getSignPolicy(c)
  const signNeeded = signPolicy.enabled || (await isEncryptPath(c, reqPath))
  let playUrl = absoluteUrl(c, rawUrl)
  if (signNeeded && !/[?&]sign=/.test(playUrl)) {
    const sign = await signDownloadPath(
      c,
      reqPath,
      signPolicy.expiresIn || (await getSignExpiresIn(c)),
    )
    if (sign) playUrl += `${playUrl.includes("?") ? "&" : "?"}sign=${sign}`
  }

  const title = item.name || "播放"
  return {
    vod_id: await makeVodId(c, source.id, relativePath),
    vod_name: title,
    vod_pic: "",
    vod_remarks: formatSize(item.size || 0),
    type_id: source.id,
    type_name: source.name,
    vod_play_from: "OpenList",
    vod_play_url: `${title}$${playUrl}`,
    vod_tag: "file",
  }
}

/**
 * 根据选中的网盘/爬虫源构造 TVBox config.json。
 * 供长链接（sel 参数）与短链接（服务端订阅）两条路径共用，保证行为一致。
 */
async function buildConfigFromSelection(
  c: any,
  netdiskIds: string[],
  spiderIds: string[],
  baseUrl = "",
): Promise<any> {
  const code = envValue(c, "TVBOX_ACCESS_CODE")
  const cfg = await readConfig(c)
  const sites: any[] = []

  const abs = (path: string) => requestUrl(c, path, baseUrl)
  const apiUrl = abs("/@tvbox/api")
  const netdiskParams: string[] = []
  if (code) netdiskParams.push(`code=${encodeURIComponent(code)}`)
  if (netdiskIds.length) {
    const available = cfg.netdisk.map((s) => s.id)
    netdiskParams.push(`sources=${encodeURIComponent(netdiskIds.filter((id) => available.includes(id)).join(","))}`)
  }
  const hasNetdisk = netdiskIds.length ? cfg.netdisk.some((s) => netdiskIds.includes(s.id)) : cfg.netdisk.length > 0
  if (hasNetdisk) {
    sites.push({
      key: "omnibox_netdisk",
      name: "OmniBox 网盘",
      type: 1,
      api: netdiskParams.length ? `${apiUrl}?${netdiskParams.join("&")}` : apiUrl,
      searchable: 1,
      filterable: 0,
      changeable: 0,
    })
  }

  // 每个爬虫源生成独立站点（对齐内网 OmniBox 2.1）：
  // 源内部的分类由 /@tvbox/spider?spider=<id> 的 home() 返回，
  // TVBox 点进某个源后再按该源自己的 categoryId 拉取列表。
  const spiderList = spiderIds.length
    ? cfg.spiders.filter((s) => s.enabled && spiderIds.includes(s.id))
    : cfg.spiders.filter((s) => s.enabled)
  for (const sp of spiderList) {
    const params: string[] = []
    if (code) params.push(`code=${encodeURIComponent(code)}`)
    params.push(`spider=${encodeURIComponent(sp.id)}`)
    if (baseUrl) params.push(`base=${encodeURIComponent(baseUrl)}`)
    sites.push({
      key: `spider_${sp.id}`,
      name: sp.name || sp.id,
      type: 1,
      api: `${abs("/@tvbox/spider")}?${params.join("&")}`,
      searchable: 1,
      filterable: 0,
      changeable: 0,
    })
  }

  if (!sites.length) {
    sites.push({
      key: "omnibox_netdisk",
      name: "OmniBox 网盘",
      type: 1,
      api: netdiskParams.length ? `${apiUrl}?${netdiskParams.join("&")}` : apiUrl,
      searchable: 1,
      filterable: 0,
      changeable: 0,
    })
  }

  return { spider: "", lives: [], parses: [], sites, rules: {} }
}

/**
 * 服务端短订阅端点：/@tvbox/sub/{订阅id}?token={订阅token}
 * 源选择保存在服务端，链接里不再编码冗长的 sel 参数。
 */
tvboxRouter.get("/sub/:id", async (c) => {
  const denied = await accessDenied(c)
  if (denied) return denied

  const id = c.req.param("id")
  const token = c.req.query("token") || ""
  const sub = await readSubscription(c, id, token)
  if (!sub) {
    return c.json({ code: 404, message: "subscription not found or token mismatch", spider: "", sites: [], rules: {} }, 404)
  }
  const netdiskIds: string[] = Array.isArray(sub.netdisk) ? sub.netdisk.map(String) : []
  const spiderIds: string[] = Array.isArray(sub.spiders) ? sub.spiders.map(String) : []
  return c.json(await buildConfigFromSelection(c, netdiskIds, spiderIds, String(sub.baseUrl || "")))
})

tvboxRouter.get("/config.json", async (c) => {
  const denied = await accessDenied(c)
  if (denied) return denied
  const code = envValue(c, "TVBOX_ACCESS_CODE")

  // 旧版 sources 参数与新版 sel 均由服务端签名，签名无效时降级为「全部源」，
  // 不会越权（源路径始终由服务端白名单决定，客户端无法提交路径）。
  const requested = (c.req.query("sources") || "").trim()
  const sig = c.req.query("sig") || ""

  // 新版订阅：sel = {n:[网盘id], s:[爬虫id]}，服务端签名
  const selRaw = (c.req.query("sel") || "").trim()
  let netdiskIds: string[] = []
  let spiderIds: string[] = []
  if (selRaw) {
    const expected = await hmac(c, selRaw)
    if (expected && constantTimeEqual(sig, expected)) {
      try {
        const parsed = JSON.parse(selRaw)
        netdiskIds = Array.isArray(parsed?.n) ? parsed.n.map(String) : []
        spiderIds = Array.isArray(parsed?.s) ? parsed.s.map(String) : []
      } catch {}
    }
  }

  // 用共享构造器生成基础配置（短链接端点走同一逻辑）
  const config: any = await buildConfigFromSelection(c, netdiskIds, spiderIds)
  const sites: any[] = config.sites

  // 兼容旧版 sources 参数（无 sel 时）
  if (!selRaw && requested) {
    const cfg = await readConfig(c)
    const expected = await hmac(c, requested)
    if (expected && constantTimeEqual(sig, expected)) {
      const ids = requested.split(",").map((s) => s.trim()).filter(Boolean)
      const selected = ids.filter((id) => cfg.netdisk.some((s) => s.id === id)).join(",")
      if (selected) {
        const apiUrl = absoluteUrl(c, "/@tvbox/api")
        const params: string[] = []
        if (code) params.push(`code=${encodeURIComponent(code)}`)
        params.push(`sources=${encodeURIComponent(selected)}`)
        sites.length = 0
        sites.push({
          key: "openlist",
          name: "OpenList 网盘",
          type: 1,
          api: `${apiUrl}?${params.join("&")}`,
          searchable: 1,
          filterable: 0,
          changeable: 0,
        })
      }
    }
  }

  return c.json(config)
})

/**
 * 爬虫分类缓存：TVBox 会频繁请求 ac=list 拿分类，每次都跑 home() 太慢。
 * 缓存 10 分钟；脚本更新/重启后自动失效。
 */
const spiderClassCache = new Map<string, { cls: any[]; ts: number }>()
const SPIDER_CLASS_TTL = 10 * 60 * 1000

function toTvboxClasses(raw: any): any[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((x: any) => ({
      type_id: String(x?.type_id ?? x?.typeId ?? x?.tid ?? x?.id ?? ""),
      type_name: String(x?.type_name ?? x?.typeName ?? x?.name ?? ""),
    }))
    .filter((x) => x.type_id)
}

/** 调 home() 取该源自己的分类（带缓存）；返回分类、首页列表与失败原因。 */
async function loadSpiderHome(
  c: any,
  sp: any,
): Promise<{ cls: any[]; list: any[]; error?: string }> {
  const hit = spiderClassCache.get(sp.id)
  if (hit && Date.now() - hit.ts < SPIDER_CLASS_TTL) return { cls: hit.cls, list: [] }
  const res = await runSpider(sp, "home", { page: 1 }, { from: "tvbox", env: c.env })
  if (!res.ok) return { cls: [], list: [], error: res.error || "home failed" }
  const d = res.data || {}
  const cls = toTvboxClasses(d.class)
  const list = Array.isArray(d.list) ? d.list : []
  if (cls.length) spiderClassCache.set(sp.id, { cls, ts: Date.now() })
  return { cls, list }
}

tvboxRouter.get("/spider", async (c) => {
  const denied = await accessDenied(c)
  if (denied) return denied

  const cfg = await readConfig(c)
  const emptyBody = { class: [] as any[], list: [] as any[], page: 1, pagecount: 1, limit: 0, total: 0 }

  // 单源模式（每源独立站点）：spider=<id>；兼容旧的聚合 spiders=<ids>
  const singleId = (c.req.query("spider") || "").trim()
  let spiders: any[]
  if (singleId) {
    const sp = cfg.spiders.find((s: any) => s.id === singleId && s.enabled !== false)
    if (!sp) return c.json({ code: 404, message: "spider not found", ...emptyBody }, 404)
    spiders = [sp]
  } else {
    const selected = (c.req.query("spiders") || "").trim()
    spiders = cfg.spiders.filter((s: any) => s.enabled)
    if (selected) {
      const set = new Set(selected.split(",").map((x) => x.trim()).filter(Boolean))
      spiders = spiders.filter((s: any) => set.has(s.id))
    }
  }
  if (!spiders.length) return c.json(emptyBody)

  const ac = c.req.query("ac") || "videolist"
  const keyword = (c.req.query("wd") || "").trim()
  const ids = c.req.query("ids") || ""
  const typeId = (c.req.query("t") || c.req.query("type") || "").trim()
  const page = pageOf(c)
  const limit = 60

  // 选集解析：GET /@tvbox/spider?code=&spider=&ac=play&id=&flag=
  // 不新建 /@tvbox/play：该路径与文件/静态路由冲突（实测被 requireCode 挡成 401
  // 或落回 HTML）。挂在 /spider 上复用已验证的鉴权与单源解析，零新增路由。
  const code = envValue(c, "TVBOX_ACCESS_CODE")
  const baseParam = (c.req.query("base") || "").trim()
  const playHref = (sid: string, id: string, flag = "") => {
    const base = requestUrl(c, "/@tvbox/spider", baseParam)
    const parts: string[] = []
    if (code) parts.push(`code=${encodeURIComponent(code)}`)
    parts.push(`spider=${encodeURIComponent(sid)}`, "ac=play", `id=${b64urlEncode(id)}`)
    if (flag) parts.push(`flag=${encodeURIComponent(flag)}`)
    return `${base}?${parts.join("&")}`
  }

  if (ac === "play") {
    const rawId = (c.req.query("id") || "").trim()
    let playId = ""
    try {
      playId = b64urlDecode(rawId)
    } catch {
      playId = ""
    }
    if (!playId) return c.json({ code: 400, message: "missing id", ...emptyBody }, 400)
    const sp = spiders[0]
    const flag = (c.req.query("flag") || "").trim()
    const res = await runSpider(sp, "play", { playId, flag, videoId: playId }, { from: "tvbox", env: c.env })
    if (!res.ok) {
      return c.json({ code: 500, message: `播放失败：${res.error}`, ...emptyBody }, 200)
    }
    const data = res.data || {}
    const first = Array.isArray(data.urls) && data.urls[0] ? data.urls[0] : {}
    // 网盘脚本返回 data.url 是 [{ name, url }]；其他脚本可能给字符串或 data.urls
    let url = ""
    if (Array.isArray(data.url) && data.url[0]) {
      url = String(data.url[0].url || data.url[0].play_url || data.url[0].playUrl || "")
    }
    if (!url) url = String(data.url || first.url || first.play_url || first.playUrl || "")
    if (!url) {
      return c.json({ code: 502, message: data.error || "empty play url", ...emptyBody }, 200)
    }
    const header = data.header || first.header || {}
    // SUTV 3.0.57+ 带 Accept: application/json —— 回 JSON，header 才能交给播放器
    // （302 带不出 header，CDN 校验 Referer 时会失败）。其他客户端维持 302。
    if ((c.req.header("accept") || "").toLowerCase().includes("application/json")) {
      return c.json({ code: 200, url, header })
    }
    return c.redirect(url, 302)
  }

  // 详情：只取元数据 + 选集结构，不在详情阶段解析播放地址
  // （详情阶段调 play() 会丢线路、变慢，且此时不知道用户选哪条线路）
  if (ids.startsWith("spider:")) {
    try {
      const parts = ids.split(":")
      const sid = parts[1] || ""
      let videoId = ""
      try {
        videoId = b64urlDecode(parts[2] || "")
      } catch {
        videoId = ""
      }
      if (!videoId) return c.json({ code: 400, message: "bad id", ...emptyBody }, 400)
      // 不限定「本次选中的源」：配置重建 / 源禁用后旧 vod_id 仍会进来
      const sp = cfg.spiders.find((s: any) => s.id === sid && s.enabled !== false)
      if (!sp) return c.json({ code: 404, message: `spider not found: ${sid}`, ...emptyBody }, 404)
      // P0-3：videoId 是主流入参名，playId/id 兜底
      const detailRes = await runSpider(
        sp,
        "detail",
        { videoId, playId: videoId, id: videoId },
        { from: "tvbox", env: c.env },
      )
      if (!detailRes.ok) {
        return c.json({ code: 500, message: `详情失败：${detailRes.error}`, ...emptyBody }, 200)
      }
      const base = detailRes.data?.list?.[0] || detailRes.data || {}
      const vod = fromSpiderVod({ ...base, vod_id: videoId }, sp.id, sp.name, playHref)
      return c.json({ class: [], list: [vod], page: 1, pagecount: 1, limit: 1, total: 1 })
    } catch (e: any) {
      return c.json({ code: 500, message: safeErrorMessage(e), ...emptyBody }, 500)
    }
  }

  // 分类：来自各源 home()（单源时即该源自己的分类），并收集失败原因
  let classes: any[] = []
  const errors: string[] = []
  const homeResults: { sp: any; cls: any[]; list: any[]; error?: string }[] = []
  for (const sp of spiders) {
    const home = await loadSpiderHome(c, sp)
    classes = classes.concat(home.cls)
    homeResults.push({ sp, ...home })
    if (home.error) errors.push(`${sp.name || sp.id}: ${home.error}`)
  }

  // 只请求分类列表（SUTV/TVBox 首屏 ac=list）
  if (ac === "list" && !keyword && !typeId) {
    if (spiders.length === 1) {
      const first = homeResults[0]
      const list = first.list.map((v: any) => fromSpiderVod(v, first.sp.id, first.sp.name, playHref))
      if (!list.length && first.error) {
        // 业务错误写进 body（HTTP 保持 200，避免标准 TVBox 报「网络错误」）
        return c.json(
          {
            code: 500,
            message: `爬虫取数失败：${first.error}`,
            class: classes,
            list: [],
            page: 1,
            pagecount: 1,
            limit,
            total: 0,
          },
          200,
        )
      }
      return c.json({ class: classes, list: list.slice(0, limit), page: 1, pagecount: 1, limit, total: list.length })
    }
    return c.json({ code: errors.length ? 500 : 200, message: errors.join("；"), ...emptyBody, class: classes })
  }

  const rows: any[] = []
  try {
    for (const sp of spiders) {
      let method = "home"
      let params: any = { page }
      if (keyword) {
        method = "search"
        params = { keyword, page }
      } else if (typeId && (spiders.length === 1 || typeId !== sp.id)) {
        // 单源：t= 就是该源的内部 categoryId
        method = "category"
        params = { categoryId: typeId, page }
      }
      const res = await runSpider(sp, method, params, { from: "tvbox", env: c.env })
      if (!res.ok) {
        console.warn(`[tvbox] spider ${sp.id}.${method} failed: ${res.error}`)
        errors.push(`${sp.name || sp.id}: ${res.error}`)
        continue
      }
      const list = Array.isArray(res.data?.list) ? res.data.list : []
      if (!classes.length) {
        const extra = toTvboxClasses(res.data?.class)
        if (extra.length) classes = extra
      }
      for (const v of list) rows.push(fromSpiderVod(v, sp.id, sp.name, playHref))
    }

    if (!rows.length && errors.length) {
      return c.json(
        {
          code: 500,
          message: `爬虫取数失败：${errors.slice(0, 3).join("；")}`,
          class: classes,
          list: [],
          page,
          pagecount: 1,
          limit,
          total: 0,
        },
        200,
      )
    }

    // 注意：spider 的 category/search 已按 page 分页，不能再二次切片，否则第 2 页为空。
    const pagecount = rows.length >= limit ? page + 1 : page
    return c.json({
      class: classes,
      list: rows,
      page,
      pagecount,
      limit,
      total: rows.length,
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), class: classes, list: [] }, 500)
  }
})

/**
 * 调试端点：/＠tvbox/debug?spider=<id>&method=home
 * 直接跑一次脚本并返回 ok / error / keys / sample，便于定位源问题。
 */
tvboxRouter.get("/debug", async (c) => {
  const denied = await accessDenied(c)
  if (denied) return denied
  const cfg = await readConfig(c)
  const id = (c.req.query("spider") || "").trim()
  const method = (c.req.query("method") || "home").trim()
  const sp = cfg.spiders.find((s: any) => s.id === id)
  if (!sp) return c.json({ code: 404, message: "spider not found" }, 404)
  const started = Date.now()
  const r = await runSpider(sp, method, { page: 1, categoryId: c.req.query("t") || "", keyword: c.req.query("wd") || "" }, { from: "tvbox", env: c.env })
  return c.json({
    code: 200,
    spider: sp.id,
    name: sp.name,
    method,
    ok: r.ok,
    error: r.error || "",
    ms: Date.now() - started,
    keys: r.data && typeof r.data === "object" ? Object.keys(r.data) : [],
    sample: JSON.stringify(r.data || null).slice(0, 1200),
  })
})

tvboxRouter.get("/api", async (c) => {
  const denied = await accessDenied(c)
  if (denied) return denied

  const allSources = await readSources(c)
  const selected = c.req.query("sources")
  let sources = allSources
  if (selected) {
    const ids = new Set(selected.split(",").map((s) => s.trim()).filter(Boolean))
    sources = allSources.filter((s) => ids.has(s.id))
  }
  if (!sources.length) {
    return c.json(
      {
        code: 503,
        message: allSources.length
          ? "No source selected"
          : "TVBOX_SOURCES is not configured",
        class: [],
        list: [],
        page: 1,
        pagecount: 1,
        limit: 0,
        total: 0,
      },
      503,
    )
  }

  // TVBox 客户端不会携带 OpenList 登录态，而 OpenList 默认禁用 guest。
  // 访问码已在上方校验通过，这里使用受限只读上下文；路径仍只能来自
  // 服务端 sourceId 白名单，客户端无法提交任意路径，因此不会扩大权限。
  const authUser = await getUserFromContext(c)
  const user = authUser && !authUser.disabled
    ? authUser
    : { role: 1, permission: 0, base_path: "/", disabled: false }

  const classes = sources.map((s) => ({ type_id: s.id, type_name: s.name }))
  const ac = c.req.query("ac") || "videolist"
  const keyword = (c.req.query("wd") || "").trim()
  const ids = c.req.query("ids") || ""
  const page = pageOf(c)
  const limit = 60

  try {
    if (ac === "list") {
      return c.json({ class: classes, list: [], page: 1, pagecount: 1, limit: 0, total: 0 })
    }

    if (ids) {
      const parsed = await parseVodId(c, ids)
      const source = parsed && sources.find((s) => s.id === parsed.sourceId)
      if (!parsed || !source) {
        return c.json({ code: 403, message: "invalid vod_id", list: [] }, 403)
      }
      const row = await detail(c, source, parsed.relativePath, user)
      if (!row) return c.json({ code: 404, message: "not found", list: [] }, 404)
      return c.json({
        class: classes,
        list: [row],
        page: 1,
        pagecount: 1,
        limit,
        total: 1,
      })
    }

    let rows: any[]
    if (ac === "search" || keyword) {
      rows = await searchSources(c, sources, user, keyword)
    } else {
      const typeId = c.req.query("t") || c.req.query("type") || sources[0].id
      const source = sources.find((s) => s.id === typeId)
      if (!source) {
        return c.json({ code: 404, message: "unknown source", class: classes, list: [] }, 404)
      }
      rows = await listSource(c, source, user)
    }

    const total = rows.length
    const pagecount = Math.max(1, Math.ceil(total / limit))
    return c.json({
      class: classes,
      list: rows.slice((page - 1) * limit, page * limit),
      page,
      pagecount,
      limit,
      total,
    })
  } catch (e: any) {
    return c.json(
      { code: 500, message: safeErrorMessage(e), class: classes, list: [] },
      500,
    )
  }
})

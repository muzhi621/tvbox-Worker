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
  type TvboxSource,
} from "./tvbox-store"
import { runSpider } from "./spider-runner"

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

const VIDEO_EXT = new Set([
  "mp4", "mkv", "avi", "mov", "wmv", "flv", "m4v", "ts", "rmvb", "rm",
  "3gp", "webm", "m2ts", "vob", "mpg", "mpeg", "strm", "iso", "blu",
])
const SUB_EXT = new Set(["srt", "ass", "ssa", "vtt", "sub"])

type SpiderRef = { id: string; name: string; code: string }

/** OmniBox 脚本返回的视频对象 → MACCMS 字段 */
function fromSpiderVod(v: any, spiderId: string, spiderName: string): any {
  const playId = String(v?.vod_id ?? v?.id ?? v?.playId ?? "")
  const playUrl = v?.vod_play_url || v?.url || ""
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
    vod_play_from: String(v?.vod_play_from || "OmniBox"),
    vod_play_url: typeof playUrl === "string" ? playUrl : "",
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
  const origin = new URL(c.req.url).origin
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`
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

  const cfg = await readConfig(c)
  const sites: any[] = []

  const apiUrl = absoluteUrl(c, "/@tvbox/api")
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
      type: 3,
      api: netdiskParams.length ? `${apiUrl}?${netdiskParams.join("&")}` : apiUrl,
      searchable: 1,
      filterable: 0,
      changeable: 0,
    })
  }

  const hasSpider = spiderIds.length
    ? cfg.spiders.some((s) => s.enabled && spiderIds.includes(s.id))
    : cfg.spiders.some((s) => s.enabled)
  if (hasSpider) {
    const spiderParams: string[] = []
    if (code) spiderParams.push(`code=${encodeURIComponent(code)}`)
    if (spiderIds.length) spiderParams.push(`spiders=${encodeURIComponent(spiderIds.join(","))}`)
    const spiderApi = absoluteUrl(c, "/@tvbox/spider")
    sites.push({
      key: "omnibox_spider",
      name: "OmniBox 爬虫源",
      type: 3,
      api: spiderParams.length ? `${spiderApi}?${spiderParams.join("&")}` : spiderApi,
      searchable: 1,
      filterable: 0,
      changeable: 0,
    })
  }

  // 兼容旧版 sources 参数（无 sel 时）
  if (!selRaw && requested) {
    const expected = await hmac(c, requested)
    if (expected && constantTimeEqual(sig, expected)) {
      const ids = requested.split(",").map((s) => s.trim()).filter(Boolean)
      const selected = ids.filter((id) => cfg.netdisk.some((s) => s.id === id)).join(",")
      if (selected) {
        const params = netdiskParams.filter((p) => !p.startsWith("sources="))
        params.push(`sources=${encodeURIComponent(selected)}`)
        sites.length = 0
        sites.push({
          key: "openlist",
          name: "OpenList 网盘",
          type: 3,
          api: `${apiUrl}?${params.join("&")}`,
          searchable: 1,
          filterable: 0,
          changeable: 0,
        })
      }
    }
  }

  if (!sites.length) {
    sites.push({
      key: "omnibox_netdisk",
      name: "OmniBox 网盘",
      type: 3,
      api: netdiskParams.length ? `${apiUrl}?${netdiskParams.join("&")}` : apiUrl,
      searchable: 1,
      filterable: 0,
      changeable: 0,
    })
  }

  return c.json({ spider: "", sites, rules: {} })
})

tvboxRouter.get("/spider", async (c) => {
  const denied = await accessDenied(c)
  if (denied) return denied

  const cfg = await readConfig(c)
  const selected = c.req.query("spiders")
  let spiders = cfg.spiders.filter((s) => s.enabled)
  if (selected) {
    const ids = new Set(selected.split(",").map((s) => s.trim()).filter(Boolean))
    spiders = spiders.filter((s) => ids.has(s.id))
  }
  const classes = spiders.map((s) => ({ type_id: s.id, type_name: s.name }))

  const ac = c.req.query("ac") || "videolist"
  const keyword = (c.req.query("wd") || "").trim()
  const ids = c.req.query("ids") || ""
  const typeId = c.req.query("t") || c.req.query("type") || spiders[0]?.id
  const page = pageOf(c)
  const limit = 60

  if (ac === "list") {
    return c.json({ class: classes, list: [], page: 1, pagecount: 1, limit: 0, total: 0 })
  }

  try {
    let rows: any[] = []
    if (ids.startsWith("spider:")) {
      const parts = ids.split(":")
      const sid = parts[1] || ""
      const playId = b64urlDecode(parts[2] || "")
      const sp = spiders.find((s) => s.id === sid)
      if (!sp) return c.json({ code: 404, message: "spider not found", list: [] }, 404)
      const detailRes = await runSpider(sp, "detail", { playId, id: playId }, { from: "detail", env: c.env })
      const playRes = await runSpider(sp, "play", { playId }, { from: "play", env: c.env })
      const base = detailRes.data?.list?.[0] || detailRes.data || {}
      const playData = playRes.data || {}
      const urls = Array.isArray(playData.urls) ? playData.urls : []
      const playText = urls
        .map((u: any) => `${u.name || "线路"}$${u.url || u.play_url || ""}`)
        .join("#")
      rows.push(
        fromSpiderVod(
          {
            ...base,
            vod_id: playId,
            vod_play_from: playData.parse ? "OmniBox解析" : "OmniBox",
            vod_play_url: playText,
          },
          sp.id,
          sp.name,
        ),
      )
    } else {
      const targets = keyword || ac === "search"
        ? spiders
        : spiders.filter((s) => s.id === typeId)
      for (const sp of targets) {
        const method = keyword || ac === "search" ? "search" : typeId === sp.id && ac !== "videolist" ? "category" : "home"
        const params =
          method === "search"
            ? { keyword, page }
            : method === "category"
              ? { categoryId: c.req.query("categoryId") || c.req.query("pg") || "1", page }
              : { page }
        const res = await runSpider(sp, method, params, { from: method, env: c.env })
        if (!res.ok) {
          console.warn(`[tvbox] spider ${sp.id}.${method} failed: ${res.error}`)
          continue
        }
        const list = Array.isArray(res.data?.list) ? res.data.list : []
        for (const v of list) rows.push(fromSpiderVod(v, sp.id, sp.name))
      }
    }

    const total = rows.length
    return c.json({
      class: classes,
      list: rows.slice((page - 1) * limit, page * limit),
      page,
      pagecount: Math.max(1, Math.ceil(total / limit)),
      limit,
      total,
    })
  } catch (e: any) {
    return c.json({ code: 500, message: safeErrorMessage(e), class: classes, list: [] }, 500)
  }
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

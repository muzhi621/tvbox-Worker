import { Hono } from "hono"
import { getDb } from "../internal/model/db"
import {
  getMediaDb,
  queryItems,
  getSettingsMap,
} from "../internal/media/store"
import { scrapeMedia } from "../internal/media/scrape"
import { scanMedia, getScanProgress, isScanRunning } from "../internal/media/scan"
import { readMounts } from "./tvbox-admin"
import { runSpider } from "./spider-runner"
import {
  accessDenied,
  envValue,
  hmac,
  readConfig,
  saveConfig,
  type TvboxSource,
  type SpiderSource,
} from "./omnibox-store"

/**
 * OmniBox 风格统一入口。
 *  - 媒体库：复用 OpenList 的 internal/media（扫描 + TMDB 刮削 + 海报）
 *  - 源管理：网盘目录 + OmniBox JS 爬虫脚本
 *  - 订阅生成：把两类源编码成带签名的 TVBox 订阅地址
 */

export const omniboxRouter = new Hono()

omniboxRouter.use("*", async (c, next) => {
  const denied = accessDenied(c, true)
  if (denied) return denied
  await next()
})

function absoluteUrl(c: any, path: string): string {
  const origin = new URL(c.req.url).origin
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`
}

// ---------- 概览 ----------

omniboxRouter.get("/status", async (c) => {
  const cfg = await readConfig(c)
  const mounts = await readMounts(c)
  let mediaTotal = 0
  let mediaScraped = 0
  try {
    const mdb = await getMediaDb(c.env)
    mediaTotal = mdb.items.length
    mediaScraped = mdb.items.filter((i: any) => !!i.scraped_at).length
  } catch {}
  return c.json({
    code: 200,
    data: {
      netdiskCount: cfg.netdisk.length,
      spiderCount: cfg.spiders.filter((s) => s.enabled).length,
      mountCount: mounts.length,
      mediaTotal,
      mediaScraped,
    },
  })
})

// ---------- 网盘挂载 ----------

omniboxRouter.get("/mounts", async (c) => {
  return c.json({ code: 200, data: await readMounts(c) })
})

// ---------- 媒体库 ----------

omniboxRouter.get("/media", async (c) => {
  const keyword = (c.req.query("keyword") || "").trim()
  const type = (c.req.query("type") || "video").trim()
  const page = Math.max(1, Number(c.req.query("page") || 1) || 1)
  try {
    const db = await getMediaDb(c.env)
    const result = queryItems(db, {
      media_type: type as any,
      keyword: keyword || undefined,
      hidden: false,
      order_by: "updated",
      order_dir: "desc",
      page,
      page_size: 60,
    })
    return c.json({
      code: 200,
      data: {
        list: result.content.map((i: any) => ({
          id: i.id,
          name: i.scraped_name || i.file_name,
          cover: i.cover || i.thumb || "",
          year: i.release_date || "",
          rating: i.rating || 0,
          genre: i.genre || "",
          plot: i.plot || i.description || "",
          path: `${i.folder_path}/${i.file_name}`,
          scraped: !!i.scraped_at,
          media_type: i.media_type,
        })),
        total: result.total,
        page,
      },
    })
  } catch (e: any) {
    return c.json({ code: 500, message: e?.message || "media unavailable" }, 500)
  }
})

omniboxRouter.get("/media/scan-paths", async (c) => {
  const db = await getMediaDb(c.env)
  return c.json({ code: 200, data: db.scan_paths || [] })
})

omniboxRouter.post("/media/scan-paths", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const path = String(body.path || "").trim()
  const mediaType = String(body.media_type || "video")
  if (!path.startsWith("/") || path.includes("..")) {
    return c.json({ code: 400, message: "invalid path" }, 400)
  }
  if (!["video", "music", "image", "book"].includes(mediaType)) {
    return c.json({ code: 400, message: "invalid media_type" }, 400)
  }
  const db = await getMediaDb(c.env)
  if (!Array.isArray(db.scan_paths)) db.scan_paths = []
  if (db.scan_paths.some((p: any) => p.path === path && p.media_type === mediaType)) {
    return c.json({ code: 409, message: "scan path already exists" }, 409)
  }
  const id = db.scan_paths.reduce((m: number, p: any) => Math.max(m, Number(p.id) || 0), 0) + 1
  db.scan_paths.push({
    id,
    path,
    media_type: mediaType,
    enabled: true,
    type_tag: "",
    content_tags: "",
  } as any)
  const { saveMediaDb } = await import("../internal/media/store")
  await saveMediaDb(c.env, db)
  return c.json({ code: 200, data: { id } })
})

omniboxRouter.post("/media/scan", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const type = String(body.media_type || "video") as any
  const id = Number(body.scan_path_id || 0)
  if (isScanRunning(type)) return c.json({ code: 409, message: "scan already running" }, 409)
  const task = scanMedia(c.env, type, id).catch((e) =>
    console.error("[omnibox] scan failed:", e?.message || e),
  )
  try {
    c.executionCtx?.waitUntil?.(task)
  } catch {}
  return c.json({ code: 200, message: "scan started" })
})

omniboxRouter.get("/media/scan/progress", async (c) => {
  const type = String(c.req.query("type") || "video") as any
  return c.json({ code: 200, data: getScanProgress(type) })
})

omniboxRouter.post("/media/scrape", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const type = String(body.media_type || "video") as any
  const itemId = Number(body.item_id || 0)
  const settings = await getSettingsMap(c.env)
  const task = scrapeMedia(c.env, settings, type, itemId).catch((e) =>
    console.error("[omnibox] scrape failed:", e?.message || e),
  )
  try {
    c.executionCtx?.waitUntil?.(task)
  } catch {}
  return c.json({ code: 200, message: "scrape started" })
})

omniboxRouter.post("/media/tmdb-key", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const key = String(body.key || "").trim()
  const db = await getDb(c.env)
  if (!Array.isArray(db.settings)) db.settings = []
  const row = db.settings.find((s: any) => s?.key === "media_tmdb_key")
  if (row) row.value = key
  else db.settings.push({ key: "media_tmdb_key", value: key, type: "string", group: 8, flag: 0 })
  const { saveDb } = await import("../internal/model/db")
  await saveDb(db, c.env)
  return c.json({ code: 200, message: key ? "TMDB key saved" : "TMDB key cleared" })
})

// ---------- 源管理 ----------

omniboxRouter.get("/sources", async (c) => {
  const cfg = await readConfig(c)
  return c.json({ code: 200, data: cfg })
})

omniboxRouter.post("/sources/netdisk", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const cfg = await readConfig(c)
  const input = Array.isArray(body.sources) ? body.sources : []
  const seen = new Set<string>()
  const list: TvboxSource[] = []
  for (const s of input) {
    if (!s || typeof s !== "object") continue
    const id = String(s.id || "").trim()
    const path = String(s.path || "").trim()
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || seen.has(id) || !path.startsWith("/")) continue
    if (path.includes("..")) continue
    seen.add(id)
    list.push({
      id,
      name: String(s.name || id).slice(0, 80),
      path,
      password: s.password ? String(s.password).slice(0, 200) : "",
    })
  }
  cfg.netdisk = list
  await saveConfig(c, cfg)
  return c.json({ code: 200, data: cfg })
})

omniboxRouter.post("/sources/spiders", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const cfg = await readConfig(c)
  const input = Array.isArray(body.spiders) ? body.spiders : []
  const list: SpiderSource[] = []
  const seen = new Set<string>()
  for (const s of input) {
    if (!s || typeof s !== "object") continue
    const id = String(s.id || "").trim()
    const code = String(s.code || "")
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || seen.has(id) || !code.trim()) continue
    seen.add(id)
    list.push({
      id,
      name: String(s.name || id).slice(0, 80),
      code,
      doc: s.doc ? String(s.doc).slice(0, 4000) : "",
      enabled: s.enabled !== false,
    })
  }
  cfg.spiders = list
  await saveConfig(c, cfg)
  return c.json({ code: 200, data: { spiders: list.map((s) => ({ ...s, code: undefined })) } })
})

// ---------- 爬虫调试 ----------

omniboxRouter.post("/spider/test", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const method = String(body.method || "home")
  const code = String(body.code || "")
  const params = body.params && typeof body.params === "object" ? body.params : {}
  if (!code.trim()) return c.json({ code: 400, message: "missing code" }, 400)
  const result = await runSpider(
    { id: "test", name: "test", code },
    method,
    params,
    { from: method },
  )
  return c.json({ code: result.ok ? 200 : 500, data: result })
})

omniboxRouter.post("/spider/call", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const id = String(body.id || "")
  const method = String(body.method || "home")
  const params = body.params && typeof body.params === "object" ? body.params : {}
  const cfg = await readConfig(c)
  const source = cfg.spiders.find((s) => s.id === id && s.enabled)
  if (!source) return c.json({ code: 404, message: "spider not found" }, 404)
  const result = await runSpider(source, method, params, { from: method })
  if (!result.ok) return c.json({ code: 500, message: result.error }, 500)
  return c.json({ code: 200, data: result.data, ms: result.ms })
})

// ---------- 订阅生成 ----------

omniboxRouter.post("/subscribe", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const netdisk: string[] = Array.isArray(body.netdisk) ? body.netdisk.map(String) : []
  const spiders: string[] = Array.isArray(body.spiders) ? body.spiders.map(String) : []
  const cfg = await readConfig(c)
  const validNetdisk = netdisk.filter((id) => cfg.netdisk.some((s) => s.id === id))
  const validSpiders = spiders.filter((id) => cfg.spiders.some((s) => s.id === id && s.enabled))
  const payload = JSON.stringify({ n: validNetdisk, s: validSpiders })
  const sig = await hmac(c, payload)
  const code = envValue(c, "TVBOX_ACCESS_CODE")
  const params: string[] = []
  if (code) params.push(`code=${encodeURIComponent(code)}`)
  params.push(`sel=${encodeURIComponent(payload)}`)
  params.push(`sig=${encodeURIComponent(sig)}`)
  const url = `${absoluteUrl(c, "/@tvbox/config.json")}?${params.join("&")}`
  return c.json({
    code: 200,
    data: { url, netdisk: validNetdisk.length, spiders: validSpiders.length },
  })
})

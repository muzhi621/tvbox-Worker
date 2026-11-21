import { Hono } from "hono"
import { getDb, saveDb } from "../internal/model/db"
import { getDriver } from "../internal/op/storage"
import {
  driverConfigs,
  ensureStorageAdditionDeviceId,
  normalizeDriver,
} from "./admin"
import {
  getMediaDb,
  queryItems,
  getSettingsMap,
} from "../internal/media/store"
import { scrapeMedia } from "../internal/media/scrape"
import { scanMedia, getScanProgress, isScanRunning } from "../internal/media/scan"
import { readMounts } from "./tvbox-admin"
import { runSpider } from "./spider-runner"
import { registerSpiderLibraryRoutes } from "./spider-library"
import { registerOmniBoxDataRoutes } from "./omnibox-extra"
import {
  accessDenied,
  envValue,
  hmac,
  readConfig,
  saveConfig,
  type TvboxSource,
  type SpiderSource,
} from "./omnibox-store"
import { requestUrl } from "./request-origin"

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

// 默认 Spider 库、通用管理数据（解析资源/任务/订阅/插件）
registerSpiderLibraryRoutes(omniboxRouter)
registerOmniBoxDataRoutes(omniboxRouter)

function absoluteUrl(c: any, path: string, explicitBaseUrl = ""): string {
  // 优先使用前端传入的当前站点域名，避免 EdgeOne 内部域名泄漏到订阅链接
  return requestUrl(c, path, explicitBaseUrl)
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

/**
 * 驱动表单元数据：让 OmniBox 单页直接完成「添加网盘登录」，
 * 不必跳到 OpenList 后台。只暴露字段名/类型/选项/默认值，
 * 不返回任何已保存的凭据（addition 永不回传浏览器）。
 */
omniboxRouter.get("/driver-configs", async (c) => {
  const list = Object.entries(driverConfigs).map(([name, cfg]: any) => ({
    name,
    label: String(cfg?.name || name),
    default_mount_path: String(cfg?.default_mount_path || ""),
    fields: (Array.isArray(cfg?.additional) ? cfg.additional : [])
      .filter((f: any) => f && f.name)
      .map((f: any) => ({
        name: String(f.name),
        type: String(f.type || "string"),
        options: f.options
          ? String(f.options)
              .split(",")
              .map((x: string) => x.trim())
              .filter(Boolean)
          : [],
        default: f.default === undefined ? "" : f.default,
        required: !!f.required,
        help: f.help === true || f.help === "true",
      })),
  }))
  return c.json({ code: 200, data: list })
})

/**
 * 在同页新增 OpenList 存储。逻辑对齐 /api/admin/storage/create，
 * 但鉴权由 /@omnibox 的访问码承担，用户无需再登录 OpenList 后台。
 * 注意：返回数据绝不包含 addition（网盘 token / 密码）。
 */
omniboxRouter.post("/mounts/add", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const driver = normalizeDriver(String(body.driver || "").trim())
  if (!driverConfigs[driver]) {
    return c.json({ code: 400, message: "不支持的网盘驱动" }, 400)
  }

  let rawMount = String(body.mount_path || "").trim()
  if (!rawMount) rawMount = String(driverConfigs[driver].default_mount_path || "")
  const mountPath = "/" + rawMount.split("/").filter(Boolean).join("/")
  if (mountPath === "/" || mountPath.includes("..")) {
    return c.json({ code: 400, message: "挂载路径无效，请填写子目录（如 /alist）" }, 400)
  }
  const normalizedPath = (p: string) =>
    "/" + String(p || "").split("/").filter(Boolean).join("/")
  const db = await getDb(c.env)
  if (
    (db.storages || []).some(
      (s: any) => !s.disabled && normalizedPath(s.mount_path) === mountPath,
    )
  ) {
    return c.json({ code: 409, message: `挂载路径已存在：${mountPath}` }, 409)
  }

  const addition: Record<string, string> = {}
  for (const f of driverConfigs[driver].additional || []) {
    if (f && f.name && f.default !== undefined) {
      addition[String(f.name)] = String(f.default)
    }
  }
  const supplied = body.addition && typeof body.addition === "object" ? body.addition : {}
  for (const [k, v] of Object.entries(supplied)) {
    if (typeof k === "string" && k.length <= 128 && typeof v === "string" && v.length <= 4096) {
      addition[k] = v
    }
  }
  const missing = (driverConfigs[driver].additional || [])
    .filter((f: any) => f && f.required && !String(addition[String(f.name)] || "").trim())
    .map((f: any) => String(f.name))
  if (missing.length) {
    return c.json({ code: 400, message: `请填写：${missing.join("、")}` }, 400)
  }

  const newStorage: any = {
    driver,
    mount_path: mountPath,
    remark: String(body.remark || "").slice(0, 200),
    addition: ensureStorageAdditionDeviceId(driver, addition),
    status: "work",
    modified: new Date().toISOString(),
    disabled: false,
    id: (db.storages || []).length
      ? Math.max(...(db.storages || []).map((s: any) => Number(s.id) || 0)) + 1
      : 1,
  }
  ;(db.storages || (db.storages = [])).push(newStorage)
  try {
    await saveDb(db, c.env)
  } catch (e: any) {
    db.storages.pop()
    return c.json({ code: 500, message: `保存失败：${e?.message || e}` }, 500)
  }

  let connectError = ""
  try {
    await getDriver(driver, newStorage)
  } catch (e: any) {
    connectError = e?.message || String(e)
    newStorage.status = connectError
    if (connectError.includes("unsupported driver")) newStorage.disabled = true
    try {
      await saveDb(db, c.env)
    } catch {}
  }
  return c.json(
    {
      code: connectError ? 500 : 200,
      message: connectError || "success",
      data: {
        id: newStorage.id,
        driver,
        mount_path: mountPath,
        remark: newStorage.remark,
        status: newStorage.status,
      },
    },
    connectError ? 500 : 200,
  )
})

omniboxRouter.post("/mounts/delete", async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const id = Number(body.id || 0)
  if (!id) return c.json({ code: 400, message: "missing id" }, 400)
  const db = await getDb(c.env)
  const before = (db.storages || []).length
  db.storages = (db.storages || []).filter((s: any) => Number(s.id) !== id)
  if ((db.storages || []).length === before) {
    return c.json({ code: 404, message: "storage not found" }, 404)
  }
  await saveDb(db, c.env)
  return c.json({ code: 200, message: "deleted" })
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
      type: s.type === "Python" ? "Python" : "JavaScript",
      category: s.category ? String(s.category).slice(0, 40) : "",
      priority: Number.isFinite(Number(s.priority)) ? Number(s.priority) : 50,
      tags: Array.isArray(s.tags) ? s.tags.map((t: any) => String(t).slice(0, 24)).slice(0, 6) : [],
      version: s.version ? String(s.version).slice(0, 40) : "",
      author: s.author ? String(s.author).slice(0, 60) : "",
      sourceRepo: s.sourceRepo ? String(s.sourceRepo).slice(0, 120) : "",
      path: s.path ? String(s.path).slice(0, 240) : "",
      updatedAt: s.updatedAt || new Date().toISOString(),
      nav: !!s.nav,
      push: !!s.push,
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
    { from: method, env: c.env },
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
  const result = await runSpider(source, method, params, { from: method, env: c.env })
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
  const token = String(body.token || "").trim()
  const params: string[] = []
  // 每条订阅可用自己的访问令牌；未指定令牌时兼容旧链接（直接使用访问码）
  if (token) params.push(`token=${encodeURIComponent(token)}`)
  else if (code) params.push(`code=${encodeURIComponent(code)}`)
  params.push(`sel=${encodeURIComponent(payload)}`)
  params.push(`sig=${encodeURIComponent(sig)}`)
  const url = `${absoluteUrl(c, "/@tvbox/config.json", String(body.baseUrl || ""))}?${params.join("&")}`
  return c.json({
    code: 200,
    data: { url, netdisk: validNetdisk.length, spiders: validSpiders.length },
  })
})

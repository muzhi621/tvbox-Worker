import { getDb, saveDb } from "../internal/model/db"

/**
 * OmniBox 源配置存储。
 *
 * 两类源共用 settings 表的一个 key，不扩展 db schema：
 *  - netdisk: 由网盘挂载点映射而来（复用 OpenList 驱动层）
 *  - spider:  OmniBox JS 爬虫脚本（沙箱执行）
 *
 * 布局：{ netdisk: TvboxSource[], spiders: SpiderSource[] }
 */

export type TvboxSource = {
  id: string
  name: string
  path: string
  password?: string
}

export type SpiderSource = {
  id: string
  name: string
  code: string
  doc?: string
  enabled: boolean
}

export type OmniBoxConfig = {
  netdisk: TvboxSource[]
  spiders: SpiderSource[]
}

const SETTINGS_KEY = "omnibox_sources"

export function envValue(c: any, key: string): string {
  const fromEnv = c?.env?.[key]
  if (fromEnv !== undefined && fromEnv !== null) return String(fromEnv)
  if (typeof process !== "undefined" && process.env?.[key]) {
    return String(process.env[key])
  }
  return ""
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function hmac(c: any, payload: string): Promise<string> {
  const secret = envValue(c, "JWT_SECRET")
  if (!secret) return ""
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24)
}

export function accessDenied(c: any, requireCode = false): Response | null {
  const expected = envValue(c, "TVBOX_ACCESS_CODE")
  if (!expected) {
    return requireCode
      ? c.json(
          { code: 503, message: "TVBOX_ACCESS_CODE is required for management", list: [] },
          503,
        )
      : null
  }
  const provided = c.req.query("code") || c.req.header("X-TVBox-Code") || ""
  return constantTimeEqual(String(provided), expected)
    ? null
    : c.json({ code: 401, message: "invalid access code", list: [] }, 401)
}

function normalizeNetdisk(input: any): TvboxSource[] {
  if (!Array.isArray(input)) return []
  const out: TvboxSource[] = []
  const seen = new Set<string>()
  for (const s of input) {
    if (!s || typeof s !== "object") continue
    const id = String(s.id || "").trim()
    const path = String(s.path || "").trim()
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || seen.has(id) || !path) continue
    if (!path.startsWith("/") || path.includes("..") || path.includes("\0")) continue
    seen.add(id)
    out.push({
      id,
      name: String(s.name || id).slice(0, 80),
      path,
      password: s.password ? String(s.password).slice(0, 200) : "",
    })
    if (out.length >= 100) break
  }
  return out
}

function normalizeSpiders(input: any): SpiderSource[] {
  if (!Array.isArray(input)) return []
  const out: SpiderSource[] = []
  const seen = new Set<string>()
  for (const s of input) {
    if (!s || typeof s !== "object") continue
    const id = String(s.id || "").trim()
    const code = typeof s.code === "string" ? s.code : ""
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || seen.has(id) || !code.trim()) continue
    seen.add(id)
    out.push({
      id,
      name: String(s.name || id).slice(0, 80),
      code,
      doc: s.doc ? String(s.doc).slice(0, 4000) : "",
      enabled: s.enabled !== false,
    })
    if (out.length >= 100) break
  }
  return out
}

export function emptyConfig(): OmniBoxConfig {
  return { netdisk: [], spiders: [] }
}

export async function readConfig(c: any): Promise<OmniBoxConfig> {
  try {
    const db = await getDb(c.env)
    const row = (db.settings || []).find((s: any) => s && s.key === SETTINGS_KEY)
    if (row && typeof row.value === "string" && row.value.trim()) {
      const parsed = JSON.parse(row.value)
      const cfg = emptyConfig()
      cfg.netdisk = normalizeNetdisk(parsed?.netdisk)
      cfg.spiders = normalizeSpiders(parsed?.spiders)
      if (cfg.netdisk.length || cfg.spiders.length) return cfg
      // 兼容旧版：数组形式视为 netdisk
      const legacy = normalizeNetdisk(parsed)
      if (legacy.length) return { netdisk: legacy, spiders: [] }
    }
  } catch (e: any) {
    console.warn(`[omnibox] read config failed: ${e?.message || e}`)
  }
  // 环境变量兜底（旧部署）
  const raw = envValue(c, "TVBOX_SOURCES")
  return { netdisk: normalizeNetdisk(raw ? JSON.parse(raw) : []), spiders: [] }
}

export async function saveConfig(c: any, cfg: OmniBoxConfig): Promise<void> {
  const clean: OmniBoxConfig = {
    netdisk: normalizeNetdisk(cfg.netdisk),
    spiders: normalizeSpiders(cfg.spiders),
  }
  const db = await getDb(c.env)
  if (!Array.isArray(db.settings)) db.settings = []
  const row = db.settings.find((s: any) => s && s.key === SETTINGS_KEY)
  const value = JSON.stringify(clean)
  if (row) {
    row.value = value
    row.type = "text"
  } else {
    db.settings.push({
      key: SETTINGS_KEY,
      value,
      type: "text",
      help: "OmniBox sources (managed by /@omnibox)",
      group: 99,
      flag: 0,
    })
  }
  await saveDb(db, c.env)
}

import { getDb, saveDb } from "../internal/model/db"

/**
 * TVBox 源配置存储层。
 *
 * 源配置保存在 settings 表的一个 key 里（JSON 数组），这样做有两个好处：
 *  1. 不扩展 db schema，跟随上游合并时冲突面最小；
 *  2. 复用 OpenList 现有的 KV / Blob 持久化与加密链路。
 *
 * 环境变量 TVBOX_SOURCES 保留为兜底：数据库里没有配置时才读取它，
 * 保证已有部署方式继续可用。
 */

export type TvboxSource = {
  id: string
  name: string
  path: string
  password?: string
}

const SETTINGS_KEY = "tvbox_sources"

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

/**
 * 访问码校验。requireCode=true 时（管理 API）若未配置访问码直接拒绝，
 * 避免管理端点在未设置访问码的部署上完全暴露。
 */
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

export function normalizeSources(raw: string): TvboxSource[] {
  if (!raw || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((s: any) => s && typeof s.id === "string" && typeof s.path === "string")
      .map((s: any) => ({
        id: String(s.id),
        name: String(s.name || s.id),
        path: String(s.path).startsWith("/") ? String(s.path) : `/${s.path}`,
        password: s.password ? String(s.password) : "",
      }))
      .filter((s: TvboxSource) => s.id && !s.path.includes("..") && !s.path.includes("\0"))
  } catch {
    return []
  }
}

export async function readSources(c: any): Promise<TvboxSource[]> {
  try {
    const db = await getDb(c.env)
    const row = (db.settings || []).find((s: any) => s && s.key === SETTINGS_KEY)
    if (row && typeof row.value === "string" && row.value.trim()) {
      const stored = normalizeSources(row.value)
      if (stored.length) return stored
    }
  } catch (e: any) {
    console.warn(`[tvbox] read stored sources failed: ${e?.message || e}`)
  }
  return normalizeSources(envValue(c, "TVBOX_SOURCES"))
}

export async function saveSources(c: any, sources: TvboxSource[]): Promise<void> {
  const clean = normalizeSources(JSON.stringify(sources))
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
      help: "TVBox sources (managed by /@tvbox/admin)",
      group: 99,
      flag: 0,
    })
  }
  await saveDb(db, c.env)
}

import type { Hono } from "hono"
import { getDb, saveDb } from "../internal/model/db"
import { runSpider } from "./spider-runner"
import { readConfig } from "./omnibox-store"

/**
 * OmniBox 2.x 管理页的通用配置数据。
 *
 * 全部保存在 settings 表（JSON value），与源配置共用同一套 KV/Blob 持久化：
 *  - parse_sites   解析资源（站点名称 / 类型 / 接口地址 / 状态）
 *  - tasks         定时任务（手动/定时、JS/Python、超时、启用、并发）
 *  - subscriptions 订阅管理（名称、描述、访问令牌、已选源）
 *  - plugins       插件设置（弹幕 API、TMDB Key 等）
 */

const SECTION_KEYS: Record<string, string> = {
  parse_sites: "omnibox_parse_sites",
  tasks: "omnibox_tasks",
  subscriptions: "omnibox_subscriptions",
  plugins: "omnibox_plugins",
}

const EMPTY: Record<string, any> = {
  parse_sites: [],
  tasks: [],
  subscriptions: [],
  plugins: { danmakuApi: "", tmdbKey: "" },
}

function normalizeSection(section: string, value: any): any {
  if (section === "plugins") {
    return {
      danmakuApi: String(value?.danmakuApi || "").slice(0, 500),
      tmdbKey: String(value?.tmdbKey || "").slice(0, 300),
    }
  }
  if (!Array.isArray(value)) return EMPTY[section]
  return value
    .filter((x: any) => x && typeof x === "object")
    .slice(0, 200)
    .map((x: any) => {
      const clean: any = {}
      for (const [k, v] of Object.entries(x)) {
        if (typeof v === "string") clean[k] = String(v).slice(0, 4000)
        else if (typeof v === "number" || typeof v === "boolean") clean[k] = v
        else if (Array.isArray(v)) clean[k] = v.map((i) => String(i)).slice(0, 200)
      }
      return clean
    })
}

export async function readAppSection(c: any, section: string): Promise<any> {
  const key = SECTION_KEYS[section]
  if (!key) return EMPTY[section]
  try {
    const db = await getDb(c.env)
    const row = (db.settings || []).find((s: any) => s && s.key === key)
    if (row && typeof row.value === "string" && row.value.trim()) {
      return normalizeSection(section, JSON.parse(row.value))
    }
  } catch (e: any) {
    console.warn(`[omnibox] read ${section} failed: ${e?.message || e}`)
  }
  return EMPTY[section]
}

export function registerOmniBoxDataRoutes(router: Hono) {
  router.get("/app-data", async (c) => {
    const out: any = {}
    for (const section of Object.keys(SECTION_KEYS)) {
      out[section] = await readAppSection(c, section)
    }
    // TMDB Key 与媒体库共用既有设置，保证插件页与媒体页一致
    const plugins = out.plugins || {}
    try {
      const db = await getDb(c.env)
      const mediaRow = (db.settings || []).find((s: any) => s && s.key === "media_tmdb_key")
      if (mediaRow?.value) plugins.tmdbKey = String(mediaRow.value)
    } catch {}
    out.plugins = plugins
    return c.json({ code: 200, data: out })
  })

  router.post("/app-data", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const section = String(body.section || "")
    const key = SECTION_KEYS[section]
    if (!key) return c.json({ code: 400, message: "unknown section" }, 400)
    const value = normalizeSection(section, body.value)
    const db = await getDb(c.env)
    if (!Array.isArray(db.settings)) db.settings = []
    const row = db.settings.find((s: any) => s && s.key === key)
    const encoded = JSON.stringify(value)
    if (row) {
      row.value = encoded
      row.type = "text"
    } else {
      db.settings.push({
        key,
        value: encoded,
        type: "text",
        help: `OmniBox ${section} (managed by /@omnibox)`,
        group: 99,
        flag: 0,
      })
    }
    // 插件页保存的 TMDB Key 同步写回媒体库既有 key
    if (section === "plugins" && value.tmdbKey) {
      const mediaKey = "media_tmdb_key"
      const mediaRow = db.settings.find((s: any) => s && s.key === mediaKey)
      if (mediaRow) mediaRow.value = value.tmdbKey
      else db.settings.push({ key: mediaKey, value: value.tmdbKey, type: "string", group: 8, flag: 0 })
    }
    await saveDb(db, c.env)
    return c.json({ code: 200, data: value })
  })

  /** 手动触发定时任务：JS 任务走现有爬虫沙箱的 home()；Python 任务明确返回不支持。 */
  router.post("/tasks/run", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const id = String(body.id || "")
    const tasks = await readAppSection(c, "tasks")
    const task = (tasks || []).find((t: any) => String(t.id) === id)
    if (!task) return c.json({ code: 404, message: "task not found" }, 404)
    if (task.language === "Python" || String(task.scriptId || "").endsWith(".py")) {
      return c.json({ code: 400, message: "Python 任务需要本地运行时，Serverless 暂不支持" }, 400)
    }
    const scriptId = String(task.scriptId || "")
    if (!scriptId) {
      return c.json({ code: 200, data: { ok: true, message: "任务已登记（无关联脚本）" } })
    }
    const cfg = await readConfig(c)
    const source = cfg.spiders.find((s) => s.id === scriptId)
    if (!source) return c.json({ code: 404, message: "关联脚本不存在" }, 404)
    const result = await runSpider(
      source,
      "home",
      { ...(body.params || {}), taskName: task.name },
      { from: "task" },
      Math.min(120000, Math.max(1000, Number(task.timeout) || 300) * 1000),
    )
    return c.json(
      {
        code: result.ok ? 200 : 500,
        data: result.ok
          ? { ok: true, count: (result.data?.list || []).length, ms: result.ms }
          : { ok: false, error: result.error, ms: result.ms },
      },
      result.ok ? 200 : 500,
    )
  })
}

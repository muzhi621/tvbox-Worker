import type { Hono } from "hono"
import { SPIDER_CATALOG, SPIDER_LIBRARY, type SpiderCatalogItem } from "../data/spider-catalog"
import { readConfig, saveConfig } from "./omnibox-store"

/**
 * OmniBox-Spider 内置库。
 *
 * - 目录（名称/版本/分类/标签/优先级）在构建期生成并入库，运行时零网络依赖；
 * - 只有用户勾选同步时才按需拉取 raw.githubusercontent.com 上的脚本源码；
 * - Python 脚本保留在目录中以对齐 OmniBox 2.x 展示，但 Serverless 沙箱不执行，
 *   同步后标记为 disabled，避免订阅输出空站点。
 */

const MAX_SCRIPT_BYTES = 512 * 1024

function selectedIds(body: any): string[] {
  const raw: any[] = Array.isArray(body?.ids)
    ? body.ids
    : Array.isArray(body?.sources)
      ? body.sources
      : []
  const out: string[] = []
  for (const x of raw) {
    const id = String(x && typeof x === "object" ? x.id || "" : x)
    if (id && !out.includes(id)) out.push(id)
    if (out.length >= 100) break
  }
  return out
}

async function fetchScript(item: SpiderCatalogItem): Promise<string> {
  const res = await fetch(item.url, {
    headers: { "User-Agent": "OmniBox-Worker/2.1" },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const code = await res.text()
  if (!code.trim()) throw new Error("empty script")
  if (new TextEncoder().encode(code).length > MAX_SCRIPT_BYTES) {
    throw new Error("script too large")
  }
  if (!/module\.exports|exports\./.test(code) && !/^\s*def\s+(home|category|search)/m.test(code)) {
    throw new Error("not an OmniBox script")
  }
  return code
}

export function registerSpiderLibraryRoutes(router: Hono) {
  router.get("/spider-library", async (c) => {
    const q = (c.req.query("q") || "").trim().toLowerCase()
    const category = (c.req.query("category") || "").trim()
    const type = (c.req.query("type") || "").trim()
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") || 500) || 500))
    let items = SPIDER_CATALOG
    if (q) {
      items = items.filter((s) =>
        [s.name, s.description, s.path, s.tags.join(" "), s.author]
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    }
    if (category && category !== "全部") items = items.filter((s) => s.category === category)
    if (type && type !== "全部") items = items.filter((s) => s.type === type)
    return c.json({
      code: 200,
      data: {
        library: SPIDER_LIBRARY,
        categories: [...new Set(SPIDER_CATALOG.map((s) => s.category))],
        items: items.slice(0, limit),
        total: items.length,
      },
    })
  })

  /**
   * 选择同步：把勾选的默认库脚本写入用户自己的源配置。
   * 已存在同 id 的源会被新版覆盖（相当于“同步更新”）。
   */
  router.post("/spider-library/sync", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const ids = selectedIds(body)
    if (!ids.length) {
      return c.json({ code: 400, message: "请选择要同步的脚本" }, 400)
    }
    const byId = new Map(SPIDER_CATALOG.map((s) => [s.id, s]))
    const cfg = await readConfig(c)
    const existing = new Map(cfg.spiders.map((s) => [s.id, s]))
    const added: string[] = []
    const updated: string[] = []
    const skipped: { id: string; reason: string }[] = []

    for (const id of ids) {
      const item = byId.get(id)
      if (!item) {
        skipped.push({ id, reason: "脚本不在内置库中" })
        continue
      }
      if (!item.supported) {
        // Python 脚本保留记录但禁用，避免订阅端调用不存在的运行时
        existing.set(id, {
          ...(existing.get(id) || {}),
          id,
          name: item.name,
          code: `# ${item.name}\n# Python 脚本需要本地 Python 运行时，EdgeOne Serverless 暂不支持执行。\n# 原始地址：${item.url}\n`,
          doc: item.description,
          enabled: false,
          type: "Python",
          category: item.category,
          priority: item.priority,
          tags: item.tags,
          version: item.version,
          author: item.author,
          sourceRepo: SPIDER_LIBRARY.repo,
          path: item.path,
          updatedAt: new Date().toISOString(),
          nav: existing.get(id)?.nav || false,
          push: existing.get(id)?.push || false,
        })
        skipped.push({ id, reason: "Python 脚本已登记但禁用（Serverless 不支持）" })
        continue
      }
      try {
        const code = await fetchScript(item)
        const wasExisting = existing.has(id)
        existing.set(id, {
          ...(existing.get(id) || {}),
          id,
          name: item.name,
          code,
          doc: item.description,
          enabled: wasExisting ? existing.get(id)!.enabled !== false : true,
          type: "JavaScript",
          category: item.category,
          priority: item.priority,
          tags: item.tags,
          version: item.version,
          author: item.author,
          sourceRepo: SPIDER_LIBRARY.repo,
          path: item.path,
          updatedAt: new Date().toISOString(),
          nav: existing.get(id)?.nav || false,
          push: existing.get(id)?.push || false,
        })
        if (wasExisting) updated.push(id)
        else added.push(id)
      } catch (e: any) {
        skipped.push({ id, reason: e?.message || String(e) })
      }
    }

    cfg.spiders = [...existing.values()].sort(
      (a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0),
    )
    await saveConfig(c, cfg)
    return c.json({
      code: 200,
      data: {
        added,
        updated,
        skipped,
        total: cfg.spiders.length,
        spiders: cfg.spiders.map(({ code: _code, ...rest }) => rest),
      },
    })
  })

  /** 供“编辑/查看代码”使用：单脚本源码不走 /sources 全量接口，避免大响应体。 */
  router.get("/spider/code", async (c) => {
    const id = (c.req.query("id") || "").trim()
    const cfg = await readConfig(c)
    const sp = cfg.spiders.find((s) => s.id === id)
    if (!sp) return c.json({ code: 404, message: "spider not found" }, 404)
    return c.json({ code: 200, data: { id: sp.id, name: sp.name, code: sp.code } })
  })

  /**
   * 目录刷新：默认目录随版本入库，此处提供从 GitHub 重新读取路径清单的能力，
   * 用于在界面显示“仓库当前脚本数”，不覆盖本地目录（源码仍需选择同步）。
   */
  router.get("/spider-library/remote-count", async (c) => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${SPIDER_LIBRARY.repo}/git/trees/${SPIDER_LIBRARY.branch}?recursive=1`,
        {
          headers: { "User-Agent": "OmniBox-Worker/2.1" },
          signal: AbortSignal.timeout(15000),
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: any = await res.json()
      const count = (data?.tree || []).filter(
        (x: any) =>
          x.type === "blob" &&
          /\.(js|py)$/i.test(x.path) &&
          !/^(tests|直播|已失效待修复|模板)\//.test(x.path),
      ).length
      return c.json({ code: 200, data: { count, library: SPIDER_LIBRARY } })
    } catch (e: any) {
      return c.json(
        { code: 200, data: { count: SPIDER_LIBRARY.count, stale: true, library: SPIDER_LIBRARY } },
        200,
      )
    }
  })
}

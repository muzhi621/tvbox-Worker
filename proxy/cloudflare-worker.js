/**
 * OmniBox 上游转发代理（Cloudflare Worker，免费版即可）
 *
 * 用途：EdgeOne 免费版云函数的出口会拦截部分老网盘站域名（木偶 / 玩偶等数字域名），
 *       订阅里这些源就会「页面无数据」。把本脚本部署到 Cloudflare Workers，
 *       得到形如 https://omnibox-proxy.<你的子域>.workers.dev 的地址，
 *       再到 OmniBox 后台「插件管理 → 上游代理出口」填入：
 *
 *           https://omnibox-proxy.<你的子域>.workers.dev/fetch?url={url}
 *
 *       保存后最多 30 秒生效，爬虫脚本里失败的 request() 会自动改走这个代理。
 *
 * 部署步骤：
 *   1. 打开 https://dash.cloudflare.com → Workers & Pages → Create Worker。
 *   2. 把本文件全文粘贴进编辑器，Deploy。
 *   3. （可选）Settings → Variables 添加 PROXY_TOKEN，防止代理被他人滥用；
 *      若设置了令牌，OmniBox 后台的代理地址要写成：
 *      https://omnibox-proxy.<你的子域>.workers.dev/fetch?token=<令牌>&url={url}
 *   4. 在后台点「测试连通」，显示 HTTP 200 即配置成功。
 *
 * 接口：GET/POST /fetch?url=<encodeURIComponent(目标URL)>&timeout=<毫秒>
 *       原样转发目标站响应体、状态码与响应头；支持最多 5 次重定向。
 */

const ALLOWED_SCHEMES = new Set(["http:", "https:"])

// 阻止把代理当作内网探测跳板。Cloudflare 的 metadata 内网地址也一并拦掉。
const BLOCKED_HOST =
  /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|0\.|::1|\[::1\]|fc00:|fd[0-9a-f]{2}:|fe80:|metadata\.google\.internal|metadata\.goog|instance-data)/i

const HOP_BY_HOP = new Set([
  "host", "connection", "content-length", "transfer-encoding", "keep-alive",
  "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade",
  "accept-encoding", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
  "x-forwarded-for", "x-proxy-token",
])

function corsHeaders(request) {
  const origin = request && request.headers && request.headers.get
    ? request.headers.get("Origin") || "*"
    : "*"
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Proxy-Token",
    "Access-Control-Max-Age": "86400",
  }
}

function json(obj, status = 200, request) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      ...corsHeaders(request),
    },
  })
}

function safeTarget(raw) {
  let u
  try {
    u = new URL(String(raw || ""))
  } catch {
    return null
  }
  if (!ALLOWED_SCHEMES.has(u.protocol)) return null
  if (BLOCKED_HOST.test(u.hostname)) return null
  return u
}

function copyHeaders(request) {
  const out = new Headers()
  for (const [k, v] of request.headers.entries()) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue
    out.set(k, v)
  }
  if (!out.has("User-Agent")) out.set("User-Agent", "OmniBox-Proxy/1.0")
  return out
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) })
    }

    const incoming = new URL(request.url)
    // 可选令牌鉴权：防止公开的 workers.dev 地址被别人当免费代理用。
    const token = String(env && env.PROXY_TOKEN ? env.PROXY_TOKEN : "")
    if (token) {
      const got =
        incoming.searchParams.get("token") || request.headers.get("X-Proxy-Token") || ""
      if (got !== token) return json({ error: "unauthorized" }, 401, request)
    }

    const target = safeTarget(
      incoming.searchParams.get("url") || incoming.searchParams.get("target") || "",
    )
    if (!target) return json({ error: "missing or invalid url" }, 400, request)

    const timeoutMs = Math.min(
      30000,
      Math.max(1000, Number(incoming.searchParams.get("timeout")) || 15000),
    )
    const headers = copyHeaders(request)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    const method = request.method === "HEAD" ? "HEAD" : request.method
    const hasBody = !["GET", "HEAD"].includes(method)
    const baseInit = {
      method,
      headers,
      redirect: "manual",
      signal: controller.signal,
    }

    try {
      let res = await fetch(target.toString(), {
        ...baseInit,
        ...(hasBody ? { body: request.body } : {}),
      })

      // 木偶等站点会多次跳转；只允许跳到公网 http(s)，最多 5 次。
      let redirects = 0
      while (
        res.status >= 300 && res.status < 400 &&
        res.headers.get("location") && redirects < 5
      ) {
        const next = safeTarget(new URL(res.headers.get("location"), target).toString())
        if (!next) break
        const followMethod = res.status === 303 ? "GET" : method
        res = await fetch(next.toString(), {
          ...baseInit,
          method: followMethod,
          ...(followMethod !== "GET" && followMethod !== "HEAD" && hasBody
            ? { body: request.body }
            : {}),
        })
        redirects += 1
      }

      const out = new Headers()
      for (const [k, v] of res.headers.entries()) {
        const lk = k.toLowerCase()
        if (lk === "content-encoding" || lk === "content-length" || lk === "set-cookie") continue
        out.set(k, v)
      }
      for (const [k, v] of Object.entries(corsHeaders(request))) out.set(k, v)
      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: out,
      })
    } catch (e) {
      const reason = e && e.message ? e.message : String(e)
      return json({ error: "upstream fetch failed: " + reason }, 502, request)
    } finally {
      clearTimeout(timer)
    }
  },
}

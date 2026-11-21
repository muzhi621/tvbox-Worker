/**
 * 解析「用户实际访问的公网 origin」，用于生成 TVBox 订阅 / 播放地址。
 *
 * 背景：EdgeOne / Cloudflare 云函数内部 `c.req.url` 往往是平台内部域名
 * （如 pages-pro-xxx.pages.scf-sg-pro.qcloudteo.com，且协议为 http）。若直接
 * 用它生成订阅链接，TVBox 客户端从公网无法访问，表现为 500 / 解析失败。
 *
 * 按可靠性依次尝试：
 *  1. 环境变量 OMNIBOX_BASE_URL / TVBOX_BASE_URL（管理员显式指定，最可靠）
 *  2. 调用方显式传入的 baseUrl（管理页传浏览器 location.origin）
 *  3. X-Forwarded-Host / Host 请求头（EdgeOne 通常保留原始域名）
 *  4. new URL(c.req.url).origin（兜底）
 *
 * 协议默认 https：公网订阅链接必须是 https，只有显式 x-forwarded-proto=http
 * 时才使用 http，避免内部 http origin 泄漏到对外链接。
 */

function normalizeOrigin(raw: string): string {
  if (!raw || !raw.trim()) return ""
  let s = raw.trim().replace(/\/+$/, "")
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  try {
    const u = new URL(s)
    if (!u.hostname || u.hostname === "undefined") return ""
    return `${u.protocol}//${u.host}`
  } catch {
    return ""
  }
}

export function requestOrigin(c: any, explicitBaseUrl = ""): string {
  const envValue = (key: string): string => {
    const v = c?.env?.[key]
    return v === undefined || v === null ? "" : String(v)
  }

  // 1/2. 显式配置优先。前端传入的 location.origin 是浏览器实际访问的域名，
  //      对“生成订阅链接”最准确，因此放在环境变量之前。
  for (const candidate of [
    explicitBaseUrl,
    envValue("OMNIBOX_BASE_URL"),
    envValue("TVBOX_BASE_URL"),
  ]) {
    const origin = normalizeOrigin(candidate)
    if (origin) return origin
  }

  // 3. 请求头里的原始域名
  const forwardedHost = String(c.req.header("x-forwarded-host") || "")
    .split(",")[0]
    .trim()
  const host = forwardedHost || String(c.req.header("host") || "").trim()
  const forwardedProto = String(c.req.header("x-forwarded-proto") || "")
    .split(",")[0]
    .trim()
    .toLowerCase()
  const proto = forwardedProto === "http" ? "http" : "https"

  if (host && host.includes(".") && !/\s/.test(host)) {
    return `${proto}://${host}`
  }

  // 4. 兜底：内部 url 通常是 http，公网订阅链接统一用 https
  try {
    const u = new URL(c.req.url)
    return `${u.protocol === "http:" ? "https:" : u.protocol}//${u.host}`
  } catch {
    return ""
  }
}

/** 拼接对外绝对地址。 */
export function requestUrl(c: any, path: string, explicitBaseUrl = ""): string {
  const origin = requestOrigin(c, explicitBaseUrl) || ""
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`
}

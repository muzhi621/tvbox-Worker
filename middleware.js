// EdgeOne Makers 边缘中间件：SPA 路由回退
//
// cloud-functions/[[default]].js（构建产物，见 scripts/build-edge.mjs）是根级
// catch-all，会接管所有未命中静态文件的请求。Node 函数内没有 ASSETS 绑定，
// 需在边缘层区分「后端请求」与「前端页面导航」：
//   后端请求       → 放行到云函数（Hono 路由处理）
//   前端页面导航   → rewrite 到 /index.html，由静态 CDN 返回页面壳
//
// 后端路径必须完整列出。若遗漏（例如新增的 /@omnibox、/@tvbox），浏览器导航
// 会被错误 rewrite 到 /index.html，导致管理端点显示成 SPA 壳而非云函数响应。

// EdgeOne 约定 middleware.js 需显式导出 config 声明匹配范围。
export const config = {
  matcher: [{ source: "/:path*" }],
}

// 后端路径：这些必须直达云函数，绝不能被 rewrite 到 /index.html。
//  /api         OpenList / OmniBox 的 JSON API
//  /@tvbox      TVBox 订阅端点（config.json / api / spider / manage）
//  /@omnibox    OmniBox 管理端点（status / media / sources / subscribe ...）
//  /d /p /sd    播放直链
//  /kv-*        EdgeOne KV 代理
//  /health      健康检查
//  /@init       OpenList 初始化状态探测
//
// 注意：/@omnibox 与 /@tvbox 既是 API 又是页面入口。它们的 HTML 导航放行到
// 云函数后，由云函数 SPA 兜底返回构建期内联的 dist/index.html（OmniBox 单页），
// 比 rewrite 到静态 /index.html 更可靠（不受静态缓存影响）。
const BACKEND_RE =
  /^\/(api|@omnibox|@tvbox|@init|d|p|sd|kv-get|kv-put|kv-delete|kv-list|health)(\/|$|\?)/

export function middleware(context) {
  const { request, next, rewrite } = context
  const { pathname } = new URL(request.url)
  const accept = request.headers.get("accept") || ""

  const isBackend = BACKEND_RE.test(pathname)

  if (
    !isBackend &&
    (request.method === "GET" || request.method === "HEAD") &&
    accept.includes("text/html")
  ) {
    return rewrite("/index.html")
  }

  return next()
}

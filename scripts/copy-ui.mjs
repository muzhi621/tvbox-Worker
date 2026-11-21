/**
 * 用项目自带的 OmniBox 单页替换 OpenList 官方前端。
 *
 * 只做一件事：把 ui/index.html 复制到 dist/index.html，并为 EdgeOne 的
 * rewrites（/* → /index.html）提供一个最小可用站点壳。不再下载 23MB 的
 * OpenList 前端——本项目只需要一个管理界面，协议端点都在云函数里。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const SRC = path.join(ROOT, "ui", "index.html")
const DEST = path.join(ROOT, "dist")

if (!fs.existsSync(SRC)) {
  console.error(`[ui] missing ${SRC}`)
  process.exit(1)
}

fs.mkdirSync(DEST, { recursive: true })
const html = fs.readFileSync(SRC, "utf8")
fs.writeFileSync(path.join(DEST, "index.html"), html, "utf8")
console.log(`[ui] wrote dist/index.html (${Buffer.byteLength(html, "utf8")} bytes)`)

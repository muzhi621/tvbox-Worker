import { Pan115ShareApiClient } from "../drivers/115_share/util"
import { AliyundriveShareApiClient } from "../drivers/aliyundrive_share/util"
import { Pan123ShareApiClient } from "../drivers/123_share/util"
import type { Pan123ShareFileInfo } from "../drivers/123_share/types"

/**
 * 网盘分享链接解析（免登录）。
 *
 * OmniBox 网盘类脚本通过三个 SDK 方法取数：
 *   getDriveInfoByShareURL / getDriveFileList / getDriveVideoPlayInfo
 * 这里复用 OpenList 的分享驱动 client 实现，覆盖 115 / 阿里云盘 / 123 网盘。
 * 夸克 / UC / 天翼暂无免登录分享接口，会返回明确错误（而不是 null 触发脚本 TypeError）。
 */

export type ShareInfo = {
  driveType: string
  displayName: string
  shareId: string
  password: string
  supported: boolean
}

export type ShareFile = {
  fid: string
  name: string
  size: number
  isDir: boolean
  raw: any
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

const SUPPORTED = new Set(["115", "aliyundrive", "123"])

/** 从分享链接识别网盘并解析出 share 参数。 */
export function parseShareUrl(raw: string): ShareInfo | null {
  let u: URL
  try {
    u = new URL(String(raw || "").trim())
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  const path = u.pathname || ""
  const pwd =
    u.searchParams.get("pwd") ||
    u.searchParams.get("password") ||
    (u.hash ? (u.hash.match(/pwd=([^&#]+)/) || [])[1] || "" : "") ||
    ""
  const idMatch = path.match(/\/(?:s|t)\/([A-Za-z0-9_-]+)/)
  const id = idMatch ? idMatch[1] : ""

  const make = (driveType: string, displayName: string): ShareInfo => ({
    driveType,
    displayName,
    shareId: id,
    password: pwd,
    supported: SUPPORTED.has(driveType),
  })

  if (/(^|\.)115(cdn)?\.com$/.test(host)) return make("115", "115网盘")
  if (/(^|\.)(aliyundrive|alipan)\.com$/.test(host)) return make("aliyundrive", "阿里云盘")
  if (/(^|\.)(123pan|123684|123865|123912|123592|123pan\.cn)\.com?$/.test(host)) {
    return make("123", "123网盘")
  }
  if (/(^|\.)pan\.quark\.cn$/.test(host) || /quark\.cn$/.test(host)) return make("quark", "夸克网盘")
  if (/(^|\.)drive\.uc\.cn$/.test(host) || /uc\.cn$/.test(host)) return make("uc", "UC网盘")
  if (/(^|\.)cloud\.189\.cn$/.test(host)) return make("189", "天翼云盘")
  return null
}

/** 列表缓存：123 网盘下载直链需要完整文件对象；同时减少重复请求。 */
const listCache = new Map<string, { files: ShareFile[]; ts: number }>()
const LIST_TTL = 10 * 60 * 1000

function cacheKey(url: string, parentId: string): string {
  return `${url}::${parentId || "0"}`
}

/** 对应脚本的 OmniBox.getDriveInfoByShareURL(shareURL) */
export async function shareInfo(raw: string): Promise<{ driveType: string; displayName: string }> {
  const p = parseShareUrl(raw)
  if (!p) throw new Error(`无法识别的分享链接：${String(raw).slice(0, 120)}`)
  return { driveType: p.driveType, displayName: p.displayName }
}

/** 对应脚本的 OmniBox.getDriveFileList(shareURL, parentId) */
export async function shareList(
  raw: string,
  parentId = "0",
): Promise<{ files: ShareFile[] }> {
  const p = parseShareUrl(raw)
  if (!p) throw new Error(`无法识别的分享链接：${String(raw).slice(0, 120)}`)
  if (!p.supported) {
    throw new Error(`暂不支持${p.displayName}分享解析（当前支持 115 / 阿里云盘 / 123 网盘）`)
  }
  if (!p.shareId) throw new Error(`分享链接缺少分享 ID：${String(raw).slice(0, 120)}`)

  const key = cacheKey(raw, parentId)
  const hit = listCache.get(key)
  if (hit && Date.now() - hit.ts < LIST_TTL) return { files: hit.files }

  let files: ShareFile[] = []

  if (p.driveType === "115") {
    const client = new Pan115ShareApiClient({
      share_code: p.shareId,
      receive_code: p.password,
      page_size: 1000,
    } as any)
    const items = await client.getFiles(parentId && parentId !== "0" ? parentId : "0")
    files = items.map((f) => {
      const isDir = f.is_file === 0
      return {
        fid: String(isDir ? f.category_id || "" : f.file_id || ""),
        name: String(f.file_name || "file"),
        size: Number(f.file_size || 0) || 0,
        isDir,
        raw: f,
      }
    })
  } else if (p.driveType === "aliyundrive") {
    const client = new AliyundriveShareApiClient({
      share_id: p.shareId,
      share_pwd: p.password,
    } as any)
    await client.init()
    const items = await client.getFiles(parentId && parentId !== "0" ? parentId : "root")
    files = items.map((f) => ({
      fid: String(f.file_id || ""),
      name: String(f.name || "file"),
      size: Number(f.size || 0) || 0,
      isDir: f.type === "folder",
      raw: f,
    }))
  } else if (p.driveType === "123") {
    const client = new Pan123ShareApiClient({
      sharekey: p.shareId,
      sharepassword: p.password,
    } as any)
    const items = await client.getFiles(parentId && parentId !== "0" ? parentId : "0")
    files = items.map((f) => ({
      fid: String(f.FileId),
      name: String(f.FileName || "file"),
      size: Number(f.Size || 0) || 0,
      isDir: f.Type === 1,
      raw: f,
    }))
  }

  listCache.set(key, { files, ts: Date.now() })
  if (listCache.size > 200) listCache.clear()
  return { files }
}

/** 对应脚本的 OmniBox.getDriveVideoPlayInfo(shareURL, fileId, routeType) */
export async function sharePlay(
  raw: string,
  fileId: string,
  _routeType = "直连",
): Promise<{ url: { name: string; url: string }[]; header: Record<string, string> }> {
  const p = parseShareUrl(raw)
  if (!p) throw new Error(`无法识别的分享链接：${String(raw).slice(0, 120)}`)
  if (!p.supported) {
    throw new Error(`暂不支持${p.displayName}分享播放（当前支持 115 / 阿里云盘 / 123 网盘）`)
  }

  if (p.driveType === "115") {
    const client = new Pan115ShareApiClient({
      share_code: p.shareId,
      receive_code: p.password,
    } as any)
    const url = await client.getDownloadUrl(String(fileId))
    return {
      url: [{ name: "115网盘", url }],
      header: {
        "User-Agent": BROWSER_UA,
        Referer: "https://115.com/",
      },
    }
  }

  if (p.driveType === "aliyundrive") {
    const client = new AliyundriveShareApiClient({
      share_id: p.shareId,
      share_pwd: p.password,
    } as any)
    await client.init()
    const url = await client.getDownloadUrl(String(fileId))
    return {
      url: [{ name: "阿里云盘", url }],
      header: {
        "User-Agent": BROWSER_UA,
        Referer: "https://www.alipan.com/",
      },
    }
  }

  // 123：下载接口需要完整文件对象，从列表缓存里找
  const client = new Pan123ShareApiClient({
    sharekey: p.shareId,
    sharepassword: p.password,
  } as any)
  let target: Pan123ShareFileInfo | null = null
  for (const [k, v] of listCache) {
    if (!k.startsWith(raw)) continue
    const found = v.files.find((f) => f.fid === String(fileId))
    if (found) {
      target = found.raw as Pan123ShareFileInfo
      break
    }
  }
  if (!target) {
    // 缓存没有就重新列一次根目录再找
    const { files } = await shareList(raw, "0")
    const found = files.find((f) => f.fid === String(fileId))
    if (found) target = found.raw as Pan123ShareFileInfo
  }
  if (!target) throw new Error("123 网盘：未找到该文件，请先打开详情再播放")
  const url = await client.getDownloadUrl(target)
  return {
    url: [{ name: "123网盘", url }],
    header: {
      "User-Agent": BROWSER_UA,
      Referer: "https://www.123pan.com/",
    },
  }
}

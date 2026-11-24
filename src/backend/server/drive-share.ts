import { Pan115ShareApiClient } from "../drivers/115_share/util"
import { AliyundriveShareApiClient } from "../drivers/aliyundrive_share/util"
import { Pan123ShareApiClient } from "../drivers/123_share/util"
import { QuarkClient } from "../drivers/quark/util"
import { getDb } from "../internal/model/db"
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
  /** 木偶等脚本用 file_name 判视频后缀，必须和 name 同时给 */
  file_name: string
  size: number
  isDir: boolean
  /** 木偶等 OmniBox 脚本按 dir/file 判断，不能只给 isDir */
  dir: boolean
  file: boolean
  format_type?: string
  raw: any
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

const SUPPORTED = new Set(["115", "aliyundrive", "123"])
/** 能匿名列文件（详情可出集数），但播放需转存/登录的网盘 */
const LIST_ONLY = new Set(["quark", "uc"])

function shareFile(
  fid: string,
  name: string,
  size: number,
  isDir: boolean,
  raw: any,
  formatType?: string,
): ShareFile {
  return {
    fid,
    name,
    file_name: name,
    size,
    isDir,
    dir: isDir,
    file: !isDir,
    format_type: formatType,
    raw,
  }
}

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
    supported: SUPPORTED.has(driveType) || LIST_ONLY.has(driveType),
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

/** 夸克 / UC 分享：匿名获取 stoken（只需 pwd_id + 提取码）。 */
async function quarkShareToken(host: string, pr: string, pwdId: string, passcode: string): Promise<string> {
  const res = await fetch(`https://${host}/1/clouddrive/share/sharepage/token?pr=${pr}&fr=pc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": BROWSER_UA },
    body: JSON.stringify({ pwd_id: pwdId, passcode: passcode || "" }),
    signal: AbortSignal.timeout(15000),
  })
  const j: any = await res.json().catch(() => ({}))
  const stoken = j?.data?.stoken
  if (!stoken) throw new Error(j?.message || "获取夸克分享 token 失败（分享失效或缺少提取码）")
  return String(stoken)
}

/** 夸克 / UC 分享：列文件（匿名可列，播放仍需转存）。 */
async function quarkShareDetail(
  host: string,
  pr: string,
  pwdId: string,
  stoken: string,
  pdirFid: string,
): Promise<any[]> {
  const u = new URL(`https://${host}/1/clouddrive/share/sharepage/detail`)
  u.searchParams.set("pr", pr)
  u.searchParams.set("fr", "pc")
  u.searchParams.set("pwd_id", pwdId)
  u.searchParams.set("stoken", stoken)
  u.searchParams.set("pdir_fid", pdirFid && pdirFid !== "0" ? pdirFid : "0")
  u.searchParams.set("force", "0")
  u.searchParams.set("_page", "1")
  u.searchParams.set("_size", "100")
  u.searchParams.set("_fetch_banner", "0")
  u.searchParams.set("_fetch_share", "0")
  u.searchParams.set("_fetch_total", "1")
  u.searchParams.set("_sort", "file_type:asc,updated_at:desc")
  const res = await fetch(u.toString(), {
    headers: {
      "User-Agent": BROWSER_UA,
      Referer: pr === "UCBrowser" ? "https://drive.uc.cn/" : "https://pan.quark.cn/",
    },
    signal: AbortSignal.timeout(15000),
  })
  const j: any = await res.json().catch(() => ({}))
  const list = j?.data?.list
  if (!Array.isArray(list)) throw new Error(j?.message || "获取夸克分享文件列表失败")
  return list
}

/** 列表缓存：123 网盘下载直链需要完整文件对象；同时减少重复请求。 */
const listCache = new Map<string, { files: ShareFile[]; ts: number }>()
const LIST_TTL = 10 * 60 * 1000

function cacheKey(url: string, parentId: string): string {
  return `${url}::${parentId || "0"}`
}

/** 从已挂载网盘里找夸克/UC 的登录 cookie（只服务端使用，绝不下发前端）。 */
async function findQuarkMount(env: any, type: "quark" | "uc"): Promise<any | null> {
  try {
    const db = await getDb(env)
    for (const s of db.storages || []) {
      if (!s || s.disabled || !s.mount_path) continue
      const driver = String(s.driver || "").toLowerCase()
      const match = type === "uc" ? driver.includes("uc") && !driver.includes("quark") : driver.includes("quark")
      if (!match) continue
      let addition: any = s.addition
      if (typeof addition === "string") {
        try {
          addition = JSON.parse(addition)
        } catch {
          continue
        }
      }
      if (addition && String(addition.cookie || "").trim()) return { addition, driver }
    }
  } catch {}
  return null
}

/** 从列表缓存/递归列表里找到分享文件的原始对象（需要 share_fid_token 才能转存）。 */
async function findShareFile(raw: string, fid: string, depth = 0): Promise<any | null> {
  const id = String(fid || "")
  for (const [k, v] of listCache) {
    if (!k.startsWith(`${raw}::`)) continue
    const hit = v.files.find((f) => f.fid === id)
    if (hit) return hit.raw
  }
  if (depth > 3) return null
  const { files } = await shareList(raw, "0")
  for (const f of files) {
    if (f.fid === id) return f.raw
    if (f.dir) {
      const nested = await findShareFile(raw, id, depth + 1)
      if (nested) return nested
    }
  }
  return null
}

/** 把分享文件转存到已登录的夸克/UC 账号，再取自己的下载直链。 */
async function quarkSaveAndDownload(
  raw: string,
  p: ShareInfo,
  fileId: string,
  env: any,
): Promise<{ url: string; headers: Record<string, string>; name: string }> {
  const type: "quark" | "uc" = p.driveType === "uc" ? "uc" : "quark"
  const mount = await findQuarkMount(env, type)
  if (!mount) {
    throw new Error(`${p.displayName}播放需要先转存：请在后台挂载并登录${p.displayName}（填写 cookie）`)
  }
  const host = type === "uc" ? "pc-api.uc.cn" : "drive-pc.quark.cn"
  const pr = type === "uc" ? "UCBrowser" : "ucpro"
  const referer = type === "uc" ? "https://drive.uc.cn/" : "https://pan.quark.cn/"
  const cookie = String(mount.addition.cookie || "")
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: cookie,
    Referer: referer,
    "User-Agent": BROWSER_UA,
  }
  const stoken = await quarkShareToken(host, pr, p.shareId, p.password)
  const file = await findShareFile(raw, fileId)
  const saveRes = await fetch(`https://${host}/1/clouddrive/share/sharepage/save?pr=${pr}&fr=pc`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      fid_list: [String(fileId)],
      fid_token_list: file?.share_fid_token ? [String(file.share_fid_token)] : [],
      pwd_id: p.shareId,
      stoken,
      to_pdir_fid: "0",
      pdir_fid: "0",
      pdir_save_all: false,
      scene: "link",
    }),
    signal: AbortSignal.timeout(15000),
  })
  const saved: any = await saveRes.json().catch(() => ({}))
  const taskId = saved?.data?.task_id
  if (!taskId) throw new Error(`${p.displayName}转存失败：${saved?.message || "未返回任务 ID"}`)

  let savedFid = ""
  for (let i = 0; i < 20; i++) {
    const taskRes = await fetch(
      `https://${host}/1/clouddrive/task?pr=${pr}&fr=pc&task_id=${encodeURIComponent(String(taskId))}`,
      { headers, signal: AbortSignal.timeout(8000) },
    )
    const task: any = await taskRes.json().catch(() => ({}))
    if (Number(task?.status) === 2) {
      savedFid = String(task?.data?.save_as_top_fids?.[0] || "")
      break
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  if (!savedFid) throw new Error(`${p.displayName}转存未完成，请稍后重试`)

  const client = new QuarkClient({
    cookie,
    variant: type === "uc" ? "UC" : "Quark",
  } as any)
  const got = await client.getDownloadUrl(savedFid, String(file?.file_name || fileId))
  return { url: got.url, headers: got.headers, name: type === "uc" ? "UC网盘" : "夸克网盘" }
}

/** 对应脚本的 OmniBox.getDriveInfoByShareURL(shareURL) */
export async function shareInfo(raw: string): Promise<{ driveType: string; displayName: string }> {
  const p = parseShareUrl(raw)
  if (!p) throw new Error(`无法识别的分享链接：${String(raw).slice(0, 120)}`)
  // 夸克 / UC 虽不能免登录播放，但能匿名列文件，shareInfo 仍要返回给脚本渲染详情；
  // 其余不支持的网盘（如天翼）直接给明确错误，避免脚本拿到 null 后 TypeError。
  if (!p.supported && !LIST_ONLY.has(p.driveType)) {
    throw new Error(`暂不支持${p.displayName}分享解析（当前支持 115 / 阿里云盘 / 123 / 夸克 / UC）`)
  }
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
    throw new Error(`暂不支持${p.displayName}分享解析（当前支持 115 / 阿里云盘 / 123 / 夸克 / UC）`)
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
      return shareFile(
        String(isDir ? f.category_id || "" : f.file_id || ""),
        String(f.file_name || "file"),
        Number(f.file_size || 0) || 0,
        isDir,
        f,
      )
    })
  } else if (p.driveType === "aliyundrive") {
    const client = new AliyundriveShareApiClient({
      share_id: p.shareId,
      share_pwd: p.password,
    } as any)
    await client.init()
    const items = await client.getFiles(parentId && parentId !== "0" ? parentId : "root")
    files = items.map((f) => {
      const isDir = f.type === "folder"
      return shareFile(String(f.file_id || ""), String(f.name || "file"), Number(f.size || 0) || 0, isDir, f)
    })
  } else if (p.driveType === "123") {
    const client = new Pan123ShareApiClient({
      sharekey: p.shareId,
      sharepassword: p.password,
    } as any)
    const items = await client.getFiles(parentId && parentId !== "0" ? parentId : "0")
    files = items.map((f) => {
      const isDir = f.Type === 1
      return shareFile(String(f.FileId), String(f.FileName || "file"), Number(f.Size || 0) || 0, isDir, f)
    })
  } else if (p.driveType === "quark" || p.driveType === "uc") {
    const host = p.driveType === "uc" ? "pc-api.uc.cn" : "drive-pc.quark.cn"
    const pr = p.driveType === "uc" ? "UCBrowser" : "ucpro"
    const stoken = await quarkShareToken(host, pr, p.shareId, p.password)
    const items = await quarkShareDetail(host, pr, p.shareId, stoken, parentId)
    files = items.map((f: any) => {
      const isDir = f.dir === true || f.file_type === 0
      return shareFile(
        String(f.fid || ""),
        String(f.file_name || f.name || "file"),
        Number(f.size || 0) || 0,
        isDir,
        f,
        f.format_type ? String(f.format_type) : undefined,
      )
    })
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
  env?: any,
): Promise<{ url: { name: string; url: string }[]; header: Record<string, string> }> {
  const p = parseShareUrl(raw)
  if (!p) throw new Error(`无法识别的分享链接：${String(raw).slice(0, 120)}`)
  if (LIST_ONLY.has(p.driveType)) {
    const got = await quarkSaveAndDownload(raw, p, fileId, env)
    return { url: [{ name: got.name, url: got.url }], header: got.headers }
  }
  if (!p.supported) {
    throw new Error(`暂不支持${p.displayName}分享播放（当前支持 115 / 阿里云盘 / 123）`)
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

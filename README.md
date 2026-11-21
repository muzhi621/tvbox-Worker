# OmniBox Worker

借用 [OpenList-Worker](https://github.com/OpenListTeam/OpenList-Worker) 的核心驱动层，复刻 OmniBox 2.0 的核心体验：**网盘挂载 → 媒体库 → 爬虫源 → 发布订阅**，部署在腾讯云 EdgeOne Pages 云函数上，**不需要额外运行网关服务器**。

网盘账号与 Cookie 留在服务端，TVBox 客户端只拿到一条订阅地址。

```
浏览器 ──▶ /@omnibox/*        ──▶ OmniBox 风格管理界面（概览/媒体库/网盘/爬虫/订阅）
                                      │
TVBox  ──▶ /@tvbox/config.json ──▶ 订阅配置（网盘站 + 爬虫站）
       ──▶ /@tvbox/api         ──▶ 网盘目录（MACCMS）
       ──▶ /@tvbox/spider      ──▶ 爬虫源（MACCMS）
                                      │
                    进程内调用（非 HTTP）
                                      ▼
             OpenList 驱动层 (listItems/getItem)  +  爬虫沙箱 (node:vm)
                                      ▼
                    阿里云盘 / 115 / 夸克 / PikPak / 采集站 ...
```

## 保留与裁剪

本项目 fork 自 OpenList-Worker（AGPL-3.0），采用"体验复刻"策略：**保留后端核心，替换前端，关闭无关协议端点**。

| 类别 | 内容 |
|---|---|
| **保留** | 75+ 网盘/分享驱动、`op/storage` 与搜索、数据库与 KV/Blob 持久化、权限/签名中间件、播放直链 `/api/d`、`/api/p`、挂载 API `/api/admin/storage/*`、媒体库扫描与刮削 |
| **新增** | OmniBox 单页 UI、`/@omnibox` 统一入口、爬虫沙箱运行器、TVBox 爬虫端点、双源订阅 |
| **移除** | Emby / Subsonic / WebDAV / S3 协议端点、根级短路径、OpenList 官方前端（23MB → 19KB 自建单页） |

前端不再是 OpenList 官方界面，而是 `ui/index.html` 单页（构建时复制为 `dist/index.html`）。

| 文件 | 作用 |
|---|---|
| `ui/index.html` | OmniBox 风格单页管理界面 |
| `src/backend/server/omnibox.ts` | `/@omnibox` 概览/媒体库/挂载/源/订阅 API |
| `src/backend/server/omnibox-store.ts` | 双类型源配置持久化 + 访问码/HMAC |
| `src/backend/server/spider-runner.ts` | OmniBox JS 爬虫沙箱（omnibox_sdk / cheerio shim） |
| `src/backend/server/tvbox.ts` | TVBox 协议端点（网盘 + 爬虫，MACCMS） |
| `scripts/copy-ui.mjs` | 用自建 UI 替代 OpenList 前端下载 |

## 功能模块

1. **概览**：网盘数、源数量、媒体条目与刮削状态
2. **网盘挂载**：复用 OpenList 驱动（115/123/阿里云盘/PikPak/夸克等分享驱动），直接在 OmniBox 管理页添加并登记为源
3. **网盘源**：把已挂载目录登记为 TVBox 可浏览的源
4. **爬虫源**：导入 OmniBox JS 脚本（`module.exports = { home, category, detail, search, play }`），沙箱内执行
5. **媒体库**：扫描网盘目录，TMDB 刮削海报，海报墙展示；TVBox 目录浏览不受影响
6. **订阅**：勾选网盘源与爬虫源，生成一条带签名的 TVBox 订阅地址

详细使用见 [OMNIBOX_GUIDE.md](./OMNIBOX_GUIDE.md)。

## 安全边界

- 管理入口强制要求 `TVBOX_ACCESS_CODE`（未配置时返回 503）
- 客户端只能传 sourceId，路径由服务端白名单映射，`isWithinUserRoot` 二次校验
- 订阅 `sel` 参数与 `vod_id` 均带 HMAC 签名（来自 `JWT_SECRET`），篡改失效
- 播放直链 detail 时现取现签，不写 KV、不入订阅、不打日志
- 爬虫脚本在 `node:vm` 沙箱运行，超时 15 秒；`sniffVideo`/刮削/弹幕/网盘等需 Chromium 或后端状态的能力降级为空
- 管理界面不返回 `addition`（网盘 Token/Cookie）；建议开启 `DB_CIPHER=aes-256-gcm`

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `JWT_SECRET` | 是 | ≥16 位随机串，签名 + 字段加密 |
| `TVBOX_ACCESS_CODE` | 是 | 管理页口令 + 订阅访问码，务必设随机串 |
| `ADMIN_PASS` | 建议 | OpenList 管理后台密码（挂载网盘用） |
| `DB_FORMAT` | 否 | 固定 `map` |
| `DB_DRIVER` | 否 | EdgeOne 推荐 `blob`（零配置）或 `kv` |
| `DB_CIPHER` | 建议 | `aes-256-gcm`，加密落盘凭据 |
| `TVBOX_SOURCES` | 否 | JSON 数组，网盘源兜底；界面保存后以数据库为准 |

EdgeOne 环境变量可整段粘贴：

```
JWT_SECRET=<随机串>
TVBOX_ACCESS_CODE=<随机串>
ADMIN_PASS=<强密码>
DB_FORMAT=map
DB_DRIVER=blob
DB_CIPHER=aes-256-gcm
```

## 部署到 EdgeOne

完整步骤见 [DEPLOY_EDGEONE.md](./DEPLOY_EDGEONE.md)。构建配置：

| 配置项 | 值 |
|---|---|
| 安装命令 | `pnpm install --no-frozen-lockfile` |
| 构建命令 | `pnpm run build` |
| 输出目录 | `dist` |
| Node 版本 | 22.x |

部署后打开 `https://你的域名/@omnibox/?code=你的访问码` 进入管理界面，添加网盘、导入源、发布订阅都在这一页完成（根路径 `/` 保留 OpenList 后台供高级配置）。

## 接口

| 路径 | 说明 |
|---|---|
| `GET /@omnibox/?code=xxx` | OmniBox 单页管理界面 |
| `GET /@omnibox/driver-configs\|mounts\|sources\|media?code=xxx` | 驱动表单与数据查询 |
| `POST /@omnibox/mounts/add?code=xxx` | 在同一页添加网盘挂载（并登记为源） |
| `POST /@omnibox/sources/netdisk\|spiders?code=xxx` | 保存源 |
| `POST /@omnibox/media/scan\|scrape\|tmdb-key?code=xxx` | 媒体库操作 |
| `POST /@omnibox/spider/test\|call?code=xxx` | 爬虫调试 |
| `POST /@omnibox/subscribe?code=xxx` | 生成订阅链接 |
| `GET /@tvbox/config.json?code=xxx` | 订阅配置（全部源） |
| `GET /@tvbox/config.json?code=xxx&sel=<json>&sig=xxx` | 订阅配置（指定源） |
| `GET /@tvbox/api?code=xxx&...` | 网盘 MACCMS 数据 |
| `GET /@tvbox/spider?code=xxx&...` | 爬虫 MACCMS 数据 |

## 本地开发

```bash
pnpm install --no-frozen-lockfile
cp .env.example .env.local   # 填 JWT_SECRET / TVBOX_ACCESS_CODE
pnpm dev:worker
```

访问 `http://localhost:8787/@omnibox/?code=你的访问码`。

## 限制

- EdgeOne 无 Chromium：依赖 `OmniBox.sniffVideo` 的爬虫脚本可解析列表，但播放直链能力受限
- 爬虫脚本来自管理员自行导入，不与官方脚本仓库自动同步；上游站点改版需自行维护
- TMDB 刮削需申请 TMDB API Key；未配置时部分元数据不可用
- Follow 上游更新时，本项目改动集中在 6 个新增文件 + `index.ts`/`package.json`/构建脚本

## 许可与致谢

- 上游：[OpenListTeam/OpenList-Worker](https://github.com/OpenListTeam/OpenList-Worker)，AGPL-3.0
- 爬虫脚本生态参考：[Silent1566/OmniBox-Spider](https://github.com/Silent1566/OmniBox-Spider)
- 本项目同样以 AGPL-3.0 开源。若对外提供修改版服务，需公开相应源码。
- 请只接入你有权访问的内容；网盘风控、限速与内容合规由使用者自行承担。

# tvbox-Worker

把 [OpenList-Worker](https://github.com/OpenListTeam/OpenList-Worker) 改造成 TVBox / CatVod 可直接使用的网盘源，**不需要额外运行任何网关服务**。

部署在腾讯云 EdgeOne Pages 云函数上，网盘账号与 Cookie 留在服务端，TVBox 客户端只拿到一条订阅地址。

```
TVBox  ──▶ /@tvbox/config.json  ──▶ 订阅配置
       ──▶ /@tvbox/api          ──▶ 目录 / 搜索 / 播放（MACCMS 格式）
                                      │
                                      ▼ 进程内调用（非 HTTP）
                          OpenList 存储驱动层（listItems / getItem）
                                      │
                                      ▼
                          阿里云盘 / 115 / 夸克 / PikPak / ...
```

## 与上游的区别

本项目 fork 自 OpenList-Worker（AGPL-3.0），增加了 TVBox 协议端点和一个可视化源管理页：

| 文件 | 改动 |
|---|---|
| `src/backend/server/tvbox.ts` | `/@tvbox` 协议端点，输出 TVBox 订阅与 MACCMS 数据 |
| `src/backend/server/tvbox-store.ts` | 源配置持久化（settings 表）+ 访问码/HMAC 工具 |
| `src/backend/server/tvbox-admin.ts` | `/@tvbox/admin` 管理页 + `/@tvbox/manage/*` API |
| `src/backend/index.ts` | 挂载两个路由（位于 SPA 兜底之前） |

其余存储驱动、鉴权、KV/Blob 持久化、安全中间件全部沿用上游。[上游 README](./README-UPSTREAM.md) 保留供查阅。

## 两种配置方式

1. **管理页（推荐）**：打开 `/@tvbox/admin?code=你的访问码`，从已挂载网盘目录中选源、勾选、生成订阅链接。配置存在数据库里，不需要编辑环境变量。详见 [TVBOX_ADMIN_GUIDE.md](./TVBOX_ADMIN_GUIDE.md)。
2. **环境变量**：沿用 `TVBOX_SOURCES` JSON。仅当数据库里没有源配置时生效，作为兜底。

## 安全边界

- 客户端**只能传 sourceId**，不能传文件路径。服务端把 sourceId 映射到已配置（数据库或环境变量）的固定路径，并用 `isWithinUserRoot` 二次校验。
- 订阅链接可用 `sources=a,b` 选择部分源，签名由服务端签发并放在 `sig` 参数中；签名无效时降级为全部源，不会越权。
- `vod_id` 是「sourceId + 相对路径 + HMAC」的不透明令牌，签名来自 `JWT_SECRET`，客户端篡改即失效。
- 播放直链在 detail 请求时**现取现签**，不写入 KV、不进入订阅配置、不打印到日志。
- `TVBOX_ACCESS_CODE` 只用于挡住随手扫到订阅地址的人，它不是网盘凭据；管理端点在没有配置访问码时会主动关闭（503）。
- TVBox 客户端不携带 OpenList 登录态，访问码校验通过后使用只读上下文；可见路径仍受 sourceId 白名单约束。
- 管理页只读取挂载点的路径与备注，不返回 `addition`（含网盘 Token / Cookie）。建议开启 `DB_CIPHER=aes-256-gcm`。

## 环境变量

在 EdgeOne 项目的「环境变量」里配置：

| 变量 | 必填 | 说明 |
|---|---|---|
| `JWT_SECRET` | 是 | ≥16 位随机串。JWT 签名 + `vod_id` HMAC + 可选字段加密 |
| `TVBOX_SOURCES` | 否 | JSON 数组，目录白名单兜底；管理页保存过源后以数据库为准 |
| `TVBOX_ACCESS_CODE` | 是 | 订阅访问码，同时是管理页口令，务必设置随机串 |
| `ADMIN_PASS` | 建议 | OpenList 管理后台密码 |
| `DB_FORMAT` | 否 | 固定 `map` |
| `DB_DRIVER` | 否 | EdgeOne 上推荐 `blob`（零配置）或 `kv` |
| `DB_CIPHER` | 建议 | `aes-256-gcm`，加密落盘的网盘凭据 |

`TVBOX_SOURCES` 示例：

```json
[
  { "id": "movie", "name": "电影", "path": "/阿里云盘/电影" },
  { "id": "series", "name": "剧集", "path": "/115/电视剧" },
  { "id": "anime", "name": "动画", "path": "/夸克/动画", "password": "" }
]
```

- `id`：英文/数字，给 TVBox 传的 sourceId，不要含特殊字符
- `name`：TVBox 里显示的分类名
- `path`：OpenList 里的**绝对路径**，即管理后台存储挂载后看到的路径
- `password`：可选，仅当该目录被 OpenList 密码保护时填写

## 部署到 EdgeOne

完整步骤见 [DEPLOY_EDGEONE.md](./DEPLOY_EDGEONE.md)。

## 接口

| 路径 | 说明 |
|---|---|
| `GET /@tvbox/admin?code=xxx` | 可视化源管理页 |
| `GET /@tvbox/manage/data?code=xxx` | 读取当前源与可挂载目录（不含凭据） |
| `POST /@tvbox/manage/save?code=xxx` | 保存源配置 |
| `POST /@tvbox/manage/link?code=xxx` | 生成带签名的订阅链接 |
| `GET /@tvbox/config.json?code=xxx` | TVBox 订阅配置 |
| `GET /@tvbox/config.json?code=xxx&sources=a,b&sig=xxx` | 只含指定源的订阅配置 |
| `GET /@tvbox/api?code=xxx&ac=videolist&t=movie&pg=1` | 列目录 |
| `GET /@tvbox/api?code=xxx&ac=search&wd=关键词` | 全库搜索 |
| `GET /@tvbox/api?code=xxx&ac=videolist&ids=<vod_id>` | 详情 + 播放直链 |
| `GET /@tvbox/api?code=xxx&ac=list` | 只返回分类列表 |

## 本地开发

```bash
pnpm install --no-frozen-lockfile
cp .env.example .env.local   # 填入 JWT_SECRET / TVBOX_SOURCES
pnpm dev:worker
```

访问 `http://localhost:8787/@tvbox/config.json` 验证。

## 许可与致谢

- 上游：[OpenListTeam/OpenList-Worker](https://github.com/OpenListTeam/OpenList-Worker)，AGPL-3.0
- 本项目同样以 AGPL-3.0 开源。若对外提供修改版服务，需公开相应源码。
- 请只接入你有权访问的内容；网盘账号的风控、限速由使用者自行承担。

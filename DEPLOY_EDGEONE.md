# 部署到腾讯云 EdgeOne Pages

本教程把 `tvbox-Worker` 部署到 EdgeOne Pages 云函数，得到一条国内可直连的 TVBox 网盘订阅地址。

 prerequisites：一个腾讯云账号（EdgeOne Pages 免费额度即可）、一个 GitHub 账号、至少一个你有权访问的网盘账号。

---

## 第 1 步：Fork 仓库

1. 打开 <https://github.com/muzhi621/tvbox-Worker>
2. 点击右上角 **Fork**
3. Fork 到你自己的账号下（后续所有配置都在你自己的仓库里改）

---

## 第 2 步：一键导入 EdgeOne Pages

根据你的账号站点选择：

| 站点 | 部署入口 |
|---|---|
| 国际站 | <https://edgeone.ai/pages/new> |
| 中国站（国内访问推荐） | <https://console.cloud.tencent.com/edgeone/pages/new> |

在导入页选择 **GitHub** → 选中刚 fork 的仓库，构建配置保持默认（已写在 `edgeone.json` 中）：

| 配置项 | 值 |
|---|---|
| 安装命令 | `pnpm install --no-frozen-lockfile` |
| 构建命令 | `pnpm run build` |
| 输出目录 | `dist` |
| Node 版本 | 22.x（取自 `edgeone.json`） |

先不要点部署，下一步先填环境变量。

---

## 第 3 步：配置环境变量

在部署页的「环境变量 / Environment Variables」中添加：

### 必填

**`JWT_SECRET`**

≥16 位随机串，用于 JWT 签名、`vod_id` 的 HMAC 签名以及可选的字段加密。可用命令生成：

```bash
openssl rand -hex 24
```

**`TVBOX_ACCESS_CODE`**

订阅访问码，同时也是管理页口令。管理端点在未设置此变量时会主动返回 503。用随机串，例如 `tv_` 加 20 位字母数字。

> 可以访问 OmniBox 管理界面 `/@omnibox/?code=你的访问码` 来配置源，不需要编辑 `TVBOX_SOURCES`。见第 5 步。

### 可选（兜底）

**`TVBOX_SOURCES`**

JSON 数组，定义目录白名单。只有在管理页还没保存过任何源时才会读取它，作为兜底。推荐直接用管理页配置。示例：

```json
[
  { "id": "movie", "name": "电影", "path": "/阿里云盘/电影" },
  { "id": "series", "name": "剧集", "path": "/115/电视剧" }
]
```

> `path` 必须与 OpenList 管理后台看到的路径一致。

### 强烈建议

| 变量 | 示例值 | 说明 |
|---|---|---|
| `ADMIN_PASS` | 你的强密码 | OpenList 管理后台密码 |
| `DB_CIPHER` | `aes-256-gcm` | 加密落盘的网盘 Cookie / Token |
| `DB_FORMAT` | `map` | 数据格式，固定这个值 |
| `DB_DRIVER` | `blob` | EdgeOne 上零配置持久化 |

填好后点击部署，等待构建完成（首次约 2–5 分钟）。

---

## 第 4 步：初始化 OpenList 并挂载网盘

1. 打开部署完成后的默认域名，例如 `https://tvbox-Worker.xxx.edgeone.site`
2. 用 `ADMIN_PASS` 登录管理后台
3. 进入 **存储 → 添加**，选择你的网盘驱动（阿里云盘 Open / 115 分享 / 夸克 / PikPak 等）
4. 按提示填写 Refresh Token 或分享链接，挂载路径填一个顶层目录，例如 `/阿里云盘`
5. 挂载完成后，在文件浏览页确认实际路径，例如 `/阿里云盘/电影`
6. 回到 EdgeOne 控制台，把 `TVBOX_SOURCES` 里的 `path` 改成这个真实路径，保存并**重新部署**

> 搜索功能需要在 OpenList 后台预先建立索引；不建索引也不影响目录浏览和播放。

---

## 第 5 步：拿到订阅地址

### 方式 A：OmniBox 管理界面生成（推荐）

打开管理界面：

```
https://你的域名/@omnibox/?code=你的访问码
```

在界面里添加网盘登录、导入网盘源或爬虫源、勾选需要的源，点「生成订阅链接」并复制。添加网盘成功后会自动登记为网盘源。
完整操作见 [OMNIBOX_GUIDE.md](./OMNIBOX_GUIDE.md)。

管理界面有五个页签：概览、媒体库（海报墙 + 刮削）、网盘挂载、网盘源、爬虫源、订阅链接。

### 方式 B：直接访问

在浏览器打开：

```
https://你的域名/@tvbox/config.json?code=你的访问码
```

如果配置了 `TVBOX_ACCESS_CODE`，必须带 `code` 参数；没配置则直接访问 `/@tvbox/config.json`。
不带 `sources` 参数时，订阅包含数据库（或环境变量）里配置的全部源。

返回类似：

```json
{
  "sites": [{
    "key": "openlist",
    "name": "OpenList 网盘",
    "type": 3,
    "api": "https://你的域名/@tvbox/api?code=你的访问码",
    "searchable": 1
  }]
}
```

把整个 JSON 的 URL（即 config.json 的地址）填进 TVBox 的「订阅地址」即可。

---

## 第 6 步：TVBox 客户端配置

1. 打开 TVBox / FongMi / CatVod 类 App
2. 设置 → 点播订阅 → 添加，填入上一步的 `config.json` 地址
3. 返回首页，应看到名为「OpenList 网盘」的源，分类为管理页里配置的源名称（或 `TVBOX_SOURCES` 里的 `name`）
4. 目录浏览可以看到视频文件，点播放会现取一条带签名的直链

常见客户端已验证：FongMi TV、CatVodTV。

---

## 验证与排错

| 现象 | 排查 |
|---|---|
| `/@tvbox/config.json` 返回 401 | `code` 参数与 `TVBOX_ACCESS_CODE` 不一致 |
| 返回 `TVBOX_SOURCES is not configured` | 环境变量未生效，或 JSON 格式有误（注意不要有注释） |
| 返回 503 `STORAGE_CONFIG_ERROR` | `DB_FORMAT` / `DB_DRIVER` 没设，或 JWT_SECRET 缺失 |
| 分类为空 | `TVBOX_SOURCES` 的 `path` 与 OpenList 实际路径不符 |
| 播放 401 `sign verify failed` | 检查 JWT_SECRET 在重新部署后是否变化；变了会导致旧签名失效 |
| 搜索无结果 | 需在 OpenList 后台建立索引 |

调试时可直接请求 API 看原始返回：

```
https://你的域名/@tvbox/api?code=xxx&ac=videolist&t=movie&pg=1
```

---

## 注意事项

- **访问码不是密码**：拿到 config.json 地址的人就能使用你的订阅（含访问码）。不要把订阅地址公开发布。
- **直链短效**：播放地址每次点播时现签，不要复制出来长期保存或写进其他配置。
- **公网暴露**：建议给 EdgeOne 自定义域名开启 HTTPS，并限制管理后台访问来源。
- **上游更新**：本项目跟随 OpenList-Worker 上游，更新时只需同步 `src/backend/server/tvbox.ts` 与 `index.ts` 两处改动。
- **合规**：只挂载你有合法访问权限的内容。

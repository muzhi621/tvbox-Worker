# OmniBox Worker 使用指南

管理界面地址：`https://你的域名/@omnibox/?code=你的访问码`

一个网页完成全部操作：打开 `/@omnibox/?code=你的访问码` 即可添加网盘、登记源、生成订阅。根路径 `/` 仍保留 OpenList 后台，供高级配置使用。

## 前置条件

EdgeOne 环境变量至少配置：

```
JWT_SECRET=<≥16位随机串>
TVBOX_ACCESS_CODE=<随机串，如 tv_ 加 20 位字母数字>
ADMIN_PASS=<OpenList 后台强密码>
DB_FORMAT=map
DB_DRIVER=blob
DB_CIPHER=aes-256-gcm
```

> `TVBOX_ACCESS_CODE` 未设置时，所有管理接口返回 503。务必设置。

## 完整流程

### 第 1 步：在同一个网页添加网盘

在管理界面切到「网盘挂载」页签：

1. 从下拉框选择网盘驱动（115/123/阿里云盘/PikPak/夸克等；带 `_share` 后缀的是分享驱动）
2. 填挂载路径（如 `/aliyun`）和登录凭据/分享链接。表单会按所选驱动自动显示需要填写的字段
3. 点「添加网盘并登记为源」

成功后会同时完成两件事：OpenList 驱动层挂载该网盘，并把该目录登记为 TVBox 网盘源。凭据只写入服务端配置，界面不会回显。

> 先选网盘类型是必须的——各网盘接口不同，OmniBox 内部同样按类型分派。

### 第 2 步：确认网盘源

切到「网盘源」页签，可看到第 1 步自动登记的源。需要添加更多目录时：

- 从下拉框选择已挂载的目录
- 填显示名称，点「添加」

源会保存到数据库，无需重启或重新部署。

### 第 3 步（可选）：导入爬虫源

在「爬虫源」页签：

1. 填名称与 ID（英文数字）
2. 粘贴 OmniBox JS 脚本代码，需满足：
   ```js
   async function home(params, context) { /* 返回 { class, list } */ }
   async function search(params, context) { /* 返回 { list } 或 { page, pagecount, list } */ }
   async function detail(params, context) { /* 返回 { list: [vod] } */ }
   async function play(params, context) { /* 返回 { urls: [{name, url}], parse } */ }
   module.exports = { home, category, detail, search, play }
   ```
3. 点「测试 home()」验证脚本可执行

脚本沙箱提供：
- `require("omnibox_sdk")`：`request`（走 fetch）、`log`、`fetch`、`getEnv`；`sniffVideo`/刮削/弹幕/网盘方法降级为空
- `require("cheerio")`：`load / find / each / attr / text / first / children` 等常用选择器 API
- `require("spider_runner")`：`run()` 为空操作
- 环境：`process`、`console`、`Buffer`、`setTimeout`、`URL`、`URLSearchParams`、`fetch`、`crypto`

**限制**：EdgeOne 无 Chromium，依赖嗅探的脚本（`OmniBox.sniffVideo`）只能拿到列表，播放直链不可用。这类源建议用网盘源替代。

### 第 4 步（可选）：媒体库海报墙

在「媒体库」页签：

1. 保存 TMDB API Key（用于刮削海报与元数据）
2. 添加扫描路径（从已挂载网盘目录选）
3. 点「扫描」生成媒体条目，再点「刮削海报」
4. 等待后台任务完成后刷新，即可看到海报墙

海报墙是管理端的展示，TVBox 端仍走目录浏览（两者互不干扰）。

### 第 5 步：生成订阅

在「订阅链接」页签：

- 勾选要发布的网盘源和爬虫源
- 点「生成订阅链接」，复制地址
- 在 TVBox / FongMi / CatVod 的「配置导入」中粘贴

生成的订阅包含两个站点：「OmniBox 网盘」和「OmniBox 爬虫源」（只勾选一类时只含对应站点）。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 管理界面 401 | URL 里的 `code` 与 `TVBOX_ACCESS_CODE` 不一致 |
| 管理接口 503 | 未设置 `TVBOX_ACCESS_CODE`，管理端点被主动关闭 |
| 挂载下拉框为空 | 尚未添加网盘，或挂载被禁用；到「网盘挂载」页签添加 |
| 爬虫测试报错 `does not export home()` | 脚本未按 CommonJS 导出对应方法 |
| 爬虫有列表但播放失败 | 脚本依赖 `sniffVideo`，EdgeOne 无 Chromium，属预期限制 |
| TVBox 分类为空 | 源路径填错，或目录里没有视频文件 |
| 海报不显示 | 未配 TMDB Key 或未刮削；检查媒体库条目状态 |

## 安全说明

- 订阅链接含访问码，拿到链接的人即可使用，请勿公开分享
- 网盘 Token/Cookie 只存在于 OpenList 侧，管理界面不读取 `addition` 字段
- 爬虫脚本由管理员自行导入，会在服务端沙箱执行；只导入可信来源的脚本
- 源配置存在 `settings.omnibox_sources`，随 OpenList 一起备份与加密

## 合规

只接入你有权访问的内容。网盘账号的风控、限速、封禁及内容合规由使用者自行承担。

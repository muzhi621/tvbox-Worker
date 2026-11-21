# OmniBox Worker 使用指南

管理入口：**直接打开站点根路径** `https://你的域名/`，首次输入 `TVBOX_ACCESS_CODE` 后浏览器会记住；兼容入口 `/@omnibox/?code=你的访问码` 仍可用。

已按 OmniBox 2.1.4.1 复刻八个页签：前台首页、网盘授权、解析资源、爬虫管理、订阅管理、定时任务、媒体资源、插件管理。**不提供直播资源功能**。

## 前置条件

EdgeOne 环境变量至少配置：

```
JWT_SECRET=<≥16位随机串>
TVBOX_ACCESS_CODE=<随机串，如 tv_ 加 20 位字母数字>
DB_FORMAT=map
DB_DRIVER=blob
DB_CIPHER=aes-256-gcm
```

> `TVBOX_ACCESS_CODE` 未设置时，所有管理接口返回 503。务必设置。

## 第 1 步：网盘授权

在「网盘授权」页：

1. 选择网盘驱动（115/123/阿里云盘/PikPak/夸克等；带 `_share` 后缀的是分享驱动）
2. 填挂载路径（如 `/aliyun`）和登录凭据/分享链接。表单按驱动自动显示所需字段
3. 点「添加网盘并登记为源」

成功后同时完成 OpenList 挂载与 TVBox 网盘源登记。页面卡片显示有效/无效状态，凭据不会回显。

## 第 2 步：爬虫管理（默认库）

项目内置了 [OmniBox-Spider](https://github.com/Silent1566/OmniBox-Spider) 默认库快照（134 个脚本，构建期解析名称/版本/描述/分类/标签/优先级）；运行时不依赖 GitHub API。

在「爬虫管理」页点「GitHub 导入」：

1. 搜索或按分类筛选脚本
2. 勾选需要的源
3. 点「同步选中」——服务端按需拉取源码并写入你的源配置

说明：

- 已同步过的脚本再次同步会更新代码并保留启用/导航/推送状态
- Python 脚本会登记但**禁用**，因为 EdgeOne Serverless 没有 Python 运行时
- 也可以点「添加源」手动粘贴自己的 JS 脚本

脚本需导出 `module.exports = { home, category, detail, search, play }`。沙箱提供 `omnibox_sdk`、`cheerio`、`spider_runner`、`vm` shim 与非敏感环境变量；依赖 `sniffVideo` 的播放直链在 EdgeOne 不可用。

## 第 3 步：解析资源与插件（可选）

- 「解析资源」：添加自定义解析站点，填写站点名称、类型、接口地址，支持启用/禁用/删除
- 「插件管理」：设置弹幕 API 地址与 TMDB Key；TMDB Key 与媒体资源页共用

## 第 4 步：订阅管理

在「订阅管理」点「新建订阅」：

1. 填订阅名称与描述
2. 点「生成」创建独立访问令牌
3. 在穿梭框里把爬虫源从“待选列表”移到“已选列表”，并勾选网盘源
4. 保存后点该行的「生成链接」

链接形如：

```text
https://你的域名/@tvbox/config.json?token=<订阅令牌>&sel=<json>&sig=<签名>
```

`token` 只授予该订阅的读取权限，不能访问管理接口。把链接导入 TVBox / FongMi / CatVod 的配置即可。

## 第 5 步：定时任务与媒体资源（可选）

- 「定时任务」：新建任务，设置手动/定时、JS/Python、超时、并发、关联脚本；JS 任务可点「运行」立即执行
- 「媒体资源」：添加扫描路径后扫描，保存 TMDB Key 后刮削海报；TVBox 端仍走目录浏览

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 首页弹出访问码输入框 | 未在 URL 携带 `code` 且浏览器未保存；输入 `TVBOX_ACCESS_CODE` 即可 |
| 管理接口 401 | 浏览器保存的访问码与 `TVBOX_ACCESS_CODE` 不一致；重新输入或清除站点数据 |
| 管理接口 503 | 未设置 `TVBOX_ACCESS_CODE` |
| GitHub 导入列表为空 | 内置目录未生成；仓库应包含 `src/backend/data/spider-catalog.ts` |
| 同步后脚本被禁用 | Python 脚本在 Serverless 不可用，属预期行为 |
| 爬虫有列表但播放失败 | 脚本依赖 `sniffVideo`，EdgeOne 无 Chromium |
| TVBox 分类为空 | 源路径错误或目录没有视频文件 |

## 安全说明

- 网盘 Token/Cookie 只写入服务端 OpenList 配置；管理界面不读取 `addition`
- 默认库脚本只能看到过滤后的非敏感环境变量
- 订阅令牌可单独撤销（删除或禁用该订阅即可）
- 源与页面配置存在 settings 表，随 OpenList 一起备份；建议开启 `DB_CIPHER=aes-256-gcm`

## 更新内置脚本库

```bash
node scripts/build-spider-catalog.mjs
```

该命令从 OmniBox-Spider 的 `main` 分支重新拉取脚本头部元数据，覆盖 `src/backend/data/spider-catalog.ts`。源码只在用户勾选同步时才下载。

## 合规

只接入你有权访问的内容。网盘账号的风控、限速、封禁及内容合规由使用者自行承担。

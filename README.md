# B2 网盘（B2NetDisk）

基于 **Node.js + Electron** 实现的桌面网盘客户端，底层**直接对接 Backblaze B2 原生 API**（非 S3 兼容模式），把一个 B2 存储桶模拟成类似百度网盘的目录结构，提供上传、下载、预览、分享等完整网盘体验。

---

## 功能特性

### 文件管理
-  **目录浏览**：通过 `b2_list_file_names` + `delimiter='/'` 模拟文件夹层级，支持面包屑导航、翻页拉全量
-  **上传**：自动识别大小 —— 小文件走 `b2_upload_file` 单次上传，≥200MB 自动走 `b2_start_large_file` 分片上传（100MB/片），带实时进度
-  **下载**：`b2_download_file_by_name` 流式写入磁盘，支持**取消**；配置代理时自动走代理（免流 + 绕过 DNS 劫持）
-  **删除**：文件用 `b2_delete_file_version`，文件夹递归删除其下全部文件
-  **重命名**：`b2_copy_file` + `b2_delete_file_version`，支持整文件夹重命名
-  **新建文件夹**：上传零字节 `.folderkeep` 占位文件
-  **移动文件 / 文件夹**：行内「移动」按钮通过文件夹选择器指定目标位置；也可直接把文件名拖到某个文件夹行上完成移动。底层 `b2_copy_file` + `b2_delete_file_version`，逐版本迁移（含历史版本），支持整文件夹迁移
-  **拖拽上传**：拖到文件夹行上传到该文件夹，拖到其余区域上传到当前目录

### 预览与分享
-  **视频 / 音频 / 图片预览**：在独立可缩放、可全屏的窗口中打开，顶部显示实际使用的链接地址；图片走 base64 加载（绕开 CSP/跨域/私有桶鉴权）
-  **分享链接**：优先使用 Cloudflare 等代理生成免流隐藏链接，可自定义 URL 模板，一键复制
-  **HTML 分享页**：一键为指定文件夹生成可部署到 Cloudflare Pages 的单文件分享页（见下文「分享页功能」）

### 体验增强
-  **空间统计**：后台全量遍历统计桶已用空间，顶栏展示（缓存 + 后台刷新，点击徽标可手动刷新）
-  **传输队列**：右下角固定图标显示/隐藏面板，角标显示进行中任务数，下载项可随时取消
-  **内置配置向导**：首次启动填写 B2 凭据与代理设置，持久化到本地，不依赖环境变量
-  类百度网盘的清爽 UI，自定义多尺寸应用图标

---

##  技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Electron 31 |
| 运行时 | Node.js（内置 fetch / stream） |
| 打包 | electron-builder（NSIS 安装包） |
| 后端 API | Backblaze B2 Native API v2（零第三方 SDK） |

> 整个 B2 对接只用 Node 内置 `fetch`，无 axios / aws-sdk 等重型依赖。

---

##  项目结构

```
b2/
├── src/
│   ├── main/                  # Electron 主进程
│   │   ├── main.js            # 入口、IPC 注册、窗口管理、下载任务队列
│   │   ├── b2.js              # B2 原生 API 客户端（核心）
│   │   ├── preload.js         # 安全 IPC 桥接（contextIsolation）
│   │   └── settings.js        # 用户配置 + 空间统计缓存（settings.json）
│   ├── renderer/              # 渲染进程（界面）
│   │   ├── index.html         # 主界面结构
│   │   ├── style.css          # 界面样式
│   │   ├── renderer.js        # 界面逻辑
│   │   ├── shareTemplate.js   # HTML 分享页模板（单文件生成）
│   │   ├── player.html        # 媒体/图片预览窗口
│   │   └── player.js          # 预览窗口逻辑
│   └── assets/                # 图标资源（应用图标、队列按钮图标）
└── package.json
```

---

## ⚙️ 配置

### 应用内配置向导（唯一方式）
首次启动会自动弹出配置向导，填写：

| 字段 | 说明 |
|---|---|
| Key ID | B2 应用密钥 ID |
| Application Key | B2 应用密钥 |
| Bucket ID | 存储桶 ID |
| Bucket Name | 存储桶名称 |
| 代理基地址 | 如 `https://b2.smmmax.top`（Cloudflare 代理，可选，留空则直连） |
| URL 模板 | 占位符 `{proxyBase}` / `{filePath}` / `{bucketName}`，默认 `{proxyBase}/{filePath}` |

配置保存在**安装目录下的 `settings.json`**（与 `B2NetDisk.exe` 同级），可随时在「⚙ 设置」中修改并即时生效。从旧版本升级时，会自动把原 `%APPDATA%` 下的配置迁移过来。

> 凭据不依赖任何环境变量，也不随安装包分发，完全由使用者在向导中自行填写。

---

##  设置代理（Cloudflare）

B2 的下载域名（如 `f005.backblazeb2.com`）在部分网络环境会被 DNS 污染（解析到 `127.0.0.1`）导致无法直连下载。用 Cloudflare 免费套餐即可自建代理，同时享受 Cloudflare 与 Backblaze 带宽联盟带来的**免流出流量**。全程无需 Worker，仅用 DNS + URL 重写规则。

### 原理

浏览器 / 软件 → `b2.你的域名`（Cloudflare）→ 重写路径加 `/file/桶名` 前缀 → 回源 B2 下载域名（CNAME 对接，公开桶免鉴权）。

### 前提

- 一个已接入 Cloudflare 的域名（NS 托管）
- B2 桶可见性为 **Public**（公开桶才能免鉴权下载）
- 拿到你账号的 B2 下载域名：B2 控制台任意文件详情里的 Friendly URL，域名部分形如 `f005.backblazeb2.com`（各账号不同）

### 第 1 步：DNS 记录

「DNS → 记录」添加：

| 类型 | 名称 | 目标 | 代理状态 |
|---|---|---|---|
| CNAME | `b2`（即 `b2.你的域名`） | `f005.backblazeb2.com`（换成你的下载域名） | **已代理**（橙色云，必须） |

### 第 2 步：URL 重写规则（两条，互斥）

「规则 → 概述 → 创建规则 → URL 重写规则」，建**两条**规则。注意：多条规则同时命中时会**全部执行、后一条覆盖前一条**，因此必须用匹配条件保持互斥。

**规则 A：按版本下载**（带 `fileId=` 的请求）

- 匹配：自定义筛选表达式

  ```
  (http.host eq "b2.你的域名" and http.request.uri.query contains "fileId=")
  ```

  （图形界面：主机名 等于 `b2.你的域名`，And → URI 查询字符串 包含 `fileId=`）
- 路径：重写到… → **Static** → `/b2api/v2/b2_download_file_by_id`
- 查询：**保留**

> B2 的友好下载 URL 会忽略 `?fileId=` 参数（永远返回最新版），按版本下载必须改写到 `b2_download_file_by_id` 端点。

**规则 B：普通下载**（加桶名前缀）

- 匹配：自定义筛选表达式

  ```
  (http.host eq "b2.你的域名" and not http.request.uri.query contains "fileId=")
  ```

  （图形界面：主机名 等于 `b2.你的域名`，And → URI 查询字符串 **不包含** `fileId=`）
- 路径：重写到… → **Dynamic** → `concat("/file/你的桶名", http.request.uri.path)`
- 查询：**保留**

### 第 3 步（可选）：允许跨域

若要把代理文件用于网页 `fetch`（如本软件生成的分享页实时读取 `sharedConfig.json`）：「规则 → 修改响应标头」新增规则，条件主机名等于 `b2.你的域名`，设置静态响应头 `Access-Control-Allow-Origin: *`。

### 第 4 步：验证

```powershell
curl.exe -I "https://b2.你的域名/某个真实文件路径"
```

返回 `200` 且带 `x-bz-file-name` 响应头即成功。版本下载可再验证 `?fileId=某版本ID` 是否返回对应版本（比对响应头 `x-bz-file-id`）。

最后在软件「⚙ 设置 → 代理基地址」填入 `https://b2.你的域名` 即可。

---

##  开发运行

```powershell
npm install
npm start        # 或 npm run dev
```

##  打包发布

```powershell
npm run build    # 生成 dist\B2NetDisk Setup 1.0.0.exe
```

打包说明：
- 产物为 Windows NSIS 安装包，发布者 / 公司 / 版权署名为 **smmcat**
- 应用图标使用多尺寸 `src/assets/icon.ico`（16~256px，由 `scripts/build-icon.js` 合成），已写入 exe 版本资源，任务栏固定后正常显示
- 安装包不含任何凭据 / 测试数据，终端用户通过应用内向导配置
- `publish: null` 已禁用 electron-builder 的自动发布（避免 CI 环境要求 GH_TOKEN）

---

##  分享页功能

顶栏「🌐 分享页」按钮提供三个入口：

| 入口 | 作用 |
|---|---|
| 🛠 创建配置项 | 选择一个文件夹作为分享范围，软件遍历其下子文件夹（按名称排序作为分类）及各子文件夹内的媒体文件（按上传时间排序），在该文件夹根目录生成 `sharedConfig.json`（结构 `{分类名:[{title,url,createTime}...]}`，url 走代理），并在本地存档 |
| 📄 生成分享页 | 选择含 `sharedConfig.json` 的文件夹（选择器会标注哪些文件夹含配置并做格式合法性校验），填写网站标题与公告，生成单文件 `index.html` 下载到本地 |
| 📋 查看已存在分享页 | 列出全部存档，可单独「更新配置」、「一键更新全部配置」、生成分享页、删除存档记录 |

**自动同步**：在已创建配置的文件夹范围内执行上传 / 拖拽上传 / 删除 / 重命名后，软件会自动重新扫描并覆盖云端 `sharedConfig.json`，部署后的页面刷新即见新内容，无需手动操作。

**分享页特性**：小博客风格单文件页面（主标题 + 公告 + 可折叠分类），按扩展名区分展示：音频/视频内嵌播放器，图片懒加载内联展示，压缩包提供下载按钮，应用程序安装包（exe/msi/dmg/pkg/apk/aab/xapk/deb/rpm/appimage）按 **Windows / macOS / Android / Linux** 分平台卡片展示（平台图标 + 专属配色 + 下载按钮）。每次访问实时 `fetch` json 渲染，json 的实际链接（代理地址）在生成时写死进 html。每个分类支持独立排序：**上传时间 / 文件名 × 递增 / 递减**，默认上传时间递减（最新在前）。

**部署到 Cloudflare Pages**：
1. Cloudflare 控制台 → Workers 和 Pages → 创建 → Pages → 上传资产，把 `index.html` 拖入部署
2. 确保代理域名允许跨域：若代理是 URL 重写规则实现的，在「规则 → 修改响应标头」新增规则（条件：主机名等于 `b2.你的域名`，设置静态响应头 `Access-Control-Allow-Origin: *`）；若是 Worker 代理则在 Worker 响应中加同一响应头并处理 OPTIONS 预检

---

##  说明

- **关于「剩余空间」**：B2 是按使用量付费、容量无上限的对象存储，无配额概念，因此只统计「已用空间」，不存在「剩余空间」。
- **空间统计**：B2 无官方用量接口，已用空间通过全量遍历文件累加 `contentLength` 得到；文件极多时统计较慢，故采用后台异步 + 本地缓存。
- **代理建议**：若直连下载出现 `fetch failed`（常见于网络环境 DNS 劫持 B2 下载域名），按上文「  设置代理（Cloudflare）」配置即可解决，同时实现免流。

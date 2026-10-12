# B2 网盘（B2NetDisk）

基于 **Node.js + Electron** 实现的桌面网盘客户端，底层**直接对接 Backblaze B2 原生 API**（非 S3 兼容模式），把一个 B2 存储桶模拟成类似百度网盘的目录结构，提供上传、下载、预览、分享等完整网盘体验。

---

## 功能特性

### 文件管理
-  **目录浏览**：通过 `b2_list_file_names` + `delimiter='/'` 模拟文件夹层级，支持面包屑导航、翻页拉全量
-  **上传**：自动识别大小 —— 小文件走 `b2_upload_file` 单次上传，≥200MB 自动走 `b2_start_large_file` 分片上传（100MB/片），带实时进度
-  **下载**：`b2_download_file_by_name` 流式写入磁盘，支持**取消**；配置代理时自动走代理（免流 + 绕过 DNS 劫持）
-  **删除**：文件用 `b2_delete_file_version`，文件夹递归删除其下全部文件
-  **重命名 / 移动**：`b2_copy_file` + `b2_delete_file_version`，支持整文件夹迁移
-  **新建文件夹**：上传零字节 `.folderkeep` 占位文件
-  **拖拽上传**：拖到文件夹行上传到该文件夹，拖到其余区域上传到当前目录

### 预览与分享
-  **视频 / 音频 / 图片预览**：在独立可缩放、可全屏的窗口中打开，顶部显示实际使用的链接地址
-  **分享链接**：优先使用 Cloudflare 等代理生成免流隐藏链接，可自定义 URL 模板，一键复制

### 体验增强
-  **空间统计**：后台全量遍历统计桶已用空间，顶栏展示（缓存 + 后台刷新，点击徽标可手动刷新）
-  **传输队列**：右下角固定图标显示/隐藏面板，角标显示进行中任务数，下载项可随时取消
-  **内置配置向导**：首次启动填写 B2 凭据与代理设置，持久化到本地，无需 `.env`
-  类百度网盘的清爽 UI，自定义应用图标

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
│   │   └── settings.js        # 用户配置 + 空间统计缓存（userData/settings.json）
│   ├── renderer/              # 渲染进程（界面）
│   │   ├── index.html         # 主界面结构
│   │   ├── style.css          # 界面样式
│   │   ├── renderer.js        # 界面逻辑
│   │   ├── player.html        # 媒体/图片预览窗口
│   │   └── player.js          # 预览窗口逻辑
│   └── assets/                # 图标资源（应用图标、队列按钮图标）
├── package.json
└── .env                       # 仅开发期使用（可选），打包不携带
```

---

## ⚙️ 配置

### 方式一：应用内配置向导（推荐，打包后唯一方式）
首次启动会自动弹出配置向导，填写：

| 字段 | 说明 |
|---|---|
| Key ID | B2 应用密钥 ID |
| Application Key | B2 应用密钥 |
| Bucket ID | 存储桶 ID |
| Bucket Name | 存储桶名称 |
| 代理基地址 | 如 `https://b2.smmmax.top`（Cloudflare 代理，可选，留空则直连） |
| URL 模板 | 占位符 `{proxyBase}` / `{filePath}` / `{bucketName}`，默认 `{proxyBase}/{filePath}` |

配置保存在 `%APPDATA%\B2NetDisk\settings.json`，可随时在「⚙ 设置」中修改并即时生效。

### 方式二：开发期 `.env`（可选便利）
项目根目录放置 `.env`（已被 `.gitignore` 忽略，**不会打入安装包**）：

```env
B2_KEY_ID=你的KeyID
B2_APP_KEY=你的ApplicationKey
B2_BUCKET_ID=你的BucketID
B2_BUCKET_NAME=你的BucketName
B2_SHARE_URL=https://b2.smmmax.top
```
仅在 `settings.json` 首次创建时作为种子默认值，之后以应用内设置为准。

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
- 产物为 Windows NSIS 安装包，发布者署名为 **smmcat**
- 应用图标使用 `src/assets/b2_128x128.ico`
- 因未配置代码签名证书，`signAndEditExecutable` 设为 `false`（跳过 exe 版本资源改写，避免 winCodeSign 解压失败）
- 打包**不携带** `.env`，终端用户通过应用内向导配置凭据

---

##  说明

- **关于「剩余空间」**：B2 是按使用量付费、容量无上限的对象存储，无配额概念，因此只统计「已用空间」，不存在「剩余空间」。
- **空间统计**：B2 无官方用量接口，已用空间通过全量遍历文件累加 `contentLength` 得到；文件极多时统计较慢，故采用后台异步 + 本地缓存。
- **代理建议**：若直连下载出现 `fetch failed`（常见于网络环境 DNS 劫持 B2 下载域名），在设置中配置 Cloudflare 代理即可解决，同时实现免流。

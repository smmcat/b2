'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');

// 必须在创建任何窗口前设置：Windows 任务栏按 AppUserModelID 分组与取图标，
// 不设置会回退到 Electron 默认图标（固定到任务栏后尤其明显）
app.setAppUserModelId('com.smm.b2netdisk');

/**
 * 在多个候选位置查找 .env：
 * 1) userData（用户可覆盖，最高优先级）
 * 2) resourcesPath（打包后 extraResources 落点，与 app.asar 同级）
 * 3) app.getAppPath()（asar 内 / 开发期项目根）
 * 4) process.cwd()（兜底）
 */
function loadEnv() {
  const candidates = [];
  try { candidates.push(path.join(app.getPath('userData'), '.env')); } catch (_) {}
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, '.env'));
  try { candidates.push(path.join(app.getAppPath(), '.env')); } catch (_) {}
  candidates.push(path.join(process.cwd(), '.env'));

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      return p;
    }
  }
  return null;
}
loadEnv();

const { B2Client } = require('./b2');
const settings = require('./settings');

let mainWindow = null;
let b2 = null;
const activeDownloads = new Map(); // taskId -> { controller, name, filePath }
let downloadSeq = 0;

/* ---------- 空间统计（后台全量遍历 + 缓存） ---------- */
let usageRefreshing = false;
function getUsage() {
  const s = settings.get();
  return {
    bytes: s.usageBytes || 0,
    fileCount: s.usageFileCount || 0,
    computedAt: s.usageComputedAt || 0,
  };
}
async function refreshUsage(push = true) {
  if (!b2 || usageRefreshing) return;
  usageRefreshing = true;
  try {
    const u = await b2.getBucketUsage();
    settings.set({
      usageBytes: u.bytes,
      usageFileCount: u.fileCount,
      usageComputedAt: u.computedAt,
    });
    if (push && mainWindow) mainWindow.webContents.send('b2:usageUpdated', u);
  } catch (err) {
    console.error('空间统计失败:', err.message);
  } finally {
    usageRefreshing = false;
  }
}

function createB2Client() {
  const s = settings.get();
  // 优先用用户设置；.env 仅作为开发期兜底（打包后不存在 .env）
  return new B2Client({
    keyId: s.keyId || process.env.B2_KEY_ID,
    applicationKey: s.applicationKey || process.env.B2_APP_KEY,
    bucketId: s.bucketId || process.env.B2_BUCKET_ID,
    bucketName: s.bucketName || process.env.B2_BUCKET_NAME,
    shareUrlPrefix: '', // 不再从 .env 注入代理，统一由 settings.proxyBase 控制
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'B2 网盘',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

/* ---------------- IPC handlers ---------------- */

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('b2:progress', payload);
  }
}

ipcMain.handle('b2:bucketInfo', () => ({
  bucketName: process.env.B2_BUCKET_NAME || '',
  shareUrlPrefix: process.env.B2_SHARE_URL || '',
}));

ipcMain.handle('b2:listFiles', async (_e, prefix) => {
  try {
    return { ok: true, data: await b2.listFiles({ prefix: prefix || '' }) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('b2:selectAndUpload', async (_e, destPrefix) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要上传的文件',
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }
  const ok = [];
  const failed = [];
  for (const localPath of result.filePaths) {
    const base = path.basename(localPath);
    const b2Name = (destPrefix || '') + base;
    try {
      sendProgress({ type: 'upload', name: base, phase: 'start' });
      const r = await b2.uploadFile(localPath, b2Name, (loaded, total) => {
        sendProgress({ type: 'upload', name: base, phase: 'progress', loaded, total });
      });
      sendProgress({ type: 'upload', name: base, phase: 'done' });
      ok.push({ name: base, result: r });
    } catch (err) {
      sendProgress({ type: 'upload', name: base, phase: 'error', error: err.message });
      failed.push({ name: base, error: err.message });
    }
  }
  return { ok: true, uploaded: ok, failed };
});

ipcMain.handle('b2:upload', async (_e, { localPath, b2FileName }) => {
  try {
    const base = path.basename(localPath);
    sendProgress({ type: 'upload', name: base, phase: 'start' });
    const r = await b2.uploadFile(localPath, b2FileName, (loaded, total) => {
      sendProgress({ type: 'upload', name: base, phase: 'progress', loaded, total });
    });
    sendProgress({ type: 'upload', name: base, phase: 'done' });
    return { ok: true, result: r };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('b2:download', async (_e, { b2FileName, defaultName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存文件',
    defaultPath: defaultName || path.basename(b2FileName) || 'download',
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  const taskId = `dl_${Date.now().toString(36)}_${(downloadSeq++).toString(36)}`;
  const name = defaultName || path.basename(b2FileName) || 'download';
  const controller = new AbortController();
  activeDownloads.set(taskId, { controller, name, filePath: result.filePath });

  // 后台执行，立即返回 taskId，进度通过 b2:progress 推送
  (async () => {
    try {
      sendProgress({ type: 'download', taskId, name, phase: 'start' });
      await b2.downloadFile(
        b2FileName,
        result.filePath,
        (loaded, total) => sendProgress({ type: 'download', taskId, name, phase: 'progress', loaded, total }),
        settings.get(),
        controller.signal,
      );
      sendProgress({ type: 'download', taskId, name, phase: 'done' });
    } catch (err) {
      const aborted = err.name === 'AbortError' || /abort|cancel/i.test(err.message);
      // 失败或取消时清理已写入的部分文件
      try { fs.unlinkSync(result.filePath); } catch (_) { /* ignore */ }
      sendProgress({
        type: 'download', taskId, name,
        phase: aborted ? 'cancel' : 'error',
        error: aborted ? '已取消' : err.message,
      });
    } finally {
      activeDownloads.delete(taskId);
    }
  })();

  return { ok: true, taskId };
});

ipcMain.handle('b2:cancelDownload', (_e, taskId) => {
  const t = activeDownloads.get(taskId);
  if (t) {
    try { t.controller.abort(); } catch (_) {}
  }
  return { ok: true };
});

ipcMain.handle('b2:delete', async (_e, { fileName, fileId }) => {
  try {
    await b2.deleteFile(fileName, fileId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('b2:rename', async (_e, { oldName, newName }) => {
  try {
    await b2.renameFile(oldName, newName);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('b2:createFolder', async (_e, prefix) => {
  try {
    await b2.createFolder(prefix);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('b2:shareUrl', (_e, fileName) => {
  try {
    return { ok: true, url: b2.buildFileUrl(fileName, settings.get()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('b2:getSettings', () => ({ ok: true, data: settings.get() }));

ipcMain.handle('b2:getUsage', () => ({ ok: true, data: getUsage() }));

ipcMain.handle('b2:refreshUsage', async () => {
  await refreshUsage(true);
  return { ok: true, data: getUsage() };
});

ipcMain.handle('b2:saveSettings', (_e, patch) => {
  try {
    return { ok: true, data: settings.set(patch || {}) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('b2:previewUrl', async (_e, fileName) => {
  try {
    return { ok: true, url: await b2.getStreamUrl(fileName, settings.get()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 用户在向导中保存凭据后，通知主进程（重新）创建 B2 客户端
ipcMain.handle('b2:reinit', () => {
  try {
    const s = settings.get();
    if (!s.keyId || !s.applicationKey || !s.bucketId) {
      return { ok: false, error: '凭据不完整' };
    }
    b2 = createB2Client();
    setTimeout(refreshUsage, 1000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 在新窗口中播放媒体（可自由缩放、可全屏）
ipcMain.handle('b2:openPlayer', async (_e, { fileName }) => {
  try {
    if (!b2) return { ok: false, error: '未配置 B2' };
    const url = await b2.getStreamUrl(fileName, settings.get());
    const kind = mediaKind(fileName);
    const win = new BrowserWindow({
      width: 960,
      height: 640,
      minWidth: 480,
      minHeight: 360,
      title: path.basename(fileName),
      icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
      backgroundColor: '#000',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'player.html'), { query: { url, name: path.basename(fileName), kind } });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 把远程文件抓成 base64 dataURL（图片预览用，规避 CSP / 跨域 / 鉴权头问题）
ipcMain.handle('b2:fetchDataUrl', async (_e, { url }) => {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const mimeByExt = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  };
  const ext = (url.split('?')[0].split('.').pop() || '').toLowerCase();
  const mime = resp.headers.get('content-type')?.split(';')[0] || mimeByExt[ext] || 'application/octet-stream';
  const buf = Buffer.from(await resp.arrayBuffer());
  return `data:${mime};base64,${buf.toString('base64')}`;
});

/* ---------------- 分享页（sharedConfig.json + index.html） ---------------- */

const SHARE_MEDIA_EXTS = new Set([
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac',
  'mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv',
]);
function isShareMedia(name) {
  return SHARE_MEDIA_EXTS.has((name.split('.').pop() || '').toLowerCase());
}

function getArchives() {
  return settings.get().shareArchives || [];
}
function saveArchive(entry) {
  const list = getArchives().filter((a) => a.folder !== entry.folder);
  list.unshift(entry);
  settings.set({ shareArchives: list });
  return list;
}

// 列出某前缀下的直接子文件夹（供文件夹选择器逐级浏览）
// withConfigStatus=true 时，额外标注每个文件夹（及当前目录）是否包含 sharedConfig.json
ipcMain.handle('share:listFolders', async (_e, { prefix, withConfigStatus } = {}) => {
  try {
    const data = await b2.listFiles({ prefix: prefix || '' });
    const result = { ok: true, folders: data.folders.map((name) => ({ name })), hasConfig: false };
    if (!withConfigStatus) return result;

    // 当前目录是否含 sharedConfig.json
    result.hasConfig = data.files.some((f) => f.fileName === (prefix || '') + 'sharedConfig.json');
    // 各子文件夹是否含 sharedConfig.json（并行探测，文件夹数量通常不多）
    result.folders = await Promise.all(data.folders.map(async (name) => {
      try {
        const sub = await b2.listFiles({ prefix: (prefix || '') + name + '/' });
        return { name, hasConfig: sub.files.some((f) => f.fileName.endsWith('/sharedConfig.json')) };
      } catch (_) {
        return { name, hasConfig: false };
      }
    }));
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * 创建配置项：遍历目标文件夹，生成 sharedConfig.json 并上传到其根目录。
 * 结构：{ 子文件夹名: [{ title, url, createTime }...] }
 *  - 子文件夹按名称排序；每个子文件夹下的媒体文件按创建时间升序
 *  - 直接放在目标文件夹根部的媒体归入「未分类」
 */
ipcMain.handle('share:createConfig', async (_e, { folder }) => {
  try {
    if (!b2) return { ok: false, error: '未配置 B2' };
    const prefix = folder ? (folder.endsWith('/') ? folder : folder + '/') : '';
    const all = await b2.listAllFiles(prefix);
    const media = all.filter((f) => isShareMedia(f.fileName) && !f.fileName.endsWith('/sharedConfig.json'));

    const s = settings.get();
    const groups = {};
    for (const f of media) {
      const rel = f.fileName.substring(prefix.length);
      const idx = rel.indexOf('/');
      const cat = idx >= 0 ? rel.substring(0, idx) : '未分类';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push({
        title: rel.substring(idx >= 0 ? idx + 1 : 0),
        url: b2.buildFileUrl(f.fileName, s),
        createTime: f.uploadTimestamp || 0,
      });
    }

    const config = {};
    for (const cat of Object.keys(groups).sort((a, b) => a.localeCompare(b, 'zh-CN'))) {
      config[cat] = groups[cat].sort((a, b) => a.createTime - b.createTime);
    }

    const jsonName = prefix + 'sharedConfig.json';
    await b2.uploadText(JSON.stringify(config, null, 2), jsonName);

    const entry = {
      folder: prefix,
      title: (getArchives().find((a) => a.folder === prefix) || {}).title || '',
      notice: (getArchives().find((a) => a.folder === prefix) || {}).notice || '',
      folderCount: Object.keys(config).length,
      fileCount: media.length,
      updatedAt: Date.now(),
    };
    saveArchive(entry);
    return { ok: true, data: entry };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 读取并校验目标文件夹下的 sharedConfig.json，返回统计与 json 的实际访问链接
ipcMain.handle('share:readConfig', async (_e, { folder }) => {
  try {
    if (!b2) return { ok: false, error: '未配置 B2' };
    const prefix = folder ? (folder.endsWith('/') ? folder : folder + '/') : '';
    const jsonName = prefix + 'sharedConfig.json';
    const text = await b2.downloadText(jsonName, settings.get());
    if (text == null) return { ok: false, error: '该文件夹下不存在 sharedConfig.json，请先「创建配置项」' };

    // 格式合法性校验：必须是 { 分类名: [{ title, url, createTime }...] } 结构
    let config;
    try {
      config = JSON.parse(text);
    } catch (_) {
      return { ok: false, error: 'sharedConfig.json 不是合法的 JSON 文件' };
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { ok: false, error: 'sharedConfig.json 格式不正确：顶层应为 { 分类名: [...] } 对象' };
    }
    for (const [cat, arr] of Object.entries(config)) {
      if (!Array.isArray(arr)) {
        return { ok: false, error: `sharedConfig.json 格式不正确：分类「${cat}」的值应为数组` };
      }
      for (const it of arr) {
        if (!it || typeof it.title !== 'string' || typeof it.url !== 'string') {
          return { ok: false, error: `sharedConfig.json 格式不正确：分类「${cat}」中存在缺少 title/url 的条目` };
        }
      }
    }

    const fileCount = Object.values(config).reduce((n, arr) => n + arr.length, 0);
    // json 的对外访问链接：有代理走代理，否则 B2 原生地址（分享页运行时直接引用）
    const configUrl = b2.buildFileUrl(jsonName, settings.get());
    return { ok: true, data: { folderCount: Object.keys(config).length, fileCount, configUrl } };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('share:getArchives', () => ({ ok: true, data: getArchives() }));

ipcMain.handle('share:deleteArchive', (_e, folder) => {
  settings.set({ shareArchives: getArchives().filter((a) => a.folder !== folder) });
  return { ok: true };
});

// 生成分享页后，把标题/公告写回存档
ipcMain.handle('share:updateArchive', (_e, entry) => {
  try {
    return { ok: true, data: saveArchive(entry) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 把生成的 index.html 保存到用户本地
ipcMain.handle('share:saveHtml', async (_e, { html }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存分享页',
    defaultPath: 'index.html',
    filters: [{ name: 'HTML 页面', extensions: ['html'] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, html, 'utf-8');
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const _mediaExt = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
  video: ['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv'],
  audio: ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac'],
};
function mediaKind(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (_mediaExt.image.includes(ext)) return 'image';
  if (_mediaExt.video.includes(ext)) return 'video';
  if (_mediaExt.audio.includes(ext)) return 'audio';
  return 'video';
}

/* ---------------- App lifecycle ---------------- */

app.whenReady().then(() => {
  // 配置文件存放位置：打包后放安装目录（exe 同级），开发态放项目根目录
  const configDir = app.isPackaged ? path.dirname(process.execPath) : process.cwd();
  settings.init(configDir, app.getPath('userData'));

  // 仅在 settings.json 首次创建时，用 .env 填充默认值（开发便利；打包后无 .env 则跳过）
  if (settings.isNew()) {
    const patch = {};
    if (process.env.B2_KEY_ID) patch.keyId = process.env.B2_KEY_ID;
    if (process.env.B2_APP_KEY) patch.applicationKey = process.env.B2_APP_KEY;
    if (process.env.B2_BUCKET_ID) patch.bucketId = process.env.B2_BUCKET_ID;
    if (process.env.B2_BUCKET_NAME) patch.bucketName = process.env.B2_BUCKET_NAME;
    if (process.env.B2_SHARE_URL) patch.proxyBase = process.env.B2_SHARE_URL;
    if (Object.keys(patch).length) settings.set(patch);
  }

  // 凭据完整才创建客户端；否则由渲染层向导引导用户填写
  const s = settings.get();
  if (s.keyId && s.applicationKey && s.bucketId) {
    try {
      b2 = createB2Client();
    } catch (err) {
      dialog.showErrorBox('配置错误', `初始化失败：\n${err.message}`);
    }
  }
  createWindow();

  // 启动后后台刷新空间统计（不阻塞 UI，完成后推送到渲染层）
  if (b2) setTimeout(refreshUsage, 1500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

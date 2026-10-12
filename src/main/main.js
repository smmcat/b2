'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');

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
    icon: path.join(__dirname, '..', 'assets', 'b2_128x128.ico'),
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
      icon: path.join(__dirname, '..', 'assets', 'b2_128x128.ico'),
      backgroundColor: '#000',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'player.html'), { query: { url, name: path.basename(fileName), kind } });
    return { ok: true };
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
  settings.init(app.getPath('userData'));

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

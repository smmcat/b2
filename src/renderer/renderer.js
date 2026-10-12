'use strict';

const $ = (id) => document.getElementById(id);

/* ---------- 状态 ---------- */
const state = {
  prefix: '',          // 当前目录前缀，如 '' 或 'docs/2024/'
  files: [],
  folders: [],
  renameTarget: null,  // { type:'file'|'folder', name }
  progress: new Map(), // key -> { type, name, loaded, total, phase }
};

/* ---------- 工具 ---------- */
function fmtSize(bytes) {
  if (bytes === 0 || bytes == null) return bytes === 0 ? '0 B' : '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
}
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fileIcon(name, isFolder) {
  if (isFolder) return '📁';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️',
    mp4: '🎬', mov: '🎬', avi: '🎬', mkv: '🎬', webm: '🎬', m4v: '🎬',
    mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵', m4a: '🎵', aac: '🎵',
    pdf: '📕', doc: '📘', docx: '📘', txt: '📄', md: '📄',
    xls: '📗', xlsx: '📗', csv: '📗',
    ppt: '📙', pptx: '📙',
    zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
    js: '📜', ts: '📜', html: '🌐', css: '🎨', json: '⚙️',
    exe: '⚙️', msi: '⚙️',
  };
  return map[ext] || '📄';
}

// 返回 'video' | 'audio' | 'image' | null（浏览器可预览的类型）
const VIDEO_EXTS = new Set(['mp4', 'webm', 'ogv', 'mov', 'm4v', 'mkv']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac']);
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
function mediaKind(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  return null;
}
let toastTimer = null;
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

/* ---------- 渲染 ---------- */
function renderBreadcrumb() {
  const el = $('breadcrumb');
  el.innerHTML = '';
  const parts = state.prefix ? state.prefix.replace(/\/$/, '').split('/') : [];
  const root = document.createElement('span');
  root.className = 'crumb root';
  root.textContent = '全部文件';
  root.onclick = () => navigate('');
  el.appendChild(root);
  let acc = '';
  for (const p of parts) {
    acc += p + '/';
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '›';
    el.appendChild(sep);
    const c = document.createElement('span');
    c.className = 'crumb';
    c.textContent = p;
    const prefix = acc;
    c.onclick = () => navigate(prefix);
    el.appendChild(c);
  }
}

function renderList() {
  const list = $('fileList');
  list.innerHTML = '';
  const total = state.folders.length + state.files.length;
  $('emptyTip').classList.toggle('hidden', total !== 0);

  for (const folder of state.folders) {
    list.appendChild(makeFolderRow(folder));
  }
  for (const file of state.files) {
    list.appendChild(makeFileRow(file));
  }
}

function makeFolderRow(folder) {
  const row = document.createElement('div');
  row.className = 'file-row folder-row';
  row.innerHTML = `
    <div class="col-name"><span class="icon">📁</span><span class="fname"></span></div>
    <div class="col-size">-</div>
    <div class="col-time">-</div>
    <div class="col-op">
      <button class="op-btn" data-act="open">打开</button>
      <button class="op-btn" data-act="renameFolder">重命名</button>
      <button class="op-btn danger" data-act="deleteFolder">删除</button>
    </div>`;
  row.querySelector('.fname').textContent = folder;
  row.querySelector('[data-act=open]').onclick = () => navigate(state.prefix + folder + '/');
  row.querySelector('[data-act=renameFolder]').onclick = () => openRenameModal('folder', folder);
  row.querySelector('[data-act=deleteFolder]').onclick = () => deleteFolder(folder);
  row.ondblclick = () => navigate(state.prefix + folder + '/');
  attachFolderDropHandlers(row, folder);
  return row;
}

function makeFileRow(file) {
  const row = document.createElement('div');
  row.className = 'file-row';
  const baseName = file.fileName.substring(state.prefix.length);
  const kind = mediaKind(baseName);
  const previewBtn = kind ? `<button class="op-btn" data-act="preview">预览</button>` : '';
  row.innerHTML = `
    <div class="col-name"><span class="icon"></span><span class="fname"></span></div>
    <div class="col-size"></div>
    <div class="col-time"></div>
    <div class="col-op">
      ${previewBtn}
      <button class="op-btn" data-act="download">下载</button>
      <button class="op-btn" data-act="share">分享</button>
      <button class="op-btn" data-act="rename">重命名</button>
      <button class="op-btn danger" data-act="delete">删除</button>
    </div>`;
  row.querySelector('.icon').textContent = fileIcon(baseName, false);
  row.querySelector('.fname').textContent = baseName;
  row.querySelector('.col-size').textContent = fmtSize(file.contentLength != null ? file.contentLength : file.size);
  row.querySelector('.col-time').textContent = fmtTime(file.uploadTimestamp);
  const pv = row.querySelector('[data-act=preview]');
  if (pv) pv.onclick = () => openPreview(file);
  row.querySelector('[data-act=download]').onclick = () => downloadFile(file);
  row.querySelector('[data-act=share]').onclick = () => shareFile(file);
  row.querySelector('[data-act=rename]').onclick = () => openRenameModal('file', baseName);
  row.querySelector('[data-act=delete]').onclick = () => deleteFile(file);
  // 双击：媒体文件打开预览，其余不做特殊处理
  if (kind) row.ondblclick = () => openPreview(file);
  return row;
}

/* ---------- 数据加载 ---------- */
async function loadList() {
  $('loadingTip').classList.remove('hidden');
  $('fileList').innerHTML = '';
  const res = await window.b2api.listFiles(state.prefix);
  $('loadingTip').classList.add('hidden');
  if (!res.ok) {
    toast('加载失败：' + res.error, 'error');
    state.folders = []; state.files = [];
  } else {
    state.folders = res.data.folders;
    state.files = res.data.files;
  }
  renderBreadcrumb();
  renderList();
}

function navigate(prefix) {
  state.prefix = prefix;
  loadList();
}

/* ---------- 操作 ---------- */
$('btnUpload').onclick = async () => {
  const res = await window.b2api.selectAndUpload(state.prefix);
  if (res.canceled) return;
  if (!res.ok) { toast('上传失败：' + res.error, 'error'); return; }
  if (res.failed && res.failed.length) {
    toast(`${res.uploaded.length} 个成功，${res.failed.length} 个失败`, 'error');
  } else {
    toast(`成功上传 ${res.uploaded.length} 个文件`, 'success');
  }
  loadList();
};

$('btnRefresh').onclick = loadList;

$('btnNewFolder').onclick = () => {
  $('folderInput').value = '';
  $('folderModal').classList.remove('hidden');
  $('folderInput').focus();
};
$('folderCancel').onclick = () => $('folderModal').classList.add('hidden');
$('folderOk').onclick = async () => {
  const name = $('folderInput').value.trim();
  if (!name) return;
  if (name.includes('/')) { toast('文件夹名不能包含 /', 'error'); return; }
  $('folderModal').classList.add('hidden');
  const prefix = state.prefix + name;
  const res = await window.b2api.createFolder(prefix);
  if (res.ok) { toast('文件夹已创建', 'success'); loadList(); }
  else toast('创建失败：' + res.error, 'error');
};

async function downloadFile(file) {
  const baseName = file.fileName.substring(state.prefix.length);
  const res = await window.b2api.downloadFile(file.fileName, baseName);
  if (res.canceled) return; // 用户取消了保存对话框
  if (!res.ok && res.error) toast('下载失败：' + res.error, 'error');
  // 成功入队后，完成/失败提示由进度事件统一推送
}

async function shareFile(file) {
  const res = await window.b2api.getShareUrl(file.fileName);
  if (!res.ok) { toast('获取失败：' + res.error, 'error'); return; }
  try {
    await navigator.clipboard.writeText(res.url);
    toast('分享链接已复制到剪贴板', 'success');
  } catch (_) {
    prompt('分享链接：', res.url);
  }
}

async function deleteFile(file) {
  const baseName = file.fileName.substring(state.prefix.length);
  if (!confirm(`确定删除文件「${baseName}」？此操作不可恢复。`)) return;
  const res = await window.b2api.deleteFile(file.fileName, file.fileId);
  if (res.ok) { toast('已删除', 'success'); loadList(); }
  else toast('删除失败：' + res.error, 'error');
}

async function deleteFolder(folder) {
  if (!confirm(`确定删除文件夹「${folder}」及其所有内容？此操作不可恢复。`)) return;
  const prefix = state.prefix + folder + '/';
  const res = await window.b2api.deleteFile(prefix, null);
  if (res.ok) { toast('文件夹已删除', 'success'); loadList(); }
  else toast('删除失败：' + res.error, 'error');
}

/* ---------- 重命名 ---------- */
function openRenameModal(type, baseName) {
  state.renameTarget = { type, baseName };
  $('renameInput').value = baseName;
  $('renameModal').classList.remove('hidden');
  $('renameInput').focus();
  $('renameInput').select();
}
$('renameCancel').onclick = () => $('renameModal').classList.add('hidden');
$('renameOk').onclick = async () => {
  const newName = $('renameInput').value.trim();
  const { type, baseName } = state.renameTarget;
  if (!newName || newName === baseName) { $('renameModal').classList.add('hidden'); return; }
  if (newName.includes('/')) { toast('名称不能包含 /', 'error'); return; }
  $('renameModal').classList.add('hidden');

  if (type === 'file') {
    const oldFull = state.prefix + baseName;
    const newFull = state.prefix + newName;
    const res = await window.b2api.renameFile(oldFull, newFull);
    if (res.ok) { toast('重命名成功', 'success'); loadList(); }
    else toast('重命名失败：' + res.error, 'error');
  } else {
    // 文件夹重命名：遍历其下所有文件，逐个 copy + delete
    toast('正在处理文件夹重命名…');
    const listRes = await window.b2api.listFiles(state.prefix + baseName + '/');
    if (!listRes.ok) { toast('读取失败：' + listRes.error, 'error'); return; }
    const allFiles = await collectAllFiles(state.prefix + baseName + '/');
    let okCount = 0, failCount = 0;
    for (const f of allFiles) {
      const rel = f.fileName.substring((state.prefix + baseName + '/').length);
      const newFull = state.prefix + newName + '/' + rel;
      const r = await window.b2api.renameFile(f.fileName, newFull);
      if (r.ok) okCount++; else failCount++;
    }
    // 占位文件
    const keepOld = state.prefix + baseName + '/.folderkeep';
    const keepNew = state.prefix + newName + '/.folderkeep';
    if (allFiles.some((f) => f.fileName === keepOld)) {
      await window.b2api.renameFile(keepOld, keepNew);
    }
    toast(`完成：成功 ${okCount}，失败 ${failCount}`, failCount ? 'error' : 'success');
    loadList();
  }
};

// 递归收集某前缀下所有文件
async function collectAllFiles(prefix, acc = []) {
  const res = await window.b2api.listFiles(prefix);
  if (!res.ok) return acc;
  for (const f of res.data.files) acc.push(f);
  for (const folder of res.data.folders) {
    await collectAllFiles(prefix + folder + '/', acc);
  }
  return acc;
}

/* ---------- 进度面板 ---------- */
let panelHidden = false;

function renderProgress() {
  const panel = $('progressPanel');
  const list = $('ppList');
  const badge = $('ppBadge');
  const items = [...state.progress.values()];
  const activeCount = items.filter((p) => p.phase === 'start' || p.phase === 'progress').length;

  // 角标：仅统计进行中的任务
  if (activeCount > 0) {
    badge.textContent = activeCount > 99 ? '99+' : String(activeCount);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  if (items.length === 0 || panelHidden) {
    panel.classList.add('hidden');
  } else {
    panel.classList.remove('hidden');
  }
  list.innerHTML = '';
  for (const p of items) {
    const div = document.createElement('div');
    const isCancel = p.phase === 'cancel';
    div.className = 'pp-item' + (p.phase === 'done' ? ' done' : (p.phase === 'error' || isCancel) ? ' error' : '');
    const pct = p.total ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0;
    let label = '准备中…';
    if (p.phase === 'done') label = '完成';
    else if (p.phase === 'error') label = '失败';
    else if (isCancel) label = '已取消';
    else if (p.total) label = `${fmtSize(p.loaded)} / ${fmtSize(p.total)} (${pct}%)`;

    const canCancel = p.type === 'download' && p.taskId && (p.phase === 'start' || p.phase === 'progress');
    div.innerHTML = `
      <div class="pp-name">
        <span title="${p.name}">${p.type === 'upload' ? '⬆' : '⬇'} ${p.name}</span>
        <span class="pp-label">${label}${canCancel ? `<button class="pp-cancel" data-tid="${p.taskId}">✕</button>` : ''}</span>
      </div>
      <div class="pp-bar"><div class="pp-bar-fill" style="width:${pct}%"></div></div>`;
    const btn = div.querySelector('.pp-cancel');
    if (btn) btn.onclick = () => window.b2api.cancelDownload(p.taskId);
    list.appendChild(div);
  }
}
$('ppClose').onclick = () => { panelHidden = true; renderProgress(); };
$('ppToggle').onclick = () => { panelHidden = !panelHidden; renderProgress(); };

window.b2api.onProgress((payload) => {
  const key = payload.taskId ? payload.type + ':' + payload.taskId : payload.type + ':' + payload.name;
  if (payload.phase === 'start') {
    state.progress.set(key, { ...payload, loaded: 0, total: 0 });
    panelHidden = false; // 新任务自动展开面板
  } else if (payload.phase === 'progress') {
    const cur = state.progress.get(key) || { type: payload.type, name: payload.name, taskId: payload.taskId };
    cur.loaded = payload.loaded; cur.total = payload.total; cur.phase = 'progress';
    state.progress.set(key, cur);
  } else if (payload.phase === 'done' || payload.phase === 'error' || payload.phase === 'cancel') {
    const cur = state.progress.get(key) || { type: payload.type, name: payload.name, taskId: payload.taskId };
    cur.phase = payload.phase;
    if (payload.phase === 'done') cur.loaded = cur.total || cur.loaded;
    cur.error = payload.error;
    state.progress.set(key, cur);
    // 状态提示
    if (payload.phase === 'done') toast(`${cur.name} 下载完成`, 'success');
    else if (payload.phase === 'error') toast(`${cur.name} 下载失败：${payload.error || ''}`, 'error');
    else if (payload.phase === 'cancel') toast(`${cur.name} 已取消`, '');
    setTimeout(() => { state.progress.delete(key); renderProgress(); }, 4000);
  }
  renderProgress();
});

/* ---------- 媒体预览（新窗口） ---------- */
async function openPreview(file) {
  const res = await window.b2api.openPlayer(file.fileName);
  if (!res.ok) toast('打开播放器失败：' + res.error, 'error');
}

/* ---------- 设置 / 配置向导 ---------- */
function openSettingsModal(isFirstRun) {
  $('settingsTitle').textContent = isFirstRun ? '👋 首次配置' : '⚙ 设置';
  $('setupIntro').style.display = isFirstRun ? '' : 'none';
  $('settingsCancel').style.display = isFirstRun ? 'none' : '';
  window.b2api.getSettings().then((res) => {
    const s = (res && res.ok) ? res.data : {};
    $('setKeyId').value = s.keyId || '';
    $('setAppKey').value = s.applicationKey || '';
    $('setBucketId').value = s.bucketId || '';
    $('setBucketName').value = s.bucketName || '';
    $('setProxyBase').value = s.proxyBase || '';
    $('setTemplate').value = s.urlTemplate || '{proxyBase}/{filePath}';
    $('settingsModal').classList.remove('hidden');
    $('setKeyId').focus();
  });
}
$('btnSettings').onclick = () => openSettingsModal(false);
$('settingsCancel').onclick = () => $('settingsModal').classList.add('hidden');
$('settingsOk').onclick = async () => {
  const keyId = $('setKeyId').value.trim();
  const applicationKey = $('setAppKey').value.trim();
  const bucketId = $('setBucketId').value.trim();
  const bucketName = $('setBucketName').value.trim();
  if (!keyId || !applicationKey || !bucketId || !bucketName) {
    toast('请填写完整的 B2 配置项', 'error');
    return;
  }
  const patch = {
    keyId, applicationKey, bucketId, bucketName,
    proxyBase: $('setProxyBase').value.trim().replace(/\/+$/, ''),
    urlTemplate: $('setTemplate').value.trim() || '{proxyBase}/{filePath}',
  };
  const res = await window.b2api.saveSettings(patch);
  if (!res.ok) { toast('保存失败：' + res.error, 'error'); return; }
  const re = await window.b2api.reinit();
  $('settingsModal').classList.add('hidden');
  if (!re.ok) { toast('配置生效失败：' + re.error, 'error'); return; }
  toast('配置已保存并生效', 'success');
  $('bucketName').textContent = bucketName ? `📦 ${bucketName}` : '';
  state.prefix = '';
  loadList();
};

/* ---------- 拖拽上传 ---------- */
let dragTargetFolder = null; // 当前拖拽悬停的文件夹名（相对当前目录）

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer.files || [])].filter((f) => f.path);
  if (!files.length) return;
  handleDroppedFiles(files);
});

// 文件夹行的拖放高亮与目标识别
function attachFolderDropHandlers(rowEl, folderName) {
  rowEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragTargetFolder = folderName;
    rowEl.style.background = '#d9ecff';
  });
  rowEl.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  rowEl.addEventListener('dragleave', () => {
    if (dragTargetFolder === folderName) dragTargetFolder = null;
    rowEl.style.background = '';
  });
  rowEl.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    rowEl.style.background = '';
    dragTargetFolder = null;
    const files = [...(e.dataTransfer.files || [])].filter((f) => f.path);
    if (!files.length) return;
    handleDroppedFiles(files, state.prefix + folderName + '/');
  });
}

async function handleDroppedFiles(files, targetPrefix) {
  const destPrefix = targetPrefix != null ? targetPrefix : state.prefix;
  let okCount = 0, failCount = 0;
  for (const f of files) {
    const b2Name = destPrefix + f.name;
    sendProg({ type: 'upload', name: f.name, phase: 'start' });
    const res = await window.b2api.uploadLocalFile(f.path, b2Name);
    if (res.ok) { okCount++; sendProg({ type: 'upload', name: f.name, phase: 'done' }); }
    else { failCount++; sendProg({ type: 'upload', name: f.name, phase: 'error', error: res.error }); }
  }
  toast(`拖拽上传完成：成功 ${okCount}，失败 ${failCount}`, failCount ? 'error' : 'success');
  loadList();
}

function sendProg(p) {
  // 直接复用主进程推送的同结构，这里手动补一条开始/结束事件以驱动进度面板
  const key = p.type + ':' + p.name;
  if (p.phase === 'start') state.progress.set(key, { ...p, loaded: 0, total: 0 });
  else if (p.phase === 'done') { const c = state.progress.get(key) || p; c.phase = 'done'; state.progress.set(key, c);
    setTimeout(() => { state.progress.delete(key); renderProgress(); }, 5000); }
  else if (p.phase === 'error') { const c = state.progress.get(key) || p; c.phase = 'error'; c.error = p.error; state.progress.set(key, c);
    setTimeout(() => { state.progress.delete(key); renderProgress(); }, 5000); }
  renderProgress();
}

/* ---------- 空间统计展示 ---------- */
function fmtUsage(u) {
  if (!u || (!u.bytes && !u.fileCount && !u.computedAt)) return '已用 --';
  const when = u.computedAt
    ? new Date(u.computedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : '';
  return `💾 已用 ${fmtSize(u.bytes)} · ${u.fileCount} 个文件${when ? `（${when}）` : ''}`;
}
function renderUsage(u) {
  $('usageInfo').textContent = fmtUsage(u);
  $('usageInfo').classList.remove('refreshing');
}
$('usageInfo').onclick = async () => {
  if ($('usageInfo').classList.contains('refreshing')) return;
  $('usageInfo').classList.add('refreshing');
  $('usageInfo').textContent = '统计中…';
  const res = await window.b2api.refreshUsage();
  if (res && res.ok) renderUsage(res.data);
  else { toast('统计失败：' + (res.error || ''), 'error'); renderUsage(await window.b2api.getUsage().then(r => r.data)); }
};
window.b2api.onUsageUpdated((u) => renderUsage(u));

/* ---------- 启动 ---------- */
(async () => {
  const res = await window.b2api.getSettings();
  const s = (res && res.ok) ? res.data : {};
  const configured = s.keyId && s.applicationKey && s.bucketId && s.bucketName;
  $('bucketName').textContent = s.bucketName ? `📦 ${s.bucketName}` : '';
  // 先显示缓存的空间统计，后台刷新完成后由 onUsageUpdated 更新
  const u = await window.b2api.getUsage();
  if (u && u.ok) renderUsage(u.data);
  if (configured) {
    loadList();
  } else {
    openSettingsModal(true);
  }
})();

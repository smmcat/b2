'use strict';

const $ = (id) => document.getElementById(id);

/* ---------- 状态 ---------- */
const state = {
  prefix: '',          // 当前目录前缀，如 '' 或 'docs/2024/'
  files: [],
  folders: [],
  versions: {},        // fileName -> [version...]（多版本文件的历史版本，按时间倒序）
  expandedVersions: new Set(), // 已展开版本列表的 fileName
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
    // 已展开的多版本文件：在文件行下方追加各历史版本行
    const versions = state.versions[file.fileName] || [];
    if (versions.length > 1 && state.expandedVersions.has(file.fileName)) {
      versions.forEach((v, idx) => list.appendChild(makeVersionRow(file, v, idx === 0)));
    }
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
      <button class="op-btn" data-act="moveFolder">移动</button>
      <button class="op-btn danger" data-act="deleteFolder">删除</button>
    </div>`;
  row.querySelector('.fname').textContent = folder;
  row.querySelector('[data-act=open]').onclick = () => navigate(state.prefix + folder + '/');
  row.querySelector('[data-act=renameFolder]').onclick = () => openRenameModal('folder', folder);
  row.querySelector('[data-act=moveFolder]').onclick = () => openMovePicker('folder', folder);
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
  const versions = state.versions[file.fileName] || [];
  const multi = versions.length > 1;
  const expanded = state.expandedVersions.has(file.fileName);
  const previewBtn = kind ? `<button class="op-btn" data-act="preview">预览</button>` : '';
  row.innerHTML = `
    <div class="col-name"><span class="ver-expander${multi ? ' show' : ''}">${expanded ? '▾' : '▸'}</span><span class="icon"></span><span class="fname"></span>${multi ? `<span class="ver-badge">(${versions.length})</span>` : ''}</div>
    <div class="col-size"></div>
    <div class="col-time"></div>
    <div class="col-op">
      ${previewBtn}
      <button class="op-btn" data-act="download">下载</button>
      <button class="op-btn" data-act="share">分享</button>
      <button class="op-btn" data-act="rename">重命名</button>
      <button class="op-btn" data-act="move">移动</button>
      <button class="op-btn danger" data-act="delete">${multi ? '删除所有' : '删除'}</button>
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
  row.querySelector('[data-act=move]').onclick = () => openMovePicker('file', baseName);
  row.querySelector('[data-act=delete]').onclick = () => deleteFile(file);
  // 多版本文件：点击箭头展开/收起历史版本列表
  if (multi) {
    row.querySelector('.ver-expander').onclick = () => {
      if (expanded) state.expandedVersions.delete(file.fileName);
      else state.expandedVersions.add(file.fileName);
      renderList();
    };
  }
  // 双击：媒体文件打开预览，其余不做特殊处理
  if (kind) row.ondblclick = () => openPreview(file);
  // 拖动文件名到文件夹行 = 移动（放在名称列上，避免拖动时误触发操作按钮）
  const nameCell = row.querySelector('.col-name');
  nameCell.draggable = true;
  nameCell.title = '拖动到文件夹可移动';
  nameCell.addEventListener('dragstart', (e) => {
    dragSourceFile = file.fileName;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', baseName);
    row.classList.add('dragging');
  });
  nameCell.addEventListener('dragend', () => {
    dragSourceFile = null;
    row.classList.remove('dragging');
  });
  return row;
}

// 单个历史版本行（展示在展开的文件行下方）
function makeVersionRow(file, ver, isLatest) {
  const row = document.createElement('div');
  row.className = 'file-row version-row';
  row.innerHTML = `
    <div class="col-name"><span class="ver-label${isLatest ? ' latest' : ''}">${isLatest ? '当前版本' : '历史版本'}</span></div>
    <div class="col-size"></div>
    <div class="col-time"></div>
    <div class="col-op">
      <button class="op-btn" data-act="dlVer">下载</button>
      <button class="op-btn" data-act="shareVer">分享</button>
      <button class="op-btn danger" data-act="delVer">删除</button>
    </div>`;
  row.querySelector('.col-size').textContent = fmtSize(ver.contentLength != null ? ver.contentLength : ver.size);
  row.querySelector('.col-time').textContent = fmtTime(ver.uploadTimestamp);
  row.querySelector('[data-act=dlVer]').onclick = () => downloadVersion(file, ver);
  row.querySelector('[data-act=shareVer]').onclick = () => shareFile(file, ver.fileId);
  row.querySelector('[data-act=delVer]').onclick = () => deleteVersion(file, ver);
  return row;
}

/* ---------- 数据加载 ---------- */
async function loadList() {
  $('loadingTip').classList.remove('hidden');
  $('fileList').innerHTML = '';
  // 版本信息拉取失败不阻塞文件列表展示
  const [res, verRes] = await Promise.all([
    window.b2api.listFiles(state.prefix),
    window.b2api.listFileVersions(state.prefix).catch(() => ({ ok: false })),
  ]);
  $('loadingTip').classList.add('hidden');
  if (!res.ok) {
    toast('加载失败：' + res.error, 'error');
    state.folders = []; state.files = [];
  } else {
    state.folders = res.data.folders;
    state.files = res.data.files;
  }
  state.versions = (verRes && verRes.ok) ? verRes.data : {};
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
  autoUpdateShareConfig();
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

// 下载指定历史版本
async function downloadVersion(file, ver) {
  const baseName = file.fileName.substring(state.prefix.length);
  const res = await window.b2api.downloadFile(file.fileName, baseName, ver.fileId);
  if (res.canceled) return;
  if (!res.ok && res.error) toast('下载失败：' + res.error, 'error');
}

async function shareFile(file, fileId) {
  const res = await window.b2api.getShareUrl(file.fileName, fileId);
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
  const versions = state.versions[file.fileName] || [];
  if (versions.length > 1) {
    // 多版本文件：删除所有版本
    if (!confirm(`「${baseName}」共有 ${versions.length} 个版本，确定全部删除？此操作不可恢复。`)) return;
    let ok = 0, fail = 0;
    for (const v of versions) {
      const r = await window.b2api.deleteFile(file.fileName, v.fileId);
      if (r.ok) ok++; else fail++;
    }
    state.expandedVersions.delete(file.fileName);
    toast(fail ? `删除完成：成功 ${ok}，失败 ${fail}` : `已删除全部 ${ok} 个版本`, fail ? 'error' : 'success');
    loadList();
    autoUpdateShareConfig();
    return;
  }
  if (!confirm(`确定删除文件「${baseName}」？此操作不可恢复。`)) return;
  const res = await window.b2api.deleteFile(file.fileName, file.fileId);
  if (res.ok) { toast('已删除', 'success'); loadList(); autoUpdateShareConfig(); }
  else toast('删除失败：' + res.error, 'error');
}

// 删除单个历史版本
async function deleteVersion(file, ver) {
  const baseName = file.fileName.substring(state.prefix.length);
  if (!confirm(`确定删除「${baseName}」的该版本（上传于 ${fmtTime(ver.uploadTimestamp)}）？此操作不可恢复。`)) return;
  const res = await window.b2api.deleteFile(file.fileName, ver.fileId);
  if (res.ok) { toast('已删除该版本', 'success'); loadList(); autoUpdateShareConfig(); }
  else toast('删除失败：' + res.error, 'error');
}

async function deleteFolder(folder) {
  if (!confirm(`确定删除文件夹「${folder}」及其所有内容？此操作不可恢复。`)) return;
  const prefix = state.prefix + folder + '/';
  const res = await window.b2api.deleteFile(prefix, null);
  if (res.ok) { toast('文件夹已删除', 'success'); loadList(); autoUpdateShareConfig(); }
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
    if (res.ok) { toast('重命名成功', 'success'); loadList(); autoUpdateShareConfig(); }
    else toast('重命名失败：' + res.error, 'error');
  } else {
    // 文件夹重命名：递归列出全部对象（含 .folderkeep 占位），逐个 copy + delete
    toast('正在处理文件夹重命名…');
    const srcPrefix = state.prefix + baseName + '/';
    const destPrefix = state.prefix + newName + '/';
    const listRes = await window.b2api.listAllFiles(srcPrefix);
    if (!listRes.ok) { toast('读取失败：' + listRes.error, 'error'); return; }
    const allFiles = listRes.data;
    let okCount = 0, failCount = 0;
    for (const f of allFiles) {
      const rel = f.fileName.substring(srcPrefix.length);
      const r = await window.b2api.renameFile(f.fileName, destPrefix + rel);
      if (r.ok) okCount++; else failCount++;
    }
    toast(`完成：成功 ${okCount}，失败 ${failCount}`, failCount ? 'error' : 'success');
    loadList();
  }
};

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

/* ---------- 移动 ---------- */
// 阻塞式遮罩：耗时请求期间禁止交互，避免用户重复点击产生误解
function showBusy(text) {
  $('busyText').textContent = text || '处理中…';
  $('busyMask').classList.remove('hidden');
}
function hideBusy() {
  $('busyMask').classList.add('hidden');
}

function openMovePicker(type, baseName) {
  const title = `${type === 'folder' ? '移动文件夹' : '移动文件'}「${baseName}」到目标文件夹`;
  openFolderPicker(title, state.prefix, (destPrefix) => moveEntry(type, baseName, destPrefix));
}

async function moveEntry(type, baseName, destPrefix) {
  const srcFull = state.prefix + baseName;
  if (type === 'file') {
    const destFull = destPrefix + baseName;
    if (destFull === srcFull) { toast('文件已在该文件夹中'); return; }
    let ok = false, msg = '';
    showBusy('正在移动文件…');
    try {
      const res = await window.b2api.moveFile(srcFull, destFull);
      ok = !!res.ok;
      msg = ok ? `移动成功（含 ${res.data.versions} 个版本）` : `移动失败：${res.error}`;
      if (ok) await loadList(); // 保持遮罩直到列表刷新完，避免旧列表被误操作
    } finally {
      hideBusy();
    }
    toast(msg, ok ? 'success' : 'error');
    if (ok) autoUpdateShareConfig([destPrefix]);
    return;
  }

  // 文件夹：禁止移动到自身、其子目录或原地
  const srcPrefix = srcFull + '/';
  const destPrefixFull = destPrefix + baseName + '/';
  if (destPrefixFull === srcPrefix || destPrefixFull.startsWith(srcPrefix) || destPrefix === state.prefix) {
    toast('不能移动到自身、其子文件夹或当前位置', 'error');
    return;
  }

  let okCount = 0, failCount = 0;
  showBusy('正在移动文件夹…');
  try {
    const listRes = await window.b2api.listAllFiles(srcPrefix);
    if (!listRes.ok) { toast('读取失败：' + listRes.error, 'error'); return; }
    const allFiles = listRes.data; // 含 .folderkeep 占位，保证空子目录也能整体迁移
    if (!allFiles.length) { toast('该文件夹为空或读取失败', 'error'); return; }
    for (const f of allFiles) {
      const rel = f.fileName.substring(srcPrefix.length);
      const r = await window.b2api.moveFile(f.fileName, destPrefixFull + rel);
      if (r.ok) okCount++; else failCount++;
    }
    await loadList();
  } finally {
    hideBusy();
  }
  toast(`移动完成：成功 ${okCount}，失败 ${failCount}`, failCount ? 'error' : 'success');
  autoUpdateShareConfig([destPrefix]);
}

/* ---------- 拖拽上传 ---------- */
let dragSourceFile = null;   // 正在拖动的库内文件完整对象名（拖拽移动用）
let dropHighlightEl = null;  // 当前高亮的文件夹行（同一时刻只保留一个，避免拖动轨迹上残留高亮）

// 同一时刻只高亮一个目标行
function setDropHighlight(el) {
  if (dropHighlightEl === el) return;
  if (dropHighlightEl) dropHighlightEl.classList.remove('drop-target');
  dropHighlightEl = el;
  if (el) el.classList.add('drop-target');
}

// 拖拽结束（含放到空白处、按 ESC 取消）统一清理，避免高亮残留
window.addEventListener('dragend', () => {
  dragSourceFile = null;
  setDropHighlight(null);
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = dragSourceFile ? 'move' : 'copy';
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (dragSourceFile) return; // 库内文件拖拽：未落在文件夹行上则忽略
  const files = [...(e.dataTransfer.files || [])].filter((f) => f.path);
  if (!files.length) return;
  handleDroppedFiles(files);
});

// 文件夹行的拖放高亮与目标识别
function attachFolderDropHandlers(rowEl, folderName) {
  rowEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    setDropHighlight(rowEl);
  });
  rowEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = dragSourceFile ? 'move' : 'copy';
    // 相邻行切换时 dragenter 可能先于上一行的 dragleave 发生，这里兜底保证高亮跟着走
    if (dropHighlightEl !== rowEl) setDropHighlight(rowEl);
  });
  rowEl.addEventListener('dragleave', (e) => {
    // 在行内子元素之间移动不算离开，忽略，避免高亮闪烁
    if (e.relatedTarget && rowEl.contains(e.relatedTarget)) return;
    if (dropHighlightEl === rowEl) setDropHighlight(null);
  });
  rowEl.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDropHighlight(null);

    // 库内文件 → 移动到该文件夹
    if (dragSourceFile) {
      const srcFull = dragSourceFile;
      dragSourceFile = null;
      const destPrefix = state.prefix + folderName + '/';
      const base = srcFull.substring(state.prefix.length);
      moveEntry('file', base, destPrefix);
      return;
    }

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
  autoUpdateShareConfig([destPrefix]);
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

/* ==================== 分享页 ==================== */
const shareState = {
  pickPrefix: '',      // 文件夹选择器当前浏览前缀
  pickCallback: null,  // 选定后的回调
  pickRequireConfig: false, // 选择器是否要求目标文件夹必须含 sharedConfig.json
  pickHasConfig: false,     // 当前浏览目录是否含 sharedConfig.json
  genFolder: null,     // 待生成分享页的文件夹（规范化，带结尾 / 或 ''）
  genStats: null,      // readConfig 返回的统计
  genConfigUrl: '',    // sharedConfig.json 的实际访问链接（写入生成的 html）
};

function normalizeFolder(f) {
  if (!f) return '';
  return f.endsWith('/') ? f : f + '/';
}

/* ---------- 主菜单 ---------- */
$('btnSharePage').onclick = () => $('shareMenuModal').classList.remove('hidden');
$('shareMenuClose').onclick = () => $('shareMenuModal').classList.add('hidden');

/* ---------- 文件夹选择器 ---------- */
function openFolderPicker(title, startPrefix, cb, options = {}) {
  $('folderPickTitle').textContent = title;
  shareState.pickPrefix = startPrefix || '';
  shareState.pickCallback = cb;
  shareState.pickRequireConfig = !!options.requireConfig;
  shareState.pickHasConfig = false;
  $('folderPickModal').classList.remove('hidden');
  renderPickList();
}

function updatePickOkState() {
  const okBtn = $('folderPickOk');
  if (!shareState.pickRequireConfig) {
    okBtn.disabled = false;
    okBtn.textContent = '选择当前文件夹';
    return;
  }
  okBtn.disabled = !shareState.pickHasConfig;
  okBtn.textContent = shareState.pickHasConfig
    ? '选择当前文件夹（✓ 含 sharedConfig.json）'
    : '当前文件夹没有 sharedConfig.json';
}

async function renderPickList() {
  const crumb = $('folderPickCrumb');
  const list = $('folderPickList');
  crumb.innerHTML = '';
  list.innerHTML = '<div class="pick-empty">加载中…</div>';
  updatePickOkState();

  // 面包屑
  const root = document.createElement('span');
  root.className = 'crumb root';
  root.textContent = '全部文件';
  root.onclick = () => { shareState.pickPrefix = ''; renderPickList(); };
  crumb.appendChild(root);
  let acc = '';
  for (const p of (shareState.pickPrefix ? shareState.pickPrefix.replace(/\/$/, '').split('/') : [])) {
    acc += p + '/';
    const sep = document.createElement('span');
    sep.className = 'sep'; sep.textContent = '›';
    crumb.appendChild(sep);
    const c = document.createElement('span');
    c.className = 'crumb'; c.textContent = p;
    const prefix = acc;
    c.onclick = () => { shareState.pickPrefix = prefix; renderPickList(); };
    crumb.appendChild(c);
  }

  const res = await window.b2api.shareListFolders(shareState.pickPrefix, shareState.pickRequireConfig);
  list.innerHTML = '';
  if (!res.ok) {
    list.innerHTML = `<div class="pick-empty">加载失败：${res.error}</div>`;
    return;
  }

  shareState.pickHasConfig = !!res.hasConfig;
  updatePickOkState();

  if (!res.folders.length) {
    list.innerHTML = `<div class="pick-empty">${
      shareState.pickRequireConfig && !shareState.pickHasConfig
        ? '此目录及子目录均未找到 sharedConfig.json，请返回上级或先「创建配置项」'
        : '此目录下没有子文件夹'
    }</div>`;
    return;
  }
  for (const folder of res.folders) {
    const item = document.createElement('div');
    item.className = 'pick-item';
    const badge = shareState.pickRequireConfig
      ? (folder.hasConfig
        ? '<span class="pick-badge ok">✓ 含配置</span>'
        : '<span class="pick-badge none">无配置</span>')
      : '';
    item.innerHTML = `<span class="icon">📁</span><span></span>${badge}<span class="pick-enter">进入 ›</span>`;
    item.querySelector('span:nth-child(2)').textContent = folder.name;
    if (shareState.pickRequireConfig && !folder.hasConfig) item.classList.add('dim');
    item.onclick = () => {
      shareState.pickPrefix = shareState.pickPrefix + folder.name + '/';
      renderPickList();
    };
    list.appendChild(item);
  }
}

$('folderPickCancel').onclick = () => $('folderPickModal').classList.add('hidden');
$('folderPickOk').onclick = () => {
  if (shareState.pickRequireConfig && !shareState.pickHasConfig) {
    toast('当前文件夹没有 sharedConfig.json，请选择带「✓ 含配置」标记的文件夹', 'error');
    return;
  }
  $('folderPickModal').classList.add('hidden');
  const cb = shareState.pickCallback;
  shareState.pickCallback = null;
  if (cb) cb(normalizeFolder(shareState.pickPrefix));
};

/* ---------- 创建配置项 ---------- */
$('shareMenuCreate').onclick = () => {
  $('shareMenuModal').classList.add('hidden');
  openFolderPicker('选择要分享的文件夹（将在其根目录生成 sharedConfig.json）', '', async (folder) => {
    toast('正在扫描媒体文件并生成配置…');
    const res = await window.b2api.shareCreateConfig(folder);
    if (!res.ok) { toast('创建失败：' + res.error, 'error'); return; }
    const d = res.data;
    toast(`配置已生成：${d.folderCount} 个分类 · ${d.fileCount} 个媒体文件`, 'success');
  });
};

/* ---------- 生成分享页 ---------- */
$('shareMenuGenerate').onclick = () => {
  $('shareMenuModal').classList.add('hidden');
  openFolderPicker('选择 sharedConfig.json 所在的文件夹', '', (folder) => openShareGen(folder), { requireConfig: true });
};

async function openShareGen(folder) {
  const res = await window.b2api.shareReadConfig(folder);
  if (!res.ok) { toast(res.error, 'error'); return; }
  shareState.genFolder = folder;
  shareState.genStats = res.data;
  shareState.genConfigUrl = res.data.configUrl;

  // 预填存档中的标题/公告
  const arc = (await window.b2api.shareGetArchives()).data.find((a) => a.folder === folder);
  $('shareGenFolder').textContent =
    `引用配置：${res.data.configUrl}（${res.data.folderCount} 个分类 · ${res.data.fileCount} 个媒体文件）`;
  $('shareGenTitle').value = (arc && arc.title) || '';
  $('shareGenNotice').value = (arc && arc.notice) || '';
  $('shareGenModal').classList.remove('hidden');
  $('shareGenTitle').focus();
}

$('shareGenCancel').onclick = () => $('shareGenModal').classList.add('hidden');
$('shareGenOk').onclick = async () => {
  const title = $('shareGenTitle').value.trim() || '媒体分享';
  const notice = $('shareGenNotice').value.trim();
  const html = buildShareHtml({ title, notice, configUrl: shareState.genConfigUrl });
  const res = await window.b2api.shareSaveHtml(html);
  if (res.canceled) return;
  if (!res.ok) { toast('保存失败：' + res.error, 'error'); return; }
  // 标题/公告写回存档，便于下次更新
  await window.b2api.shareUpdateArchive({
    folder: shareState.genFolder,
    title,
    notice,
    folderCount: shareState.genStats.folderCount,
    fileCount: shareState.genStats.fileCount,
    updatedAt: Date.now(),
  });
  $('shareGenModal').classList.add('hidden');
  toast(`分享页已保存：${res.filePath}（与 sharedConfig.json 部署到同一目录即可）`, 'success');
};

/* ---------- 查看已存在分享页 ---------- */
$('shareMenuArchives').onclick = () => {
  $('shareMenuModal').classList.add('hidden');
  renderArchives();
  $('shareArchivesModal').classList.remove('hidden');
};
$('shareArchivesClose').onclick = () => $('shareArchivesModal').classList.add('hidden');

/* ---------- 自动同步分享配置 ---------- */
// 上传/删除/重命名/移动后调用：相关目录若属于某个分享存档范围，则后台自动重新生成其 sharedConfig.json
// 从存档列表里挑出覆盖 prefix 的最深层范围
function pickArchiveFor(list, prefix) {
  let best = null;
  for (const a of list) {
    const f = a.folder || '';
    if (prefix === f || prefix.startsWith(f)) {
      if (!best || f.length > (best.folder || '').length) best = a; // 取最深层匹配的存档
    }
  }
  return best;
}

async function findMatchingArchive() {
  const res = await window.b2api.shareGetArchives();
  return pickArchiveFor((res && res.ok) ? res.data : [], state.prefix);
}

/**
 * 重新生成受影响的 sharedConfig.json
 * @param {string[]} [extraPrefixes] 额外需要检查的目录（如移动操作的目标目录）
 */
async function autoUpdateShareConfig(extraPrefixes) {
  try {
    const res = await window.b2api.shareGetArchives();
    const list = (res && res.ok) ? res.data : [];
    const targets = new Set();
    for (const p of [state.prefix].concat(extraPrefixes || [])) {
      const a = pickArchiveFor(list, p);
      if (a) targets.add(a.folder);
    }
    if (!targets.size) return;
    let ok = 0, fileCount = 0;
    for (const folder of targets) {
      const r = await window.b2api.shareCreateConfig(folder);
      if (r.ok) { ok++; fileCount += r.data.fileCount; }
    }
    if (ok) toast(`已同步更新分享页配置（${ok} 个范围，${fileCount} 个媒体）`, 'success');
  } catch (_) { /* 静默失败，不影响主流程 */ }
}

/* ---------- 一键更新全部配置 ---------- */
$('shareArchivesRefreshAll').onclick = async () => {
  const res = await window.b2api.shareGetArchives();
  const list = (res && res.ok) ? res.data : [];
  if (!list.length) { toast('暂无存档记录'); return; }
  toast(`正在更新全部 ${list.length} 个配置…`);
  let ok = 0, fail = 0;
  for (const a of list) {
    const r = await window.b2api.shareCreateConfig(a.folder);
    if (r.ok) ok++; else fail++;
  }
  toast(`更新完成：成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}`, fail ? 'error' : 'success');
  renderArchives();
};

async function renderArchives() {
  const box = $('shareArchivesList');
  box.innerHTML = '<div class="pick-empty">加载中…</div>';
  const res = await window.b2api.shareGetArchives();
  const list = (res && res.ok) ? res.data : [];
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="pick-empty">暂无存档记录，请先「创建配置项」</div>';
    return;
  }
  for (const a of list) {
    const div = document.createElement('div');
    div.className = 'archive-item';
    div.innerHTML = `
      <div class="archive-info">
        <div class="archive-folder">📁 <b></b></div>
        <div class="archive-meta">
          ${a.folderCount} 个分类 · ${a.fileCount} 个媒体 · 更新于 ${fmtTime(a.updatedAt)}
          ${a.title ? ` · 标题「${a.title}」` : ''}
        </div>
      </div>
      <div class="archive-ops">
        <button class="op-btn" data-act="gen">生成分享页</button>
        <button class="op-btn" data-act="recreate">更新配置</button>
        <button class="op-btn danger" data-act="del">删除记录</button>
      </div>`;
    div.querySelector('b').textContent = a.folder || '/（桶根目录）';
    div.querySelector('[data-act=gen]').onclick = () => {
      $('shareArchivesModal').classList.add('hidden');
      openShareGen(a.folder);
    };
    div.querySelector('[data-act=recreate]').onclick = async () => {
      toast('正在重新扫描并更新配置…');
      const r = await window.b2api.shareCreateConfig(a.folder);
      if (r.ok) { toast(`配置已更新：${r.data.fileCount} 个媒体文件`, 'success'); renderArchives(); }
      else toast('更新失败：' + r.error, 'error');
    };
    div.querySelector('[data-act=del]').onclick = async () => {
      if (!confirm(`删除「${a.folder}」的存档记录？（不会删除云端的 sharedConfig.json）`)) return;
      await window.b2api.shareDeleteArchive(a.folder);
      renderArchives();
    };
    box.appendChild(div);
  }
}

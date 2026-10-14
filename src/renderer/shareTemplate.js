'use strict';

/**
 * 生成分享页 index.html（单文件，内嵌样式与脚本）。
 * 页面每次打开时 fetch 同目录下的 sharedConfig.json 动态渲染，
 * 因此更新 json 后无需重新生成 html。
 *
 * json 结构：{ 分类名: [{ title, url, createTime }...] }
 */

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildShareHtml({ title, notice, configUrl }) {
  const safeTitle = escapeHtml(title || '媒体分享');
  const safeNotice = escapeHtml(notice || '').replace(/\n/g, '<br/>');
  // json 的实际链接（代理或 B2 原生），嵌入页面后无论页面部署在哪都能正确拉取
  const safeConfigUrl = escapeHtml(configUrl || 'sharedConfig.json');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${safeTitle}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f0f2f5; color: #303133; min-height: 100vh;
  }
  .hero {
    background: linear-gradient(135deg, #4a7dff 0%, #6a5ae0 100%);
    color: #fff; padding: 48px 20px 40px; text-align: center;
  }
  .hero h1 { font-size: 30px; letter-spacing: 1px; }
  .hero .notice {
    margin: 14px auto 0; max-width: 720px; font-size: 14px; line-height: 1.8;
    background: rgba(255,255,255,.14); border-radius: 10px; padding: 12px 18px;
  }
  .hero .notice:empty { display: none; }
  .container { max-width: 860px; margin: 24px auto 60px; padding: 0 16px; }
  details.category {
    background: #fff; border-radius: 12px; margin-bottom: 16px;
    box-shadow: 0 2px 10px rgba(0,0,0,.05); overflow: hidden;
  }
  details.category summary {
    cursor: pointer; list-style: none; padding: 16px 20px;
    font-size: 17px; font-weight: 600; display: flex; align-items: center; gap: 10px;
    user-select: none; transition: background .15s;
  }
  details.category summary::-webkit-details-marker { display: none; }
  details.category summary:hover { background: #f7f9ff; }
  details.category summary .arrow { transition: transform .2s; font-size: 12px; color: #909399; }
  details.category[open] summary .arrow { transform: rotate(90deg); }
  details.category summary .count {
    margin-left: auto; font-size: 12px; font-weight: 400; color: #909399;
    background: #f0f2f5; border-radius: 10px; padding: 2px 10px;
  }
  .items { padding: 4px 20px 16px; }
  .item { padding: 14px 0; border-top: 1px solid #f0f2f5; }
  .item:first-child { border-top: none; }
  .item .item-title { font-size: 14px; margin-bottom: 4px; word-break: break-all; }
  .item .item-time { font-size: 12px; color: #a8abb2; margin-bottom: 8px; }
  .item audio, .item video { width: 100%; border-radius: 8px; outline: none; }
  .item video { max-height: 320px; background: #000; }
  .item img {
    display: block; max-width: 100%; max-height: 420px; border-radius: 8px;
    cursor: zoom-in; background: #f0f2f5;
  }
  .item .dl-btn {
    display: inline-block; padding: 8px 18px; border-radius: 8px;
    background: #07c160; color: #fff; text-decoration: none; font-size: 13px;
  }
  .item .dl-btn:hover { background: #06ad56; }
  /* 应用程序卡片：按平台配色区分（icon 底色/按钮同色） */
  .app-card {
    display: flex; align-items: center; gap: 12px;
    border-radius: 12px; padding: 12px 14px; border: 1px solid;
  }
  .app-card .app-ico {
    width: 42px; height: 42px; border-radius: 11px; flex: none;
    display: flex; align-items: center; justify-content: center; color: #fff;
  }
  .app-card .app-ico svg { width: 24px; height: 24px; }
  .app-card .app-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .app-card .app-plat { font-size: 13px; font-weight: 600; }
  .app-card .app-ext { font-size: 11px; color: #a8abb2; letter-spacing: .5px; }
  .app-card .app-dl {
    margin-left: auto; flex: none; padding: 7px 16px; border-radius: 8px;
    color: #fff; text-decoration: none; font-size: 13px;
  }
  .app-card.win { background: #e9f4fd; border-color: #c8e2f7; }
  .app-card.win .app-ico, .app-card.win .app-dl { background: #0078d6; }
  .app-card.win .app-dl:hover { background: #0b6ec2; }
  .app-card.mac { background: #f0f0f5; border-color: #dcdce6; }
  .app-card.mac .app-ico, .app-card.mac .app-dl { background: #3a3a44; }
  .app-card.mac .app-dl:hover { background: #26262e; }
  .app-card.android { background: #e7faf1; border-color: #c4f0da; }
  .app-card.android .app-ico, .app-card.android .app-dl { background: #3ddc84; }
  .app-card.android .app-dl:hover { background: #29c873; }
  .app-card.linux { background: #fdf5e3; border-color: #f5e3b8; }
  .app-card.linux .app-ico, .app-card.linux .app-dl { background: #e8a33d; }
  .app-card.linux .app-dl:hover { background: #d6932e; }
  .sort-bar {
    display: flex; align-items: center; gap: 6px;
    padding: 10px 20px 0; font-size: 12px; color: #909399;
  }
  .sort-bar select {
    font-size: 12px; color: #606266; border: 1px solid #dcdfe6;
    border-radius: 6px; padding: 3px 6px; background: #fff; cursor: pointer;
  }
  .status { text-align: center; color: #909399; padding: 60px 0; font-size: 14px; }
  footer { text-align: center; color: #c0c4cc; font-size: 12px; padding: 20px 0 30px; }
</style>
</head>
<body>
<header class="hero">
  <h1>${safeTitle}</h1>
  <div class="notice">${safeNotice}</div>
</header>
<div class="container" id="app">
  <div class="status">加载中…</div>
</div>
<footer>Powered by B2NetDisk</footer>
<script>
(function () {
  var CONFIG_URL = "${safeConfigUrl}";
  var AUDIO = { mp3: 1, wav: 1, ogg: 1, oga: 1, m4a: 1, aac: 1, flac: 1 };
  var VIDEO = { mp4: 1, webm: 1, ogv: 1, mov: 1, m4v: 1, mkv: 1 };
  var IMAGE = { jpg: 1, jpeg: 1, png: 1, gif: 1, webp: 1, bmp: 1, svg: 1, avif: 1, ico: 1 };
  var ARCHIVE = { zip: 1, rar: 1, '7z': 1, tar: 1, gz: 1, tgz: 1, bz2: 1, xz: 1 };
  // 应用程序安装包 → 平台（决定卡片配色与图标）
  var APP_PLATFORMS = [
    { key: 'win', name: 'Windows', exts: { exe: 1, msi: 1 },
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 5.4 10.5 4.3v7.2H3zM11.5 4.1 21 2.8v8.7h-9.5zM3 12.5h7.5v7.2L3 18.6zM11.5 12.5H21v8.7l-9.5-1.3z"/></svg>' },
    { key: 'mac', name: 'macOS', exts: { dmg: 1, pkg: 1 },
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.03 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701z"/></svg>' },
    { key: 'android', name: 'Android', exts: { apk: 1, aab: 1, xapk: 1 },
      icon: '<svg viewBox="0 0 24 24" fill="currentColor"><line x1="8.7" y1="3.7" x2="10" y2="5.9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><line x1="15.3" y1="3.7" x2="14" y2="5.9" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><path d="M6 11a6 6 0 0 1 12 0z"/><circle cx="9.3" cy="8.8" r=".9" fill="#3ddc84"/><circle cx="14.7" cy="8.8" r=".9" fill="#3ddc84"/><path d="M6 12.2h12v4.3a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 16.5z"/><rect x="3" y="11.7" width="2.1" height="6" rx="1.05"/><rect x="18.9" y="11.7" width="2.1" height="6" rx="1.05"/><rect x="8.7" y="19.2" width="2" height="2.6" rx="1"/><rect x="13.3" y="19.2" width="2" height="2.6" rx="1"/></svg>' },
    { key: 'linux', name: 'Linux', exts: { deb: 1, rpm: 1, appimage: 1 },
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="2.5"/><polyline points="7,9.5 10,12 7,14.5"/><line x1="12.5" y1="15" x2="17" y2="15"/></svg>' },
  ];
  function appPlatform(e) {
    for (var i = 0; i < APP_PLATFORMS.length; i++) {
      if (APP_PLATFORMS[i].exts[e]) return APP_PLATFORMS[i];
    }
    return null;
  }
  function appCard(p, url, e) {
    return '<div class="app-card ' + p.key + '">' +
      '<span class="app-ico">' + p.icon + '</span>' +
      '<span class="app-info"><span class="app-plat">' + p.name + ' 应用</span>' +
      '<span class="app-ext">' + e.toUpperCase() + ' 安装包</span></span>' +
      '<a class="app-dl" href="' + esc(url) + '" download rel="noopener">⬇ 下载</a></div>';
  }
  function ext(url) {
    var clean = url.split('?')[0];
    return (clean.split('.').pop() || '').toLowerCase();
  }
  function fmtTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  fetch(CONFIG_URL, { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (config) {
      var app = document.getElementById('app');
      app.innerHTML = '';
      var cats = Object.keys(config).sort(function (a, b) { return a.localeCompare(b, 'zh-CN'); });
      if (!cats.length) {
        app.innerHTML = '<div class="status">暂无内容</div>';
        return;
      }
      cats.forEach(function (cat, idx) {
        var items = Array.isArray(config[cat]) ? config[cat].slice() : [];
        var sortState = { key: 'time', dir: 'desc' }; // 默认：上传时间 · 递减（最新在前）

        var details = document.createElement('details');
        details.className = 'category';
        details.open = idx === 0; // 只展开首个分类，其余默认折叠
        var summary = document.createElement('summary');
        summary.innerHTML = '<span class="arrow">▶</span><span>' + esc(cat) + '</span>' +
          '<span class="count">' + items.length + ' 个</span>';
        details.appendChild(summary);

        // 排序工具栏：字段（上传时间/文件名）× 方向（递增/递减）
        var bar = document.createElement('div');
        bar.className = 'sort-bar';
        bar.innerHTML = '排序：' +
          '<select class="sort-key">' +
            '<option value="time" selected>上传时间</option>' +
            '<option value="name">文件名</option>' +
          '</select>' +
          '<select class="sort-dir">' +
            '<option value="asc">递增</option>' +
            '<option value="desc" selected>递减</option>' +
          '</select>';
        details.appendChild(bar);

        var wrap = document.createElement('div');
        wrap.className = 'items';
        details.appendChild(wrap);
        app.appendChild(details);

        function renderItems() {
          var sorted = items.slice().sort(function (a, b) {
            var r = sortState.key === 'name'
              ? String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN')
              : (a.createTime || 0) - (b.createTime || 0);
            return sortState.dir === 'desc' ? -r : r;
          });
          wrap.innerHTML = '';
          sorted.forEach(function (it) {
            var div = document.createElement('div');
            div.className = 'item';
            var e = ext(it.url || '');
            var ap = appPlatform(e);
            var player = AUDIO[e]
              ? '<audio controls preload="none" src="' + esc(it.url) + '"></audio>'
              : (VIDEO[e]
                ? '<video controls preload="none" src="' + esc(it.url) + '"></video>'
                : (IMAGE[e]
                  ? '<a href="' + esc(it.url) + '" target="_blank" rel="noopener" title="点击查看原图">' +
                    '<img loading="lazy" src="' + esc(it.url) + '" alt="' + esc(it.title) + '"></a>'
                  : (ARCHIVE[e]
                    ? '<a class="dl-btn" href="' + esc(it.url) + '" download rel="noopener">⬇ 下载压缩包</a>'
                    : (ap
                      ? appCard(ap, it.url, e)
                      : '<a href="' + esc(it.url) + '" target="_blank" rel="noopener">打开/下载</a>'))));
            div.innerHTML = '<div class="item-title">' + esc(it.title) + '</div>' +
              '<div class="item-time">' + fmtTime(it.createTime) + '</div>' + player;
            wrap.appendChild(div);
          });
        }

        bar.querySelector('.sort-key').addEventListener('change', function () {
          sortState.key = this.value; renderItems();
        });
        bar.querySelector('.sort-dir').addEventListener('change', function () {
          sortState.dir = this.value; renderItems();
        });
        renderItems();
      });
    })
    .catch(function (err) {
      document.getElementById('app').innerHTML =
        '<div class="status">配置加载失败：' + esc(err.message) + '<br/>请求地址：' + esc(CONFIG_URL) + '</div>';
    });
})();
</script>
</body>
</html>
`;
}

// 浏览器通过 <script> 直接使用；此处仅为 Node 侧自测提供便利
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildShareHtml, escapeHtml };
}

'use strict';

const params = new URLSearchParams(window.location.search);
const url = params.get('url');
const name = params.get('name') || '';
const kind = params.get('kind') || 'video';

document.getElementById('pName').textContent = name;
document.title = name || '媒体预览';

const stage = document.getElementById('stage');

if (!url) {
  stage.innerHTML = '<div class="hint">未获取到播放地址</div>';
} else if (kind === 'image') {
  const img = document.createElement('img');
  img.src = url;
  img.alt = name;
  img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
  stage.appendChild(img);
} else if (kind === 'audio') {
  const wrap = document.createElement('div');
  wrap.className = 'audio-wrap';
  wrap.innerHTML = `<div class="big-icon">🎵</div>`;
  const audio = document.createElement('audio');
  audio.controls = true;
  audio.autoplay = true;
  audio.src = url;
  wrap.appendChild(audio);
  stage.appendChild(wrap);
  audio.play().catch(() => {});
} else {
  const video = document.createElement('video');
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  video.src = url;
  stage.appendChild(video);
  video.play().catch(() => {});
}

document.getElementById('pSrc').textContent = url || '';
document.getElementById('pSrc').title = url || '';

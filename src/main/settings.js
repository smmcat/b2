'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 用户设置 + B2 凭据，统一持久化在 userData/settings.json
 * 与 .env 解耦：打包后不携带任何测试数据，用户首次启动在向导中填写。
 */

const DEFAULTS = {
  // B2 凭据（首次启动向导填写）
  keyId: '',
  applicationKey: '',
  bucketId: '',
  bucketName: '',
  // 代理基地址，如 https://b2.smmmax.top （空串 = 不使用代理）
  proxyBase: '',
  // URL 模板，占位符：{proxyBase} {filePath} {bucketName}
  urlTemplate: '{proxyBase}/{filePath}',
  // 桶空间统计缓存（后台全量遍历后写入）
  usageBytes: 0,
  usageFileCount: 0,
  usageComputedAt: 0,
};

let cache = null;
let settingsPath = null;
let isNewFile = false;

function init(userDataDir) {
  settingsPath = path.join(userDataDir, 'settings.json');
  isNewFile = !fs.existsSync(settingsPath);
  cache = load();
}

function load() {
  try {
    if (settingsPath && fs.existsSync(settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return { ...DEFAULTS, ...raw };
    }
  } catch (_) { /* 损坏则回退默认 */ }
  return { ...DEFAULTS };
}

function get() {
  if (!cache) cache = { ...DEFAULTS };
  return cache;
}

function isNew() {
  return isNewFile;
}

function set(patch) {
  cache = { ...get(), ...patch };
  try {
    if (settingsPath) {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(cache, null, 2), 'utf-8');
      isNewFile = false;
    }
  } catch (err) {
    console.error('保存 settings 失败:', err.message);
  }
  return cache;
}

module.exports = { init, get, set, isNew, DEFAULTS };

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 用户设置 + B2 凭据，统一持久化在 settings.json
 * 全部配置由用户首次启动时的向导填写，不依赖任何环境变量。
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

function init(configDir, userDataDir) {
  try { fs.mkdirSync(configDir, { recursive: true }); } catch (_) { /* 目录可能只读，忽略 */ }
  settingsPath = path.join(configDir, 'settings.json');

  // 首次迁移：旧版本配置在 AppData，若新位置不存在则复制过来，避免重装后丢失凭据
  if (!fs.existsSync(settingsPath) && userDataDir) {
    const oldPath = path.join(userDataDir, 'settings.json');
    if (fs.existsSync(oldPath)) {
      try { fs.copyFileSync(oldPath, settingsPath); } catch (_) { /* 忽略 */ }
    }
  }

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

function set(patch) {
  cache = { ...get(), ...patch };
  try {
    if (settingsPath) {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(cache, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('保存 settings 失败:', err.message);
  }
  return cache;
}

module.exports = { init, get, set, DEFAULTS };

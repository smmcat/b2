'use strict';

/**
 * Backblaze B2 原生 API 客户端
 * 直接对接 B2 REST API（非 S3 兼容模式），实现网盘所需的
 * 列目录 / 上传 / 下载 / 删除 / 重命名 / 新建文件夹 等能力。
 *
 * 文档参考: https://www.backblaze.com/apidocs/
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// 大文件分片阈值：B2 建议大于 200MB 的文件走 large_file API
const LARGE_FILE_THRESHOLD = 200 * 1024 * 1024;
// 分片大小：B2 要求 5MB ~ 5GB，最后一片可小于 5MB
const PART_SIZE = 100 * 1024 * 1024;

class B2Client {
  constructor({ keyId, applicationKey, bucketId, bucketName, shareUrlPrefix }) {
    if (!keyId || !applicationKey || !bucketId) {
      throw new Error('B2Client 初始化失败：缺少 keyId / applicationKey / bucketId');
    }
    this.keyId = keyId;
    this.applicationKey = applicationKey;
    this.bucketId = bucketId;
    this.bucketName = bucketName || '';
    this.shareUrlPrefix = (shareUrlPrefix || '').replace(/\/$/, '');

    this.authToken = null;
    this.apiUrl = null;
    this.downloadUrl = null;
    this.authExpireAt = 0;
    // 上传 URL 缓存
    this._uploadEndpoint = null;
  }

  /* ---------------- 鉴权 ---------------- */

  /**
   * b2_authorize_account
   */
  async authorize() {
    const auth = Buffer.from(`${this.keyId}:${this.applicationKey}`).toString('base64');
    const res = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
      method: 'GET',
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`B2 鉴权失败 (${res.status}): ${text}`);
    }
    const data = await res.json();
    this.authToken = data.authorizationToken;
    this.apiUrl = data.apiUrl;
    this.downloadUrl = data.downloadUrl;
    // token 24 小时有效，这里保守按 12 小时计
    this.authExpireAt = Date.now() + 12 * 3600 * 1000;
    this._uploadEndpoint = null;
    return data;
  }

  async _ensureAuth() {
    if (!this.authToken || !this.apiUrl || Date.now() > this.authExpireAt) {
      await this.authorize();
    }
  }

  /**
   * 调用 B2 API，遇到 401 自动刷新 token 重试一次
   */
  async _callApi(pathname, body, method = 'POST') {
    await this._ensureAuth();
    const doRequest = async () => {
      const res = await fetch(`${this.apiUrl}/b2api/v2/${pathname}`, {
        method,
        headers: {
          Authorization: this.authToken,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return res;
    };

    let res = await doRequest();
    if (res.status === 401) {
      await this.authorize();
      res = await doRequest();
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`B2 ${pathname} 失败 (${res.status}): ${text}`);
    }
    return res.json();
  }

  /* ---------------- 列目录 ---------------- */

  /**
   * 列出 prefix 下的文件与子文件夹（通过 delimiter='/' 模拟目录）
   * @returns { folders: string[], files: object[] }
   */
  async listFiles({ prefix = '', delimiter = '/', pageSize = 1000 } = {}) {
    await this._ensureAuth();
    let startFileName = null;
    const files = [];
    const folders = new Set();

    // B2 单次最多返回 10000 条，这里循环翻页直到拿完
    // 为了避免超大目录卡住，单次会话最多翻 20 页（20 万条）
    for (let i = 0; i < 20; i++) {
      const body = {
        bucketId: this.bucketId,
        prefix,
        maxFileCount: pageSize,
      };
      // delimiter 必须为单字符；空串会被 B2 拒绝（400），需要递归列举时干脆不传
      if (delimiter) body.delimiter = delimiter;
      if (startFileName) body.startFileName = startFileName;

      const data = await this._callApi('b2_list_file_names', body);
      for (const f of data.files) {
        // B2 隐藏文件（action=hide）不在常规 list 中出现；folder 模拟项
        const rel = f.fileName.substring(prefix.length);
        const slashIdx = rel.indexOf('/');
        if (slashIdx >= 0) {
          folders.add(rel.substring(0, slashIdx));
        } else {
          // 跳过零字节的目录占位文件
          if (f.fileName.endsWith('/.folderkeep')) continue;
          files.push(f);
        }
      }
      if (!data.nextFileName) break;
      startFileName = data.nextFileName;
    }

    return {
      folders: [...folders].sort(),
      files: files.sort((a, b) => a.fileName.localeCompare(b.fileName)),
    };
  }

  /* ---------------- 分享页配置 ---------------- */

  /**
   * 递归列出 prefix 下的全部文件（不带 delimiter，一次拿全子路径）
   * @returns {object[]} B2 文件对象数组
   */
  async listAllFiles(prefix = '') {
    await this._ensureAuth();
    const files = [];
    let startFileName = null;
    for (let i = 0; i < 50; i++) {
      const body = { bucketId: this.bucketId, prefix, maxFileCount: 1000 };
      if (startFileName) body.startFileName = startFileName;
      const data = await this._callApi('b2_list_file_names', body);
      for (const f of data.files) {
        if (f.fileName.endsWith('/.folderkeep')) continue;
        if (f.action !== 'upload') continue;
        files.push(f);
      }
      if (!data.nextFileName) break;
      startFileName = data.nextFileName;
    }
    return files;
  }

  /**
   * 上传一段文本内容为小文件（用于 sharedConfig.json）
   */
  async uploadText(content, b2FileName, contentType = 'application/json') {
    const buf = Buffer.from(content, 'utf-8');
    const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
    const endpoint = await this._getUploadEndpoint();
    const doUpload = async (ep) => fetch(ep.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: ep.authToken,
        'X-Bz-File-Name': _encodeB2Name(b2FileName),
        'Content-Type': contentType,
        'X-Bz-Content-Sha1': sha1,
        'Content-Length': String(buf.length),
      },
      body: buf,
    });
    let res = await doUpload(endpoint);
    if (res.status === 401 || res.status === 408 || res.status >= 500) {
      this._uploadEndpoint = null;
      res = await doUpload(await this._getUploadEndpoint());
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`B2 上传失败 (${res.status}): ${text}`);
    }
    return res.json();
  }

  /**
   * 读取 B2 上的文本文件（如 sharedConfig.json），不存在返回 null
   */
  async downloadText(b2FileName, settings = {}) {
    await this._ensureAuth();
    const proxyBase = String(settings.proxyBase == null ? '' : settings.proxyBase).trim();
    let url, headers;
    if (proxyBase) {
      url = this.buildFileUrl(b2FileName, settings);
      headers = {};
    } else {
      const filePath = b2FileName.split('/').map(encodeURIComponent).join('/');
      url = `${this.downloadUrl}/file/${encodeURIComponent(this.bucketName)}/${filePath}`;
      headers = { Authorization: this.authToken };
    }
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`读取失败 (${res.status}): ${text.slice(0, 200)}`);
    }
    return res.text();
  }

  /* ---------------- 空间统计 ---------------- */

  /**
   * 遍历桶内全部当前文件，累加得到已用空间。
   * B2 无官方用量接口，只能全量遍历 b2_list_file_names（不带 delimiter）。
   * @param {(progress:{bytes:number,fileCount:number})=>void} [onProgress]
   * @returns {{bytes:number, fileCount:number, computedAt:number}}
   */
  async getBucketUsage(onProgress) {
    await this._ensureAuth();
    let bytes = 0;
    let fileCount = 0;
    let startFileName = null;
    const pageSize = 1000;

    while (true) {
      const body = { bucketId: this.bucketId, maxFileCount: pageSize };
      if (startFileName) body.startFileName = startFileName;
      const data = await this._callApi('b2_list_file_names', body);
      for (const f of data.files) {
        // B2 返回的大小字段为 contentLength（兼容 size）
        const sz = Number(f.contentLength != null ? f.contentLength : f.size) || 0;
        bytes += sz;
        if (f.action === 'upload') fileCount += 1;
      }
      onProgress && onProgress({ bytes, fileCount });
      if (!data.nextFileName) break;
      startFileName = data.nextFileName;
    }

    return { bytes, fileCount, computedAt: Date.now() };
  }

  /* ---------------- 上传 ---------------- */

  /**
   * 获取上传地址（带缓存，失效自动重取）
   */
  async _getUploadEndpoint() {
    if (this._uploadEndpoint) return this._uploadEndpoint;
    const data = await this._callApi('b2_get_upload_url', { bucketId: this.bucketId });
    this._uploadEndpoint = { uploadUrl: data.uploadUrl, authToken: data.authorizationToken };
    return this._uploadEndpoint;
  }

  /**
   * 上传本地文件到 B2（自动根据大小选择普通上传或分片上传）
   * @param {string} localPath 本地文件路径
   * @param {string} b2FileName B2 中的完整对象名（含目录前缀）
   * @param {(loaded, total) => void} onProgress
   */
  async uploadFile(localPath, b2FileName, onProgress) {
    const stat = fs.statSync(localPath);
    const totalSize = stat.size;

    if (totalSize === 0) {
      // 空文件
      return this._uploadSmall(Buffer.alloc(0), b2FileName, totalSize, onProgress);
    }

    if (totalSize < LARGE_FILE_THRESHOLD) {
      return this._uploadSmallFile(localPath, b2FileName, totalSize, onProgress);
    }
    return this._uploadLargeFile(localPath, b2FileName, totalSize, onProgress);
  }

  async _uploadSmallFile(localPath, b2FileName, totalSize, onProgress) {
    // 先算 sha1
    const sha1 = await _sha1OfFile(localPath);
    const buf = fs.readFileSync(localPath);
    return this._uploadSmall(buf, b2FileName, totalSize, onProgress, sha1);
  }

  async _uploadSmall(buffer, b2FileName, totalSize, onProgress, sha1Hex) {
    const endpoint = await this._getUploadEndpoint();
    const urlEncodedName = _encodeB2Name(b2FileName);

    const doUpload = async (reuseEndpoint) => {
      // 进度：包装 fetch 的 body 上传统计
      const body = _trackUpload(buffer, (loaded) => onProgress && onProgress(loaded, totalSize));
      const res = await fetch(reuseEndpoint.uploadUrl, {
        method: 'POST',
        headers: {
          Authorization: reuseEndpoint.authToken,
          'X-Bz-File-Name': urlEncodedName,
          'Content-Type': 'application/octet-stream',
          'X-Bz-Content-Sha1': sha1Hex || crypto.createHash('sha1').update(buffer).digest('hex'),
          'Content-Length': String(totalSize),
        },
        body,
        duplex: 'half',
      });
      return res;
    };

    let res = await doUpload(endpoint);
    if (res.status === 401 || res.status === 408 || (res.status >= 500 && res.status < 600)) {
      // 上传端点失效或服务器临时错误，重新取 URL 重试一次
      this._uploadEndpoint = null;
      const ep = await this._getUploadEndpoint();
      res = await doUpload(ep);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`B2 上传失败 (${res.status}): ${text}`);
    }
    return res.json();
  }

  /**
   * 大文件分片上传
   */
  async _uploadLargeFile(localPath, b2FileName, totalSize, onProgress) {
    // 1. start large file
    const startRes = await this._callApi('b2_start_large_file', {
      bucketId: this.bucketId,
      fileName: b2FileName,
      contentType: 'application/octet-stream',
    });
    const fileId = startRes.fileId;

    try {
      const partCount = Math.ceil(totalSize / PART_SIZE);
      const hashes = [];
      let loadedAll = 0;

      for (let partNumber = 1; partNumber <= partCount; partNumber++) {
        const start = (partNumber - 1) * PART_SIZE;
        const end = Math.min(start + PART_SIZE, totalSize);
        const partSize = end - start;
        const partBuf = _readSlice(localPath, start, partSize);
        const partSha1 = crypto.createHash('sha1').update(partBuf).digest('hex');
        hashes.push(partSha1);

        await this._uploadPart(fileId, partNumber, partBuf, partSha1, (loaded) => {
          onProgress && onProgress(loadedAll + loaded, totalSize);
        });
        loadedAll += partSize;
        onProgress && onProgress(loadedAll, totalSize);
      }

      // 2. finish
      return await this._callApi('b2_finish_large_file', {
        fileId,
        partSha1Array: hashes,
      });
    } catch (err) {
      // 失败则取消，避免占用未完成的大文件
      try { await this._callApi('b2_cancel_large_file', { fileId }); } catch (_) { /* ignore */ }
      throw err;
    }
  }

  async _uploadPart(fileId, partNumber, buffer, sha1Hex, onProgress) {
    const data = await this._callApi('b2_get_upload_part_url', { fileId });
    const totalSize = buffer.length;
    const body = _trackUpload(buffer, (loaded) => onProgress && onProgress(loaded, totalSize));
    const res = await fetch(data.uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: data.authorizationToken,
        'X-Bz-Part-Number': String(partNumber),
        'Content-Length': String(totalSize),
        'X-Bz-Content-Sha1': sha1Hex,
      },
      body,
      duplex: 'half',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`分片上传失败 (${res.status}): ${text}`);
    }
    return res.json();
  }

  /* ---------------- 下载 ---------------- */

  /**
   * 下载文件到本地路径（流式，支持进度回调）
   * 若配置了代理则优先走代理（公开访问，免鉴权），否则走 B2 直链并携带鉴权头。
   */
  async downloadFile(b2FileName, savePath, onProgress, settings = {}, signal) {
    await this._ensureAuth();
    const proxyBase = String(settings.proxyBase == null ? '' : settings.proxyBase).trim();
    const filePath = b2FileName.split('/').map(encodeURIComponent).join('/');

    let url, needsAuth;
    if (proxyBase) {
      url = this.buildFileUrl(b2FileName, settings);
      needsAuth = false;
    } else {
      url = `${this.downloadUrl}/file/${encodeURIComponent(this.bucketName)}/${filePath}`;
      needsAuth = true;
    }

    const doFetch = () => fetch(url, {
      ...(needsAuth ? { headers: { Authorization: this.authToken } } : {}),
      ...(signal ? { signal } : {}),
    });
    let res;
    try {
      res = await doFetch();
      if (needsAuth && res.status === 401) {
        await this.authorize();
        res = await doFetch();
      }
    } catch (err) {
      if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' });
      const msg = err && err.cause ? err.cause.message : err.message;
      if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|127\.0\.0\.1/.test(msg)) {
        throw new Error(`无法连接到下载服务器（${msg}）。建议在「设置」中配置 Cloudflare 代理地址后重试。`);
      }
      throw new Error(`下载失败：${msg}`);
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`下载失败 (${res.status}): ${text.slice(0, 200)}`);
    }
    const total = Number(res.headers.get('content-length')) || 0;
    let loaded = 0;
    const out = fs.createWriteStream(savePath);
    const source = Readable.fromWeb(res.body);
    source.on('data', (chunk) => {
      loaded += chunk.length;
      onProgress && onProgress(loaded, total);
    });
    const onAbort = () => {
      try { source.destroy(); } catch (_) {}
      try { out.destroy(); } catch (_) {}
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      await pipeline(source, out);
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    return { savePath, size: loaded, total };
  }

  /**
   * 生成对外可访问的文件 URL
   * @param {string} b2FileName 完整对象名
   * @param {{proxyBase?:string, urlTemplate?:string}} settings 用户设置
   *
   * 规则：
   *  - 若配置了代理基地址，则按 urlTemplate 渲染（默认 {proxyBase}/{filePath}，
   *    对应 dash.cloudflare.com Workers 把 "域名/文件路径" 映射回 B2 的常见写法）
   *  - 未配置代理时，回退到 B2 原生 friendly URL（公开桶可直接访问）
   */
  buildFileUrl(b2FileName, settings = {}) {
    const filePath = b2FileName.split('/').map(encodeURIComponent).join('/');
    // 严格以 settings.proxyBase 为准：显式空串 = 不使用代理
    const proxyBase = String(settings.proxyBase == null ? '' : settings.proxyBase).replace(/\/+$/, '');
    const template = settings.urlTemplate || '{proxyBase}/{filePath}';

    if (proxyBase) {
      return template
        .replace(/\{proxyBase\}/g, proxyBase)
        .replace(/\{filePath\}/g, filePath)
        .replace(/\{bucketName\}/g, encodeURIComponent(this.bucketName));
    }
    return `${this.downloadUrl}/file/${encodeURIComponent(this.bucketName)}/${filePath}`;
  }

  /** @deprecated 兼容旧调用，等价于 buildFileUrl(fileName) */
  getShareUrl(b2FileName) {
    return this.buildFileUrl(b2FileName);
  }

  /**
   * 生成可直接用于 <video>/<audio> 播放的流地址：
   *  - 有代理 → 走代理（免流）
   *  - 无代理 → B2 直链并在 query 上携带鉴权 token（私有桶也可播放）
   */
  async getStreamUrl(b2FileName, settings = {}) {
    await this._ensureAuth();
    const proxyBase = String(settings.proxyBase == null ? '' : settings.proxyBase).trim();
    if (proxyBase) {
      return this.buildFileUrl(b2FileName, settings);
    }
    const filePath = b2FileName.split('/').map(encodeURIComponent).join('/');
    return `${this.downloadUrl}/file/${encodeURIComponent(this.bucketName)}/${filePath}?Authorization=${encodeURIComponent(this.authToken)}`;
  }

  /* ---------------- 删除 / 重命名 ---------------- */

  /**
   * 删除文件（b2_delete_file_version）；文件夹则删除其下所有文件
   */
  async deleteFile(fileName, fileId) {
    if (fileId) {
      return this._callApi('b2_delete_file_version', { fileName, fileId });
    }
    // 没传 fileId 时，递归列出其下所有文件逐个删（用于删除整个文件夹）
    const files = await this.listAllFiles(fileName.endsWith('/') ? fileName : fileName + '/');
    const results = [];
    for (const f of files) {
      results.push(await this._callApi('b2_delete_file_version', { fileName: f.fileName, fileId: f.fileId }));
    }
    return results;
  }

  /**
   * 重命名/移动：b2_copy_file + b2_delete_file_version
   */
  async renameFile(sourceFileName, newFileName) {
    // 先取 fileId
    const data = await this._callApi('b2_list_file_names', {
      bucketId: this.bucketId,
      prefix: sourceFileName,
      maxFileCount: 1,
    });
    const target = (data.files || []).find((f) => f.fileName === sourceFileName);
    if (!target) throw new Error(`文件不存在: ${sourceFileName}`);

    const copyRes = await this._callApi('b2_copy_file', {
      sourceFileId: target.fileId,
      fileName: newFileName,
      metadataDirective: 'COPY',
    });
    await this._callApi('b2_delete_file_version', {
      fileName: sourceFileName,
      fileId: target.fileId,
    });
    return copyRes;
  }

  /**
   * 新建文件夹：上传一个零字节占位文件
   */
  async createFolder(folderPrefix) {
    const name = (folderPrefix.endsWith('/') ? folderPrefix : folderPrefix + '/') + '.folderkeep';
    const buf = Buffer.alloc(0);
    return this._uploadSmall(buf, name, 0, null, crypto.createHash('sha1').update(buf).digest('hex'));
  }
}

/* ---------------- 工具函数 ---------------- */

function _encodeB2Name(name) {
  // B2 要求 X-Bz-File-Name 为 URL 编码的 UTF-8
  return encodeURIComponent(name).replace(/%2F/g, '/');
}

async function _sha1OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const rs = fs.createReadStream(filePath);
    rs.on('data', (d) => hash.update(d));
    rs.on('end', () => resolve(hash.digest('hex')));
    rs.on('error', reject);
  });
}

function _readSlice(filePath, start, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 把 Buffer 包装成可统计已发送字节的 web ReadableStream（用于上传进度）
 */
function _trackUpload(buffer, onSent) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= buffer.length) {
        controller.close();
        return;
      }
      // 每次发送 256KB 触发一次进度
      const chunkSize = 256 * 1024;
      const end = Math.min(offset + chunkSize, buffer.length);
      controller.enqueue(buffer.subarray(offset, end));
      offset = end;
      onSent(offset);
    },
  });
}

module.exports = { B2Client };

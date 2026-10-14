'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 安全地把主进程能力以白名单形式暴露给渲染进程
 */
contextBridge.exposeInMainWorld('b2api', {
  // 当前目录前缀
  getBucketInfo: () => ipcRenderer.invoke('b2:bucketInfo'),

  // 列目录
  listFiles: (prefix) => ipcRenderer.invoke('b2:listFiles', prefix),

  // 列出当前目录文件的历史版本（{ fileName: [version...] }）
  listFileVersions: (prefix) => ipcRenderer.invoke('b2:listFileVersions', prefix),

  // 递归列出前缀下全部文件（含 .folderkeep 占位），供文件夹整体移动/重命名
  listAllFiles: (prefix) => ipcRenderer.invoke('b2:listAllFiles', prefix),

  // 上传（渲染进程先选好本地文件，传路径过来）
  selectAndUpload: (destPrefix) => ipcRenderer.invoke('b2:selectAndUpload', destPrefix),
  uploadLocalFile: (localPath, b2FileName) =>
    ipcRenderer.invoke('b2:upload', { localPath, b2FileName }),

  // 下载（主进程弹保存对话框）；fileId 用于下载历史版本
  downloadFile: (b2FileName, defaultName, fileId) =>
    ipcRenderer.invoke('b2:download', { b2FileName, defaultName, fileId }),
  cancelDownload: (taskId) => ipcRenderer.invoke('b2:cancelDownload', taskId),

  // 删除
  deleteFile: (fileName, fileId) => ipcRenderer.invoke('b2:delete', { fileName, fileId }),

  // 重命名
  renameFile: (oldName, newName) => ipcRenderer.invoke('b2:rename', { oldName, newName }),

  // 移动（copy + delete，保留全部历史版本）
  moveFile: (sourceFileName, destFileName) =>
    ipcRenderer.invoke('b2:move', { sourceFileName, destFileName }),

  // 新建文件夹
  createFolder: (prefix) => ipcRenderer.invoke('b2:createFolder', prefix),

  // 分享链接；fileId 用于分享历史版本
  getShareUrl: (fileName, fileId) => ipcRenderer.invoke('b2:shareUrl', { fileName, fileId }),

  // 预览流地址（视频/音频）
  getPreviewUrl: (fileName) => ipcRenderer.invoke('b2:previewUrl', fileName),

  // 在新窗口播放媒体
  openPlayer: (fileName) => ipcRenderer.invoke('b2:openPlayer', { fileName }),

  // 抓取远程文件为 base64 dataURL（图片预览）
  fetchDataUrl: (url) => ipcRenderer.invoke('b2:fetchDataUrl', { url }),

  // 设置
  getSettings: () => ipcRenderer.invoke('b2:getSettings'),
  saveSettings: (patch) => ipcRenderer.invoke('b2:saveSettings', patch),
  reinit: () => ipcRenderer.invoke('b2:reinit'),

  // 空间统计
  getUsage: () => ipcRenderer.invoke('b2:getUsage'),
  refreshUsage: () => ipcRenderer.invoke('b2:refreshUsage'),
  onUsageUpdated: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('b2:usageUpdated', listener);
    return () => ipcRenderer.removeListener('b2:usageUpdated', listener);
  },

  // 事件：上传/下载进度
  onProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('b2:progress', listener);
    return () => ipcRenderer.removeListener('b2:progress', listener);
  },

  // 分享页
  shareListFolders: (prefix, withConfigStatus) =>
    ipcRenderer.invoke('share:listFolders', { prefix, withConfigStatus: !!withConfigStatus }),
  shareCreateConfig: (folder) => ipcRenderer.invoke('share:createConfig', { folder }),
  shareReadConfig: (folder) => ipcRenderer.invoke('share:readConfig', { folder }),
  shareGetArchives: () => ipcRenderer.invoke('share:getArchives'),
  shareDeleteArchive: (folder) => ipcRenderer.invoke('share:deleteArchive', folder),
  shareUpdateArchive: (entry) => ipcRenderer.invoke('share:updateArchive', entry),
  shareSaveHtml: (html) => ipcRenderer.invoke('share:saveHtml', { html }),
});

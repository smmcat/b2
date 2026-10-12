'use strict';
// 把多个尺寸的 PNG 合成一个多分辨率 ICO（PNG 压缩，Vista+ 兼容），零依赖
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'src', 'assets');
const inputs = [
  { size: 16, file: 'icon-16x16.png' },
  { size: 32, file: 'icon-32x32.png' },
  { size: 48, file: 'icon-48x48.png' },
  { size: 64, file: 'b2_64x64.png' },
  { size: 128, file: 'b2_128x128.png' },
  { size: 256, file: 'b2_256x256.png' },
];

const images = inputs
  .map((i) => ({ ...i, buf: fs.readFileSync(path.join(ASSETS, i.file)) }))
  .filter((i) => i.buf && i.buf.length > 0);

if (images.length === 0) throw new Error('没有可用的图标 PNG');

const count = images.length;
const headerSize = 6 + 16 * count;
let offset = headerSize;
const dir = Buffer.alloc(headerSize);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type = icon
dir.writeUInt16LE(count, 4);

const chunks = [dir];
images.forEach((img, idx) => {
  const e = 6 + 16 * idx;
  dir.writeUInt8(img.size >= 256 ? 0 : img.size, e);     // width
  dir.writeUInt8(img.size >= 256 ? 0 : img.size, e + 1); // height
  dir.writeUInt8(0, e + 2);  // colorCount
  dir.writeUInt8(0, e + 3);  // reserved
  dir.writeUInt16LE(1, e + 4);  // planes
  dir.writeUInt16LE(32, e + 6); // bitCount
  dir.writeUInt32LE(img.buf.length, e + 8); // bytesInRes
  dir.writeUInt32LE(offset, e + 12);        // offset
  offset += img.buf.length;
  chunks.push(img.buf);
});

const out = Buffer.concat(chunks);
const outPath = path.join(ASSETS, 'icon.ico');
fs.writeFileSync(outPath, out);
console.log(`已生成 ${outPath}，包含 ${count} 个尺寸（${images.map((i) => i.size).join('/')}），${out.length} 字节`);

// 通用字节工具：浏览器与 Node 均可直接 import（不依赖任何 DOM 全局）
export const TE = new TextEncoder();
export const TD = new TextDecoder();

export function utf8(str) { return TE.encode(str); }
export function fromUtf8(buf) { return TD.decode(buf); }

export function hexToBytes(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2) throw new Error('hex 长度不是偶数');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(buf) {
  let s = '';
  for (const b of buf) s += b.toString(16).padStart(2, '0');
  return s;
}

export function decodeBase64(input) {
  const str = (typeof input === 'string' ? input : fromUtf8(input)).replace(/\s/g, '');
  const bin = typeof atob === 'function' ? atob(str) : Buffer.from(str, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeBase64(buf) {
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
}

export function u32le(buf, offset) {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}
export function u32be(buf, offset) {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

export function writeU32le(buf, offset, value) {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >>> 8) & 0xff;
  buf[offset + 2] = (value >>> 16) & 0xff;
  buf[offset + 3] = (value >>> 24) & 0xff;
}

export function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

export function xorBytes(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

export function pkcs7Unpad(buf) {
  if (!buf.length) throw new Error('PKCS7: 空数据');
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 16 || pad > buf.length) throw new Error('PKCS7: 填充长度非法');
  for (let i = buf.length - pad; i < buf.length; i++) {
    if (buf[i] !== pad) throw new Error('PKCS7: 填充校验失败');
  }
  return buf.subarray(0, buf.length - pad);
}

export function pkcs7Pad(buf, blockSize = 16) {
  const pad = blockSize - (buf.length % blockSize);
  const out = new Uint8Array(buf.length + pad);
  out.set(buf);
  out.fill(pad, buf.length);
  return out;
}

export function hasPrefix(buf, str, offset = 0) {
  if (offset + str.length > buf.length) return false;
  for (let i = 0; i < str.length; i++) if (buf[offset + i] !== str.charCodeAt(i)) return false;
  return true;
}

export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function fileExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function stripExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(0, dot);
}

// 安全文件名：去掉控制字符与 Windows 非法字符
export function safeName(name) {
  return (name || 'audio').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180) || 'audio';
}

export class DecryptError extends Error {
  constructor(message, code = 'DECRYPT_FAILED') {
    super(message);
    this.name = 'DecryptError';
    this.code = code;
  }
}

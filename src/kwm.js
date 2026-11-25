// 酷我音乐 .kwm
// 文件头 0x18 处的 8 字节资源 ID 派生出 32 字节掩码，音频流自 1024 字节起循环异或
import { hexToBytes, hasPrefix, DecryptError } from './utils.js';

const MAGIC = hexToBytes('7965656c696f6e2d6b75776f2d746d65'); // "yeelion-kuwo-tme"
const PREDEFINED = 'MoOtOiTvINGwd2E6n0E1i7L5t2IoOoNk';

export function isKwm(data) {
  if (data.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (data[i] !== MAGIC[i]) return false;
  return true;
}

function padOrTruncate(str, length) {
  if (!str.length) return new Array(length).fill('\x00').join('');
  if (str.length > length) return str.slice(0, length);
  let out = '';
  for (let i = 0; i < length; i++) out += str[i % str.length];
  return out;
}

export function generateKwmMask(keyBytes) {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(keyBytes[i] & 0xff);
  const trimmed = padOrTruncate(value.toString(10), 32);
  const mask = new Uint8Array(32);
  for (let i = 0; i < 32; i++) mask[i] = (PREDEFINED.charCodeAt(i) ^ trimmed.charCodeAt(i)) & 0xff;
  return mask;
}

export function decryptKwm(data, onProgress = () => {}) {
  if (data.length < 1024) throw new DecryptError('KWM 文件过小');
  if (!isKwm(data)) throw new DecryptError('不是有效的 KWM 文件（魔数不匹配）');
  const mask = generateKwmMask(data.subarray(0x18, 0x20));
  const audio = Uint8Array.from(data.subarray(1024));
  const CHUNK = 1 << 20;
  for (let start = 0; start < audio.length; start += CHUNK) {
    const end = Math.min(audio.length, start + CHUNK);
    for (let i = start; i < end; i++) audio[i] ^= mask[i & 0x1f];
    onProgress(end / Math.max(1, audio.length));
  }
  return { data: audio };
}

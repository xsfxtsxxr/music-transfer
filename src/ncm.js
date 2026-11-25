// 网易云音乐 .ncm
// 结构：CTENFDAM 头 → AES(core_key) 加密的音频密钥 → AES(meta_key) 加密的元数据
//       → 封面 → 由密钥生成的 256 字节密钥盒循环异或的音频流
import {
  hexToBytes, fromUtf8, decodeBase64, u32le, hasPrefix, DecryptError,
} from './utils.js';
import { aesEcbDecryptUnpad } from './aes.js';

const MAGIC = 'CTENFDAM';
export const NCM_CORE_KEY = hexToBytes('687a4852416d736f356b496e62617857'); // hzHRAmso5kInbaxW
export const NCM_META_KEY = hexToBytes('2331346c6a6b5f215c5d2630553c2728'); // #14ljk_!\]&0U<'(
const XOR_KEY = 0x64;
const XOR_META = 0x63;

export function isNcm(data) { return hasPrefix(data, MAGIC); }

export function buildKeyBox(key) {
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (box[i] + j + key[i % key.length]) & 0xff;
    const t = box[i]; box[i] = box[j]; box[j] = t;
  }
  const box2 = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const idx = (i + 1) & 0xff;
    const si = box[idx];
    const sj = box[(idx + si) & 0xff];
    box2[i] = box[(si + sj) & 0xff];
  }
  return box2;
}

function parseMeta(metaStr) {
  const sep = metaStr.indexOf(':');
  if (sep < 0) return null;
  const kind = metaStr.slice(0, sep);
  if (kind !== 'music' && kind !== 'dj') return null;
  try { return JSON.parse(metaStr.slice(sep + 1)); } catch { return null; }
}

function extractMetaInfo(meta) {
  const out = { format: '', title: '', artist: '', album: '' };
  if (!meta || typeof meta !== 'object') return out;
  out.format = String(meta.format || '');
  out.title = String(meta.musicName || meta.programName || '');
  out.album = String(meta.album || meta.brand || meta.radioName || '');
  const artists = [];
  for (const item of (meta.artist || [])) {
    if (Array.isArray(item)) {
      for (const sub of item) if (typeof sub === 'string') artists.push(sub);
    } else if (typeof item === 'string') artists.push(item);
  }
  const main = meta.mainMusic || {};
  if (main && typeof main === 'object') {
    if (!artists.length && main.musicName) artists.push(String(main.musicName));
    if (!out.title) out.title = String(main.musicName || '');
    if (!out.album) out.album = String(main.album || '');
    if (!out.format) out.format = String(main.format || '');
  }
  out.artist = String(meta.djName || artists.join(' / '));
  return out;
}

function coverMime(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (hasPrefix(bytes, 'RIFF') && hasPrefix(bytes, 'WEBP', 8)) return 'image/webp';
  return 'application/octet-stream';
}

export function decryptNcm(data, onProgress = () => {}) {
  if (!isNcm(data)) throw new DecryptError('不是有效的 NCM 文件（魔数不匹配）');
  const n = data.length;
  const headerEnd = 10; // 8 字节魔数 + 2 字节保留位
  if (headerEnd + 4 > n) throw new DecryptError('NCM 文件不完整');
  const keyLen = u32le(data, headerEnd);
  const keyStart = headerEnd + 4;
  if (keyLen === 0 || keyLen > 4096 || keyStart + keyLen + 4 > n) {
    throw new DecryptError('NCM 密钥块长度异常');
  }
  const keyRaw = new Uint8Array(keyLen);
  for (let i = 0; i < keyLen; i++) keyRaw[i] = data[keyStart + i] ^ XOR_KEY;

  let key;
  try {
    const plain = aesEcbDecryptUnpad(keyRaw, NCM_CORE_KEY);
    key = plain.subarray(17); // 去掉 "neteasecloudmusic"
  } catch (e) {
    throw new DecryptError(`NCM 密钥解密失败：${e.message}`);
  }
  if (!key.length) throw new DecryptError('NCM 音频密钥为空');
  onProgress(0.05);

  let cursor = keyStart + keyLen;
  if (cursor + 4 > n) throw new DecryptError('NCM 元数据头越界');
  const metaLen = u32le(data, cursor);
  cursor += 4;
  if (metaLen > 4 * 1024 * 1024 || cursor + metaLen > n) throw new DecryptError('NCM 元数据块越界');

  let info = extractMetaInfo(null);
  if (metaLen > 22) {
    const metaBlock = new Uint8Array(metaLen - 22);
    for (let i = 0; i < metaBlock.length; i++) metaBlock[i] = data[cursor + 22 + i] ^ XOR_META;
    // 标准格式：前缀 "163 key(Don't modify):" 之后是 base64(AES(meta))
    // 少数转存版本去掉了 base64，这里两种都尝试
    let plain = null;
    for (const candidate of [() => decodeBase64(metaBlock), () => metaBlock]) {
      try {
        const cipher = candidate();
        if (cipher.length % 16 === 0) {
          const decoded = fromUtf8(aesEcbDecryptUnpad(cipher, NCM_META_KEY));
          if (decoded && decoded.includes(':')) { plain = decoded; break; }
        }
      } catch { /* 尝试下一种 */ }
    }
    if (plain) info = extractMetaInfo(parseMeta(plain));
  }
  cursor += metaLen;

  // 元数据之后：4 字节 CRC + 5 字节保留 + 4 字节封面长度 + 封面数据
  let audioOffset = cursor;
  let cover = null;
  if (cursor + 13 <= n) {
    const coverLenPos = cursor + 9;
    const coverLen = u32le(data, coverLenPos);
    const coverStart = coverLenPos + 4;
    if (coverStart + coverLen <= n && coverLen < 32 * 1024 * 1024) {
      audioOffset = coverStart + coverLen;
      if (coverLen > 0) {
        const bytes = data.slice(coverStart, coverStart + coverLen);
        cover = { bytes, mime: coverMime(bytes) };
      }
    }
  }
  if (audioOffset > n) throw new DecryptError('NCM 音频数据偏移越界');
  onProgress(0.1);

  const box = buildKeyBox(key);
  const audio = new Uint8Array(n - audioOffset);
  const CHUNK = 1 << 20;
  for (let start = 0; start < audio.length; start += CHUNK) {
    const end = Math.min(audio.length, start + CHUNK);
    for (let i = start; i < end; i++) audio[i] = box[i & 0xff] ^ data[audioOffset + i];
    onProgress(0.1 + 0.9 * (end / Math.max(1, audio.length)));
  }

  return {
    data: audio,
    meta: {
      title: info.title, artist: info.artist, album: info.album,
      format: info.format.toLowerCase(), cover,
    },
  };
}

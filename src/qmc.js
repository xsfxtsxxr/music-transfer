// QQ 音乐 QMC 系（.qmc* / .mflac* / .mgg* / .tkm / .bk c*）
// 三种流密码：static（无内嵌密钥）、map（短 ekey）、rc4（长 ekey）
// 文件尾可能携带 QTag 或长度前缀形式的 base64 ekey，需经 TEA 解包
import {
  hexToBytes, u32le, u32be, hasPrefix, fromUtf8, DecryptError,
} from './utils.js';
import { decryptQmcKey } from './tea.js';

const STATIC_BOX = hexToBytes(
  '77483273def2c0c895ec30b251c3e1a09ee69dcffa7f14d1' +
  'ceb8dcc34a6793d628c29170ca8da2a4f00861907e6fa2e0' +
  'ebae3eb667c792f491b5f66c5e8440f7f31b027fd5ab4189' +
  '28f425cc5211ad4368a6418b84b5ff2c924a26d8476a7c95' +
  '61cce6cbbb3f47588975c375a1d9afcc087317dcaa9aa216' +
  '41d8a206c68bfc66349fcf1823a00a74e72b277092e9af37' +
  'e68ca7bc62659cc208c988b3f343ac742c0fd4afa1c30164' +
  '954e489ff43578957a39d66aa06d40e84fa8ef111df31b3f' +
  '3f07dd6f5b193019fbef0e37f00ecd1649fe5347131abda4' +
  'f14019600eed6809065f4dcf3d1afe2077e4d9daf9a42b76' +
  '1c71db00bcfd0c6ca547f7f600794a11'
);
if (STATIC_BOX.length !== 256) throw new Error('QMC 静态掩码表长度异常');

const RC4_SEGMENT_SIZE = 5120;
const RC4_FIRST_SEGMENT_SIZE = 128;

export const QMC_EXTENSIONS = new Set([
  'qmc', 'qmc0', 'qmc2', 'qmc3', 'qmc4', 'qmc6', 'qmc8', 'qmcflac', 'qmcogg', 'tkm',
  'bkcmp3', 'bkcm4a', 'bkcflac', 'bkcwav', 'bkcape', 'bkcogg', 'bkcwma',
  '666c6163', '6d7033', '6f6767', '6d3461', '776176',
  'mgg', 'mgg0', 'mgg1', 'mgg2', 'mgg3', 'mggl', 'mflac', 'mflac0', 'mflac1', 'mma3',
]);

export function isQmcExtension(ext) { return QMC_EXTENSIONS.has(ext); }

export class MapCipher {
  constructor(key) {
    if (!key.length) throw new DecryptError('QMC map 密钥为空');
    this.key = key;
    this.size = key.length;
  }
  static rotate(value, bits) {
    const r = (bits + 4) % 8;
    return ((value << r) | (value >> r)) & 0xff;
  }
  getMask(offset) {
    if (offset > 0x7fff) offset %= 0x7fff;
    const idx = (offset * offset + 71214) % this.size;
    return MapCipher.rotate(this.key[idx], idx & 0x7);
  }
  decrypt(buf, offset) {
    for (let i = 0; i < buf.length; i++) buf[i] ^= this.getMask(offset + i);
  }
}

export class StaticCipher {
  getMask(offset) {
    if (offset > 0x7fff) offset %= 0x7fff;
    const idx = (offset * offset + 27) & 0xff;
    return STATIC_BOX[idx];
  }
  decrypt(buf, offset) {
    for (let i = 0; i < buf.length; i++) buf[i] ^= this.getMask(offset + i);
  }
}

function truncRem(a, b) {
  const r = a % b;
  return (a < 0 && r !== 0) ? r - b : r;
}

export class Rc4Cipher {
  constructor(key) {
    const n = key.length;
    if (!n) throw new DecryptError('QMC rc4 密钥为空');
    this.key = key;
    this.n = n;
    const box = new Uint8Array(n);
    for (let i = 0; i < n; i++) box[i] = i & 0xff;
    let j = 0;
    for (let i = 0; i < n; i++) {
      j = (j + box[i] + key[i % n]) % n;
      const t = box[i]; box[i] = box[j]; box[j] = t;
    }
    this.box = box;
    let h = 1;
    for (let i = 0; i < n; i++) {
      const v = key[i];
      if (v === 0) continue;
      const nh = (h * v) >>> 0;
      if (nh === 0 || nh <= h) break;
      h = nh;
    }
    this.hash = h;
  }
  getSegmentSkip(segId) {
    const n = this.n;
    const seed = this.key[segId % n];
    const div = (segId + 1) * seed;
    const idx = div === 0 ? -(2 ** 63) : Math.trunc((this.hash / div) * 100);
    return truncRem(idx, n);
  }
  encFirstSegment(src, start, length, offset) {
    for (let i = 0; i < length; i++) src[start + i] ^= this.key[this.getSegmentSkip(offset + i)];
  }
  encASegment(src, start, length, offset) {
    const n = this.n;
    const box = this.box.slice();
    let j = 0, k = 0;
    const skipLen = (offset % RC4_SEGMENT_SIZE) + this.getSegmentSkip(Math.floor(offset / RC4_SEGMENT_SIZE));
    for (let t = -skipLen; t < length; t++) {
      j = (j + 1) % n;
      k = (box[j] + k) % n;
      const tmp = box[j]; box[j] = box[k]; box[k] = tmp;
      if (t >= 0) src[start + t] ^= box[(box[j] + box[k]) % n];
    }
  }
  decrypt(src, offset = 0, onProgress = () => {}) {
    let toProcess = src.length;
    let processed = 0;
    const total = Math.max(1, src.length);
    const mark = (inc) => {
      offset += inc; toProcess -= inc; processed += inc;
      onProgress(processed / total);
      return toProcess === 0;
    };
    if (offset < RC4_FIRST_SEGMENT_SIZE) {
      let block = toProcess;
      if (block > RC4_FIRST_SEGMENT_SIZE - offset) block = RC4_FIRST_SEGMENT_SIZE - offset;
      this.encFirstSegment(src, processed, block, offset);
      if (mark(block)) return;
    }
    if (offset % RC4_SEGMENT_SIZE !== 0) {
      let block = toProcess;
      const remain = RC4_SEGMENT_SIZE - (offset % RC4_SEGMENT_SIZE);
      if (block > remain) block = remain;
      this.encASegment(src, processed, block, offset);
      if (mark(block)) return;
    }
    while (toProcess > RC4_SEGMENT_SIZE) {
      this.encASegment(src, processed, RC4_SEGMENT_SIZE, offset);
      if (mark(RC4_SEGMENT_SIZE)) return;
    }
    if (toProcess > 0) this.encASegment(src, processed, toProcess, offset);
  }
}

function searchKey(data) {
  const n = data.length;
  if (n < 8) throw new DecryptError('QMC 文件过小');
  const tail = data.subarray(n - 4);
  if (hasPrefix(tail, 'QTag')) {
    const metaLen = u32be(data, n - 8);
    if (metaLen < 0 || 8 + metaLen > n) throw new DecryptError('QMC QTag 元数据长度异常');
    const audioLen = n - 8 - metaLen;
    const rawMeta = fromUtf8(data.subarray(n - 8 - metaLen, n - 8));
    const items = rawMeta.split(',');
    if (items.length !== 3) throw new DecryptError('QMC QTag 元数据格式异常');
    return { key: decryptQmcKey(items[0]), audioLen };
  }
  const size = u32le(data, n - 4);
  if (size < 0x300 && size !== 0) {
    if (4 + size > n) throw new DecryptError('QMC 尾部密钥长度异常');
    const audioLen = n - 4 - size;
    const rawKey = data.subarray(n - 4 - size, n - 4);
    return { key: decryptQmcKey(rawKey), audioLen };
  }
  return { key: null, audioLen: n };
}

function hasMusicExFooter(data) {
  const start = Math.max(0, data.length - 4096);
  const tail = fromUtf8(data.subarray(start));
  return tail.includes('musicex') || tail.includes('MusicEx');
}

export function decryptQmc(data, onProgress = () => {}) {
  if (data.length < 8) throw new DecryptError('QMC 文件过小');
  let found;
  try {
    found = searchKey(data);
  } catch (e) {
    if (hasMusicExFooter(data)) {
      throw new DecryptError('该 QMC 变体的密钥需要 QQ 音乐服务器下发，本地无法离线解密', 'NEEDS_SERVER_KEY');
    }
    throw e;
  }
  const audio = Uint8Array.from(data.subarray(0, found.audioLen));
  let cipherName = 'static';
  if (found.key && found.key.length > 300) {
    cipherName = 'rc4';
    new Rc4Cipher(found.key).decrypt(audio, 0, (p) => onProgress(0.05 + 0.9 * p));
  } else if (found.key) {
    cipherName = 'map';
    const cipher = new MapCipher(found.key);
    const CHUNK = 1 << 20;
    for (let start = 0; start < audio.length; start += CHUNK) {
      const len = Math.min(CHUNK, audio.length - start);
      cipher.decrypt(new Uint8Array(audio.buffer, start, len), start);
      onProgress(0.05 + 0.9 * ((start + len) / Math.max(1, audio.length)));
    }
  } else {
    const cipher = new StaticCipher();
    const CHUNK = 1 << 20;
    for (let start = 0; start < audio.length; start += CHUNK) {
      const len = Math.min(CHUNK, audio.length - start);
      cipher.decrypt(new Uint8Array(audio.buffer, start, len), start);
      onProgress(0.05 + 0.9 * ((start + len) / Math.max(1, audio.length)));
    }
  }
  onProgress(1);
  return { data: audio, cipher: cipherName, hasKey: !!found.key };
}

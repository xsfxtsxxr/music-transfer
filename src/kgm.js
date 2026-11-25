// 酷狗音乐 KGM / KGMA / VPR
// 算法本身可离线完成，但依赖一份公开的静态「大掩码表」(kgm.maskfile / kugou_key)：
// 每 16 字节音频消耗 1 字节掩码，因此表长度必须 >= ceil(音频长度 / 16)。
// 该表是二进制公开常量，无法由算法推导；本站支持运行时由用户导入，不联网获取。
import { hexToBytes, u32le, DecryptError } from './utils.js';

const MAGIC_KGM = hexToBytes('7cd532eb86027f4ba8afa68e0fff9914');
const MAGIC_VPR = hexToBytes('0528bc96e9e45a4391aabdd07af53631');
const MAGIC_NEW = hexToBytes('7cd532eb86027f4ba8afa68e0fff9914000400000300000001000000');

const MASK_V2 = hexToBytes(
  'b8d53db2e9af788c8333715176a0cd372f3e358da9be98b7e78c22ce5a61df68' +
  '6989fea5b6dea977fcc8bdbde56d3e5a36ef694ebee1e9661cf3d902b6f2129b' +
  '44d06fb93589b6466d73820669c1edd785c230dfa262be792d62623d0d7ebe48' +
  '892302a0e4d57551320253fd163a213b160fc3b2bbb3e2ba3a3d13ecf6014584' +
  'a5700f93490c64cd31d5cc4c07019e001a2390bf881e3baba63ec47347107e3b' +
  '5ebce30084ff09d4e0890f5b58704ffb65d85c531bd3c8c6bfef98b0504f0fea' +
  'e583588c282c8467cdd09e47db2750caf46363e8977f1b4b0cc2c1214ccc58f5' +
  '9452a3f3d3e068f40023f35e0a7b93ddab12b213e884d7a79f0f324c551d0436' +
  '52dc03f3f94e42e93d61ef7cb6b39350'
);
if (MASK_V2.length !== 272) throw new Error('KGM 修正表长度异常');

const VPR_DIFF = hexToBytes('25dfe8a6751e750e2f80f32db8b6e31100');

let MASK_TABLE = null;

export function setKgmMask(bytes) {
  MASK_TABLE = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return MASK_TABLE.length;
}
export function getKgmMaskLength() { return MASK_TABLE ? MASK_TABLE.length : 0; }
export function hasKgmMask() { return !!MASK_TABLE && MASK_TABLE.length > 0; }

function startsWith(data, prefix) {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

export function classifyKgm(data) {
  if (startsWith(data, MAGIC_NEW)) return 'kgma';
  if (startsWith(data, MAGIC_KGM)) return 'kgm';
  if (startsWith(data, MAGIC_VPR)) return 'vpr';
  return null;
}

export function isKgm(data) { return classifyKgm(data) !== null; }

export function decryptKgm(data, onProgress = () => {}) {
  const kind = classifyKgm(data);
  if (!kind) throw new DecryptError('不是有效的 KGM/VPR 文件（魔数不匹配）');

  let headerLen = data.length >= 0x14 ? u32le(data, 0x10) : 0;
  if (!headerLen || headerLen > data.length || headerLen < 0x1c) headerLen = 0x400;
  if (headerLen > data.length) headerLen = data.length;

  const key = new Uint8Array(17);
  key.set(data.subarray(0x1c, Math.min(0x2c, data.length)));
  // 第 17 字节固定为 0，来自文件头 16 字节私钥扩展

  const audio = Uint8Array.from(data.subarray(headerLen));
  const needed = Math.ceil(audio.length / 16);
  if (!hasKgmMask()) {
    throw new DecryptError('酷狗 KGM/VPR 需要一份公开的大掩码表，请先在下方「酷狗密钥表」区域导入 kgm.maskfile', 'NEED_KGM_MASK');
  }
  if (MASK_TABLE.length < needed) {
    throw new DecryptError(`大掩码表长度不足：需要 ${needed.toLocaleString()} 字节，当前只有 ${MASK_TABLE.length.toLocaleString()} 字节`, 'NEED_KGM_MASK');
  }

  const pub = MASK_TABLE;
  const CHUNK = 1 << 20;
  const transform = (v) => v ^ ((v & 0x0f) << 4);
  for (let start = 0; start < audio.length; start += CHUNK) {
    const end = Math.min(audio.length, start + CHUNK);
    for (let i = start; i < end; i++) {
      const med = audio[i] ^ key[i % 17] ^ MASK_V2[i % 272] ^ pub[i >> 4];
      audio[i] = transform(med) & 0xff;
    }
    onProgress(end / Math.max(1, audio.length));
  }
  if (kind === 'vpr') {
    for (let i = 0; i < audio.length; i++) audio[i] ^= VPR_DIFF[i % 17];
  }
  return { data: audio, kind };
}

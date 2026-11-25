// QQ 音乐 QMC 内嵌 ekey 的 TEA 密钥解包（32 轮 TEA + 腾讯 CBC 变体）
// 移植自 unlock-music/cli algo/qmc/key_dec.go 与 golang.org/x/crypto/tea
import { decodeBase64, concat, xorBytes, u32be } from './utils.js';

const DELTA = 0x9e3779b9;
const M32 = 0xffffffff;

function readU32BE(buf, offset) { return u32be(buf, offset); }

function writeU32BE(out, offset, v) {
  out[offset] = (v >>> 24) & 0xff;
  out[offset + 1] = (v >>> 16) & 0xff;
  out[offset + 2] = (v >>> 8) & 0xff;
  out[offset + 3] = v & 0xff;
}

function teaKey(key) {
  return [readU32BE(key, 0), readU32BE(key, 4), readU32BE(key, 8), readU32BE(key, 12)];
}

// TEA 单轮混淆项：((v<<4)+k0) ^ (v+sum) ^ ((v>>5)+k1)，全部按 32 位无符号运算
function mix(v, k0, k1, sum) {
  const a = (((v << 4) >>> 0) + k0) >>> 0;
  const b = (v + sum) >>> 0;
  const c = (((v >>> 5) + k1) >>> 0);
  return (a ^ b ^ c) >>> 0;
}

export function teaEncryptBlock(block, key, rounds = 32) {
  const [k0, k1, k2, k3] = teaKey(key);
  let v0 = readU32BE(block, 0), v1 = readU32BE(block, 4);
  let s = 0;
  for (let i = 0; i < rounds / 2; i++) {
    s = (s + DELTA) >>> 0;
    v0 = (v0 + mix(v1, k0, k1, s)) >>> 0;
    v1 = (v1 + mix(v0, k2, k3, s)) >>> 0;
  }
  const out = new Uint8Array(8);
  writeU32BE(out, 0, v0);
  writeU32BE(out, 4, v1);
  return out;
}

export function teaDecryptBlock(block, key, rounds = 32) {
  const [k0, k1, k2, k3] = teaKey(key);
  let v0 = readU32BE(block, 0), v1 = readU32BE(block, 4);
  let s = (DELTA * (rounds / 2)) >>> 0;
  for (let i = 0; i < rounds / 2; i++) {
    v1 = (v1 - mix(v0, k2, k3, s)) >>> 0;
    v0 = (v0 - mix(v1, k0, k1, s)) >>> 0;
    s = (s - DELTA) >>> 0;
  }
  const out = new Uint8Array(8);
  writeU32BE(out, 0, v0);
  writeU32BE(out, 4, v1);
  return out;
}

// simpleMakeKey(106, 8) 的预计算结果，避免浮点实现差异
export const SIMPLE_KEY_106_8 = Uint8Array.from([0x69, 0x56, 0x46, 0x38, 0x2b, 0x20, 0x15, 0x0b]);

export function decryptTencentTea(inBuf, key) {
  const saltLen = 2, zeroLen = 7;
  if (inBuf.length % 8 !== 0) throw new Error('TEA: 输入长度不是 8 的倍数');
  if (inBuf.length < 16) throw new Error('TEA: 输入过短');

  let dest = teaDecryptBlock(inBuf.subarray(0, 8), key, 32);
  const padLen = dest[0] & 0x7;
  const outLen = inBuf.length - 1 - padLen - saltLen - zeroLen;
  if (outLen < 0) throw new Error('TEA: 输出长度非法');
  const out = new Uint8Array(outLen);

  let ivPrev = new Uint8Array(8);
  let ivCur = inBuf.slice(0, 8);
  let pos = 8;
  let destIdx = 1 + padLen;

  const cryptBlock = () => {
    ivPrev = ivCur;
    ivCur = inBuf.slice(pos, pos + 8);
    dest = teaDecryptBlock(xorBytes(dest, ivCur), key, 32);
    pos += 8;
    destIdx = 0;
  };

  for (let i = 1; i <= saltLen;) {
    if (destIdx < 8) { destIdx += 1; i += 1; }
    else if (destIdx === 8) cryptBlock();
    else break;
  }

  let outPos = 0;
  while (outPos < outLen) {
    if (destIdx < 8) {
      out[outPos] = dest[destIdx] ^ ivPrev[destIdx];
      destIdx += 1;
      outPos += 1;
    } else if (destIdx === 8) {
      cryptBlock();
    } else break;
  }

  for (let i = 1; i <= zeroLen; i++) {
    if (destIdx < 8 && dest[destIdx] !== ivPrev[destIdx]) throw new Error('TEA: 校验失败（ekey 可能无效）');
  }
  return out;
}

// rawKey 为文件尾部提取出的 base64 文本（Uint8Array 或 string）
export function decryptQmcKey(rawKey) {
  const raw = decodeBase64(rawKey);
  if (raw.length < 16) throw new Error('QMC ekey 长度不足');
  const teaKeyBytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    teaKeyBytes[i << 1] = SIMPLE_KEY_106_8[i];
    teaKeyBytes[(i << 1) | 1] = raw[i];
  }
  const rs = decryptTencentTea(raw.subarray(8), teaKeyBytes);
  return concat(raw.subarray(0, 8), rs);
}

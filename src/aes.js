// 纯 JS AES-128 (FIPS-197)。实现 ECB 加/解密，不依赖 WebCrypto，
// 因此在 file://、Worker、Node 中行为完全一致。
// 自检向量：key 000102...0f / 密文 69c4e0d8... → 明文 00112233...
import { pkcs7Unpad } from './utils.js';

function gfMul(a, b) {
  let res = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) res ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return res & 0xff;
}

function gfPow(a, n) {
  let r = 1;
  for (let i = 0; i < n; i++) r = gfMul(r, a);
  return r;
}

const rotl8 = (x, s) => ((x << s) | (x >> (8 - s))) & 0xff;

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const inv = i === 0 ? 0 : gfPow(i, 254);
  const s = inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63;
  SBOX[i] = s;
  INV_SBOX[s] = i;
}

function expandKey(key) {
  if (key.length !== 16) throw new Error('AES-128 密钥必须为 16 字节');
  const w = new Uint8Array(176);
  w.set(key);
  const temp = new Uint8Array(4);
  let rcon = 1;
  for (let pos = 16; pos < 176; pos += 4) {
    temp.set(w.subarray(pos - 4, pos));
    if (pos % 16 === 0) {
      const t = temp[0];
      temp[0] = SBOX[temp[1]] ^ rcon;
      temp[1] = SBOX[temp[2]];
      temp[2] = SBOX[temp[3]];
      temp[3] = SBOX[t];
      rcon = gfMul(rcon, 2);
    }
    for (let i = 0; i < 4; i++) w[pos + i] = w[pos - 16 + i] ^ temp[i];
  }
  return w;
}

function addRoundKey(s, w, round) {
  for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
}

function subBytes(s, box) {
  for (let i = 0; i < 16; i++) s[i] = box[s[i]];
}

function shiftRows(s) {
  const t = s.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) s[4 * c + r] = t[4 * ((c + r) % 4) + r];
  }
}

function invShiftRows(s) {
  const t = s.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) s[4 * c + r] = t[4 * ((c - r + 4) % 4) + r];
  }
}

function mixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const o = 4 * c;
    const a0 = s[o], a1 = s[o + 1], a2 = s[o + 2], a3 = s[o + 3];
    s[o] = gfMul(a0, 2) ^ gfMul(a1, 3) ^ a2 ^ a3;
    s[o + 1] = a0 ^ gfMul(a1, 2) ^ gfMul(a2, 3) ^ a3;
    s[o + 2] = a0 ^ a1 ^ gfMul(a2, 2) ^ gfMul(a3, 3);
    s[o + 3] = gfMul(a0, 3) ^ a1 ^ a2 ^ gfMul(a3, 2);
  }
}

function invMixColumns(s) {
  for (let c = 0; c < 4; c++) {
    const o = 4 * c;
    const a0 = s[o], a1 = s[o + 1], a2 = s[o + 2], a3 = s[o + 3];
    s[o] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9);
    s[o + 1] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13);
    s[o + 2] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11);
    s[o + 3] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14);
  }
}

export function aesEncryptBlock(block, expandedKey) {
  const s = Uint8Array.from(block.subarray(0, 16));
  addRoundKey(s, expandedKey, 0);
  for (let round = 1; round <= 9; round++) {
    subBytes(s, SBOX); shiftRows(s); mixColumns(s); addRoundKey(s, expandedKey, round);
  }
  subBytes(s, SBOX); shiftRows(s); addRoundKey(s, expandedKey, 10);
  return s;
}

export function aesDecryptBlock(block, expandedKey) {
  const s = Uint8Array.from(block.subarray(0, 16));
  addRoundKey(s, expandedKey, 10);
  for (let round = 9; round >= 1; round--) {
    invShiftRows(s); subBytes(s, INV_SBOX); addRoundKey(s, expandedKey, round); invMixColumns(s);
  }
  invShiftRows(s); subBytes(s, INV_SBOX); addRoundKey(s, expandedKey, 0);
  return s;
}

export function aesEcbEncrypt(data, key) {
  if (data.length % 16) throw new Error('AES-ECB 输入长度必须是 16 的倍数');
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) out.set(aesEncryptBlock(data.subarray(i, i + 16), w), i);
  return out;
}

export function aesEcbDecrypt(data, key) {
  if (data.length % 16) throw new Error('AES-ECB 输入长度必须是 16 的倍数');
  const w = expandKey(key);
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) out.set(aesDecryptBlock(data.subarray(i, i + 16), w), i);
  return out;
}

export function aesEcbDecryptUnpad(data, key) {
  return pkcs7Unpad(aesEcbDecrypt(data, key));
}

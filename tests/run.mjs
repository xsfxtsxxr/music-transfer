// 解密内核自测：用已知向量 + 自建加密样本做字节级还原校验
// 运行：npm test
import {
  hexToBytes, utf8, fromUtf8, encodeBase64, concat, pkcs7Pad, writeU32le,
  u32le, u32be, bytesToHex,
} from '../src/utils.js';
import { aesEcbEncrypt, aesEcbDecrypt, aesEcbDecryptUnpad } from '../src/aes.js';
import { teaEncryptBlock, teaDecryptBlock, SIMPLE_KEY_106_8, decryptQmcKey } from '../src/tea.js';
import { NCM_CORE_KEY, NCM_META_KEY, buildKeyBox, decryptNcm } from '../src/ncm.js';
import { StaticCipher, MapCipher, Rc4Cipher, decryptQmc } from '../src/qmc.js';
import { generateKwmMask, decryptKwm } from '../src/kwm.js';
import { setKgmMask, decryptKgm } from '../src/kgm.js';
import { sniffAudio } from '../src/sniff.js';
import { decryptFile } from '../src/index.js';
import { makeZip, crc32 } from '../src/zip.js';

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; console.error(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eqBytes(a, b, msg) {
  assert(a.length === b.length, `${msg || ''} 长度不一致: ${a.length} vs ${b.length}`);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) throw new Error(`${msg || ''} 第 ${i} 字节不一致: ${a[i]} vs ${b[i]}`);
  }
}
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(20261125);
function randBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(random() * 256);
  return out;
}
function u32leBytes(v) { const b = new Uint8Array(4); writeU32le(b, 0, v); return b; }
function u32beBytes(v) { return Uint8Array.from([(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]); }
function fakeFlac(n = 8192) {
  const out = randBytes(n);
  out.set(utf8('fLaC'), 0);
  return out;
}

console.log('\n\x1b[1m== 密码学原语 ==\x1b[0m');

check('AES-128 FIPS-197 标准向量（解密）', () => {
  const key = hexToBytes('000102030405060708090a0b0c0d0e0f');
  const ct = hexToBytes('69c4e0d86a7b0430d8cdb78070b4c55a');
  const pt = hexToBytes('00112233445566778899aabbccddeeff');
  eqBytes(aesEcbDecrypt(ct, key), pt, 'AES 解密');
});

check('AES-128 加密/解密往返 + PKCS7', () => {
  const key = hexToBytes('687a4852416d736f356b496e62617857');
  const plain = utf8('neteasecloudmusic' + 'x'.repeat(83));
  const ct = aesEcbEncrypt(pkcs7Pad(plain), key);
  eqBytes(aesEcbDecryptUnpad(ct, key), plain, 'AES 往返');
});

check('TEA 32 轮加解密往返（64 组随机块）', () => {
  const key = randBytes(16);
  for (let i = 0; i < 64; i++) {
    const block = randBytes(8);
    eqBytes(teaDecryptBlock(teaEncryptBlock(block, key), key), block, 'TEA 往返');
  }
});

check('QMC simpleMakeKey(106,8) 预置常量正确', () => {
  assert(bytesToHex(SIMPLE_KEY_106_8) === '695646382b20150b');
});

console.log('\n\x1b[1m== QMC 密钥 TEA 解包（构造合法 ekey 反向校验） ==\x1b[0m');

// 构造 decryptTencentTea 的逆过程，用于生成可供 decryptQmcKey 解包的 ekey
function makeQmcEkey(plaintext, padLen = 3) {
  const saltLen = 2, zeroLen = 7;
  const total = Math.ceil((plaintext.length + 1 + padLen + saltLen + zeroLen) / 8) * 8;
  const blocks = total / 8;
  const outLen = total - 1 - padLen - saltLen - zeroLen;
  assert(outLen === plaintext.length, '构造长度须与明文一致（请使用 8 的倍数友好的长度）');

  const stream = new Uint8Array(total);
  stream[0] = 0x40 | padLen;
  let pos = 1 + padLen;
  stream[pos++] = 0x11; stream[pos++] = 0x22;
  stream.set(plaintext, pos);
  const p = [];
  for (let i = 0; i < blocks; i++) p.push(stream.slice(i * 8, i * 8 + 8));

  const startIdx = 1 + padLen + saltLen;
  const positions = [];
  let destIdx = startIdx;
  for (let k = 0; k < outLen; k++, destIdx++) positions.push({ k, block: destIdx >> 3, j: destIdx & 7 });
  const finalIdx = destIdx;

  const raw8 = randBytes(8); // ekey 前 8 字节，参与 TEA 密钥派生
  const teaKey = new Uint8Array(16);
  for (let i = 0; i < 8; i++) { teaKey[i << 1] = SIMPLE_KEY_106_8[i]; teaKey[(i << 1) | 1] = raw8[i]; }

  const c = [];
  for (let i = 0; i < blocks; i++) {
    const prev = i === 0 ? new Uint8Array(8) : c[i - 1];
    for (const pos of positions) {
      if (pos.block === i) p[i][pos.j] = plaintext[pos.k] ^ prev[pos.j];
    }
    if ((finalIdx >> 3) === i) {
      const j = finalIdx & 7;
      p[i][j] = i === 0 ? 0 : c[i - 1][j]; // 满足末尾零校验
    }
    const enc = teaEncryptBlock(p[i], teaKey);
    c.push(i === 0 ? enc : Uint8Array.from(enc, (b, k) => b ^ p[i - 1][k]));
  }
  return { raw: concat(raw8, ...c), raw8 };
}

for (const [label, size] of [['Map 短密钥', 67], ['RC4 长密钥', 403]]) {
  check(`QMC ${label}：ekey 解包 → 流密码还原`, () => {
    const plain = randBytes(size);
    const { raw, raw8 } = makeQmcEkey(plain);
    const key = decryptQmcKey(encodeBase64(raw));
    eqBytes(key, concat(raw8, plain), 'TEA 解包结果');

    const audio = fakeFlac(4096);
    const enc = Uint8Array.from(audio);
    const cipher = key.length > 300 ? new Rc4Cipher(key) : new MapCipher(key);
    if (cipher instanceof MapCipher) cipher.decrypt(enc, 0);
    else cipher.decrypt(enc, 0);

    // 用 QTag 尾部把 ekey 塞回文件
    const b64 = encodeBase64(raw);
    const metaStr = `${b64},0,0`;
    const metaBytes = utf8(metaStr);
    const file = concat(enc, metaBytes, u32beBytes(metaBytes.length), utf8('QTag'));
    const out = decryptQmc(file);
    eqBytes(out.data, audio, 'QMC 音频还原');
    assert(out.hasKey === true, '应识别出 ekey');
    assert(out.cipher === (key.length > 300 ? 'rc4' : 'map'), '密码类型判断');
  });
}

check('QMC 静态掩码：自反 + 完整管线', () => {
  const audio = fakeFlac(4096);
  const enc = Uint8Array.from(audio);
  new StaticCipher().decrypt(enc, 0);
  // 保证尾部 4 字节不会被误判成 ekey 长度
  enc[enc.length - 4] = 0x00; enc[enc.length - 3] = 0x10; enc[enc.length - 2] = 0x00; enc[enc.length - 1] = 0x00;
  const expected = Uint8Array.from(enc);
  new StaticCipher().decrypt(expected, 0);
  const out = decryptQmc(enc);
  eqBytes(out.data, expected, '静态掩码还原');
  assert(out.cipher === 'static');
  assert(sniffAudio(out.data).ext === '.flac', '应嗅探为 FLAC');
});

console.log('\n\x1b[1m== NCM 容器 ==\x1b[0m');

function makeNcmSample(audio, key, metadata, cover) {
  const keyData = concat(utf8('neteasecloudmusic'), key);
  const keyEnc = aesEcbEncrypt(pkcs7Pad(keyData), NCM_CORE_KEY);
  const keyRaw = Uint8Array.from(keyEnc, (b) => b ^ 0x64);
  const metaStr = 'music:' + JSON.stringify(metadata);
  const metaEnc = aesEcbEncrypt(pkcs7Pad(utf8(metaStr)), NCM_META_KEY);
  const prefix = utf8("163 key(Don't modify):");
  assert(prefix.length === 22, '元数据前缀应为 22 字节');
  const metaBlock = Uint8Array.from(concat(prefix, utf8(encodeBase64(metaEnc))), (b) => b ^ 0x63);
  const box = buildKeyBox(key);
  const encAudio = Uint8Array.from(audio, (b, i) => b ^ box[i & 0xff]);
  return concat(
    utf8('CTENFDAM'), new Uint8Array(2), u32leBytes(keyRaw.length), keyRaw,
    u32leBytes(metaBlock.length), metaBlock,
    new Uint8Array(4), new Uint8Array(5), u32leBytes(cover.length), cover,
    encAudio
  );
}

check('NCM 密钥盒自反性', () => {
  const key = randBytes(16);
  const box = buildKeyBox(key);
  const audio = randBytes(1000);
  const enc = Uint8Array.from(audio, (b, i) => b ^ box[i & 0xff]);
  eqBytes(Uint8Array.from(enc, (b, i) => b ^ box[i & 0xff]), audio, '密钥盒往返');
});

check('NCM：构造合法容器 → 音频/元数据/封面完整还原', () => {
  const audio = fakeFlac(12000);
  const key = randBytes(16);
  const metadata = { musicName: '夜航西飞', artist: [['测试歌手', 123]], album: '样例专辑', format: 'flac' };
  const cover = concat(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), randBytes(256));
  const file = makeNcmSample(audio, key, metadata, cover);

  const res = decryptNcm(file);
  eqBytes(res.data, audio, 'NCM 音频流');
  assert(res.meta.title === '夜航西飞', `歌名错误: ${res.meta.title}`);
  assert(res.meta.artist === '测试歌手', `歌手错误: ${res.meta.artist}`);
  assert(res.meta.album === '样例专辑', '专辑错误');
  assert(res.meta.format === 'flac', '格式字段');
  eqBytes(res.meta.cover.bytes, cover, '封面');
  assert(res.meta.cover.mime === 'image/jpeg', '封面 MIME');

  const full = decryptFile(file, 'download_001.ncm');
  assert(full.ext === '.flac', '输出扩展名');
  assert(full.platform === 'netease', '平台识别');
  assert(full.suggestedName === '测试歌手 - 夜航西飞.flac', `输出文件名: ${full.suggestedName}`);
  assert(full.methodLabel.includes('AES'), '方法标签');
});

console.log('\n\x1b[1m== KWM / KGM ==\x1b[0m');

check('KWM：派生掩码往返 + 完整管线', () => {
  const audio = fakeFlac(6000);
  const header = new Uint8Array(1024);
  header.set(hexToBytes('7965656c696f6e2d6b75776f2d746d65'), 0);
  const fileKey = randBytes(8);
  header.set(fileKey, 0x18);
  const mask = generateKwmMask(fileKey);
  assert(mask.length === 32);
  const enc = Uint8Array.from(audio, (b, i) => b ^ mask[i & 0x1f]);
  const res = decryptKwm(concat(header, enc));
  eqBytes(res.data, audio, 'KWM 音频流');
  const full = decryptFile(concat(header, enc), 'track.kwm');
  assert(full.ext === '.flac' && full.platform === 'kuwo');
});

check('KGM：带掩码表时逐字节还原（与参考公式一致）', () => {
  const audio = fakeFlac(9000);
  const key = concat(randBytes(16), Uint8Array.from([0]));
  const pub = randBytes(Math.ceil(audio.length / 16) + 16);
  const transform = (v) => (v ^ ((v & 0x0f) << 4)) & 0xff;
  assert(transform(transform(0xb9)) === 0xb9, '低 4 位变换应自逆');
  setKgmMask(pub);
  const header = new Uint8Array(0x400);
  header.set(hexToBytes('7cd532eb86027f4ba8afa68e0fff9914'), 0);
  writeU32le(header, 0x10, 0x400);
  header.set(key.subarray(0, 16), 0x1c);
  const realMaskV2 = hexToBytes(
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
  // 加密是解密的逆：enc = transform(plain) ^ K（transform 与 XOR 不交换，顺序不能反）
  const realEnc = Uint8Array.from(audio, (b, i) => {
    const k = key[i % 17] ^ realMaskV2[i % 272] ^ pub[i >> 4];
    return transform(b) ^ k;
  });
  const res = decryptKgm(concat(header, realEnc));
  eqBytes(res.data, audio, 'KGM 音频流');
  const full = decryptFile(concat(header, realEnc), 'song.kgm');
  assert(full.ext === '.flac' && full.platform === 'kugou');
});

check('KGM：未加载掩码表时明确报错而非产出坏文件', () => {
  setKgmMask(new Uint8Array(0));
  const header = new Uint8Array(0x400);
  header.set(hexToBytes('7cd532eb86027f4ba8afa68e0fff9914'), 0);
  writeU32le(header, 0x10, 0x400);
  let code = '';
  try { decryptFile(concat(header, randBytes(100)), 'x.kgm'); } catch (e) { code = e.code; }
  assert(code === 'NEED_KGM_MASK', `应返回 NEED_KGM_MASK，实际 ${code}`);
});

console.log('\n\x1b[1m== 分发层 ==\x1b[0m');

check('格式嗅探：MP3 / FLAC / OGG / M4A / WAV', () => {
  const mk = (magic, offset = 0) => { const b = new Uint8Array(32); b.set(utf8(magic), offset); return b; };
  assert(sniffAudio(mk('ID3')).ext === '.mp3');
  assert(sniffAudio(Uint8Array.from([0xff, 0xfb, 0x90, 0x00, ...new Array(28).fill(0)])).ext === '.mp3');
  assert(sniffAudio(mk('fLaC')).ext === '.flac');
  assert(sniffAudio(mk('OggS')).ext === '.ogg');
  assert(sniffAudio(mk('ftyp', 4)).ext === '.m4a');
  const wav = new Uint8Array(32); wav.set(utf8('RIFF'), 0); wav.set(utf8('WAVE'), 8);
  assert(sniffAudio(wav).ext === '.wav');
});

check('仅后缀伪装的普通音频：原样返回并修正扩展名', () => {
  const audio = fakeFlac(2048);
  const res = decryptFile(audio, '伪装成加密的歌.ncm');
  eqBytes(res.data, audio, '字节应完全不变');
  assert(res.ext === '.flac' && res.method === 'plain');
});

check('新版需服务器密钥的变体：明确拒绝', () => {
  let code = '';
  try { decryptFile(randBytes(2048), 'new.kgg'); } catch (e) { code = e.code; }
  assert(code === 'NEEDS_SERVER_KEY', `实际 ${code}`);
  code = '';
  try { decryptFile(randBytes(2048), 'x.kwma'); } catch (e) { code = e.code; }
  assert(code === 'NEEDS_SERVER_KEY', `实际 ${code}`);
});

check('损坏/无法识别的数据不会被当成成功结果', () => {
  let code = '';
  try { decryptFile(randBytes(2048), 'broken.unknown'); } catch (e) { code = e.code; }
  assert(code === 'UNSUPPORTED', `实际 ${code}`);
});

check('ZIP store 结构可完整回读（含中文名与 CRC）', () => {
  const a = utf8('hello flac bytes');
  const b = randBytes(777);
  const zip = makeZip([{ name: '歌手 - 曲目.flac', data: a }, { name: 'cover.jpg', data: b }]);
  assert(u32le(zip, 0) === 0x04034b50, '本地头签名');
  // 遍历本地文件头
  let pos = 0, count = 0;
  while (u32le(zip, pos) === 0x04034b50) {
    const nameLen = zip[pos + 26] | (zip[pos + 27] << 8);
    const size = u32le(zip, pos + 18);
    const name = fromUtf8(zip.subarray(pos + 30, pos + 30 + nameLen));
    const data = zip.subarray(pos + 30 + nameLen, pos + 30 + nameLen + size);
    const crc = u32le(zip, pos + 14);
    assert(crc32(data) === crc, `CRC 校验失败: ${name}`);
    if (count === 0) { assert(name === '歌手 - 曲目.flac'); eqBytes(data, a); }
    if (count === 1) { assert(name === 'cover.jpg'); eqBytes(data, b); }
    pos += 30 + nameLen + size;
    count++;
  }
  assert(count === 2, `条目数应为 2，实际 ${count}`);
  assert(u32le(zip, pos) === 0x02014b50, '中央目录签名');
  const eocd = zip.length - 22;
  assert(u32le(zip, eocd) === 0x06054b50, 'EOCD 签名');
  assert((zip[eocd + 8] | (zip[eocd + 9] << 8)) === 2, 'EOCD 条目数');
});

console.log(`\n\x1b[1m结果：${passed} 通过 / ${failed} 失败\x1b[0m\n`);
process.exit(failed ? 1 : 0);

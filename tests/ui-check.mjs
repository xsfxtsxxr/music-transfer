// 真实浏览器 UI 端到端冒烟测试（Chrome DevTools Protocol，零依赖）
// 前置：npm run dev 已在 4173 端口运行（或设置 APP_URL 指向线上地址）
// 运行：node tests/ui-check.mjs
//      APP_URL=https://<线上地址> node tests/ui-check.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const CHROME = CHROME_CANDIDATES.find(existsSync);
const PORT = 9223;
const APP = process.env.APP_URL || 'http://localhost:4173/';
const PROFILE = process.env.CHROME_PROFILE || '/tmp/unlocktune-cdp-profile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!CHROME) { console.error('未找到 Chrome / Edge，跳过 UI 冒烟测试'); process.exit(0); }

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--disable-extensions', '--disable-background-networking',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  'about:blank',
], { stdio: 'ignore' });

let ws;
try {
  let version = null;
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://localhost:${PORT}/json/version`)).json(); break; }
    catch { await sleep(200); }
  }
  if (!version) throw new Error('Chrome 调试端口未就绪');

  const created = await (await fetch(`http://localhost:${PORT}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json();
  ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  // 线上首次访问可能经历鉴权重定向，等 DOM 与格式矩阵真正就绪再注入
  for (let i = 0; i < 60; i++) {
    const ready = await send('Runtime.evaluate', {
      expression: '!!(document.getElementById("fileInput") && document.querySelector("#matrixTable tbody tr"))',
      returnByValue: true,
    });
    if (ready.result && ready.result.result && ready.result.result.value === true) break;
    await sleep(250);
  }

  const expression = `(async () => {
    const url = location.href;
    const mod = (p) => import(new URL(p, location.href).href);
    const u = await mod('/src/utils.js');
    const aes = await mod('/src/aes.js');
    const ncm = await mod('/src/ncm.js');
    const { utf8, concat, pkcs7Pad, hexToBytes, encodeBase64, writeU32le } = u;
    const u32 = (v) => { const b = new Uint8Array(4); writeU32le(b, 0, v); return b; };
    const audio = new Uint8Array(4096);
    for (let i = 0; i < audio.length; i++) audio[i] = (i * 37 + 11) & 255;
    audio.set(utf8('fLaC'), 0);
    const key = hexToBytes('00112233445566778899aabbccddeeff');
    const keyRaw = Uint8Array.from(aes.aesEcbEncrypt(pkcs7Pad(concat(utf8('neteasecloudmusic'), key)), ncm.NCM_CORE_KEY), (b) => b ^ 0x64);
    const metaStr = 'music:' + JSON.stringify({ musicName: '端到端测试', artist: [['歌手', 1]], album: '专辑', format: 'flac' });
    const metaEnc = aes.aesEcbEncrypt(pkcs7Pad(utf8(metaStr)), ncm.NCM_META_KEY);
    const metaBlock = Uint8Array.from(concat(utf8("163 key(Don't modify):"), utf8(encodeBase64(metaEnc))), (b) => b ^ 0x63);
    const box = ncm.buildKeyBox(key);
    const encAudio = Uint8Array.from(audio, (b, i) => b ^ box[i & 255]);
    const bytes = concat(utf8('CTENFDAM'), new Uint8Array(2), u32(keyRaw.length), keyRaw,
      u32(metaBlock.length), metaBlock, new Uint8Array(9), u32(0), encAudio);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'demo.ncm'));
    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 120; i++) {
      const card = document.querySelector('.file-card.done');
      if (card) return { ok: true, url, done: document.getElementById('statDone').textContent,
        total: document.getElementById('statTotal').textContent,
        name: card.querySelector('.fc-name').textContent,
        result: card.querySelector('.fc-result').textContent.trim(),
        hasDownload: !!card.querySelector('.fc-actions .btn') };
      const err = document.querySelector('.file-card.error');
      if (err) return { ok: false, error: err.querySelector('.fc-error').textContent };
      await new Promise((r) => setTimeout(r, 100));
    }
    return { ok: false, error: 'timeout', total: document.getElementById('statTotal').textContent };
  })()`;

  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.result && res.result.exceptionDetails) {
    throw new Error('页面脚本异常: ' + JSON.stringify(res.result.exceptionDetails.exception || res.result.exceptionDetails.text));
  }
  const value = res.result && res.result.result && res.result.result.value;
  console.log('\n== UI 端到端结果 ==');
  console.log(JSON.stringify(value, null, 2));
  if (!value || !value.ok) process.exitCode = 1;
  else if (value.done !== '1' || !value.hasDownload || !value.result.includes('.flac')) {
    console.error('结果卡片状态不符合预期');
    process.exitCode = 1;
  } else {
    console.log('\nUI 端到端：通过');
  }
} catch (err) {
  console.error('UI 冒烟测试失败：', err.message);
  process.exitCode = 1;
} finally {
  if (ws) ws.close();
  chrome.kill();
}

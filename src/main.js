import { formatSize, fileExtension, stripExtension, safeName } from './utils.js';
import { decryptFile, PLATFORM } from './index.js';
import { setKgmMask } from './kgm.js';
import { makeZip } from './zip.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
};

const state = {
  items: new Map(),
  nextItemId: 1,
  nextTaskId: 1,
  queue: [],
  handlers: new Map(),
  slots: [],
  useWorkers: true,
  mask: null,
  maskName: '',
  mainRunning: false,
};

const refs = {
  dropzone: $('#dropzone'), fileInput: $('#fileInput'), fileList: $('#fileList'),
  emptyState: $('#emptyState'), statTotal: $('#statTotal'), statDone: $('#statDone'),
  statFailed: $('#statFailed'), statSize: $('#statSize'),
  btnDownloadAll: $('#btnDownloadAll'), btnRetry: $('#btnRetry'), btnClear: $('#btnClear'),
  maskDrop: $('#maskDrop'), maskInput: $('#maskInput'), maskStatus: $('#maskStatus'),
  maskPanel: $('#maskPanel'), toast: $('#toast'), matrixBody: $('#matrixTable tbody'),
};

let toastTimer = null;
function toast(msg) {
  refs.toast.textContent = msg;
  refs.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => refs.toast.classList.remove('show'), 3200);
}

// ---------------------------------------------------------------- 格式矩阵
const MATRIX = [
  { platform: '网易云音乐', color: '#f0473e', exts: '.ncm', algo: 'AES-128 解出音频密钥 → 256 字节密钥盒循环异或；同时解析曲目信息与封面', status: 'ok', label: '完全离线可解' },
  { platform: 'QQ 音乐（老版）', color: '#31c48d', exts: '.qmc / .qmc0 / .qmc2 / .qmc3 / .qmc4 / .qmc6 / .qmc8 / .qmcflac / .qmcogg / .tkm', algo: '静态掩码；文件尾若带 ekey 则 TEA 解包后走 Map / RC4 流密码', status: 'ok', label: '完全离线可解', note: '含 Moo 音乐 .bkc* 系列' },
  { platform: 'QQ 音乐（新版）', color: '#31c48d', exts: '.mflac / .mflac0 / .mgg / .mgg1 / .mggl / .mgg0 / .mma3', algo: '带本地 ekey 的可解；musicex 尾部密钥需 QQ 音乐服务器下发', status: 'partial', label: '部分可解', note: '新版变体多数需要服务器密钥，本站会明确报错' },
  { platform: '酷狗音乐（老版）', color: '#3b9dff', exts: '.kgm / .vpr / .kgma', algo: '17 字节私钥 + 272 字节修正表 + 静态大掩码表逐字节异或', status: 'mask', label: '需导入密钥表', note: '密钥表由用户本地提供，本站不内置、不联网下载' },
  { platform: '酷狗音乐（新版）', color: '#3b9dff', exts: '.kgg / .vgm / 部分 .kgma', algo: '密钥绑定客户端数据库 / 账号体系，离线无法推导', status: 'no', label: '不支持' },
  { platform: '酷我音乐', color: '#f5a623', exts: '.kwm', algo: '文件头资源 ID 派生 32 字节掩码，音频流自 1024 字节起循环异或', status: 'ok', label: '完全离线可解' },
  { platform: '酷我音乐（新版）', color: '#f5a623', exts: '.kwma / 复用 .mflac 的高画质与母带', algo: '沿用平台新版密钥体系，需服务器下发', status: 'no', label: '不支持' },
  { platform: '通用', color: '#9aa6b8', exts: '任意后缀但内容已是标准音频', algo: '按文件魔数嗅探真实格式，仅修正扩展名，不改动任何字节', status: 'ok', label: '完全离线可解', note: '网盘转存文件常见这种情况' },
];

function renderMatrix() {
  for (const row of MATRIX) {
    const tr = el('tr');
    const td1 = el('td');
    const dot = el('span', 'platform-mark');
    dot.style.background = row.color;
    td1.append(dot, document.createTextNode(row.platform));
    const td2 = el('td', 'exts', row.exts);
    const td3 = el('td', 'algo', row.algo);
    const td4 = el('td');
    td4.append(el('span', `status-pill ${row.status}`, row.label));
    if (row.note) td4.append(el('span', 'note', row.note));
    tr.append(td1, td2, td3, td4);
    refs.matrixBody.append(tr);
  }
}

// ---------------------------------------------------------------- 平台推断
const QMC_EXTS = new Set(['qmc', 'qmc0', 'qmc2', 'qmc3', 'qmc4', 'qmc6', 'qmc8', 'qmcflac', 'qmcogg', 'tkm', 'mflac', 'mflac0', 'mflac1', 'mgg', 'mgg0', 'mgg1', 'mgg2', 'mgg3', 'mggl', 'mma3', 'bkcmp3', 'bkcflac', 'bkcm4a', 'bkcogg', 'bkcwav', 'bkcape', 'bkcwma']);
function guessPlatform(name) {
  const ext = fileExtension(name);
  if (ext === 'ncm') return 'netease';
  if (QMC_EXTS.has(ext) || ext.startsWith('qmc') || ext.startsWith('666c')) return 'qq';
  if (['kgm', 'kgma', 'vpr', 'kgg', 'vgm'].includes(ext)) return 'kugou';
  if (['kwm', 'kwma'].includes(ext)) return 'kuwo';
  return 'plain';
}
const PLATFORM_ICON = { netease: '网易', qq: 'QQ', kugou: '酷狗', kuwo: '酷我', plain: '音频' };

// ---------------------------------------------------------------- 卡片渲染
function buildCard(item) {
  const card = el('div', 'file-card');
  card.dataset.id = String(item.id);

  const top = el('div', 'fc-top');
  const icon = el('div', 'fc-icon');
  const main = el('div', 'fc-main');
  const name = el('div', 'fc-name', item.name);
  const sub = el('div', 'fc-sub');
  const tag = el('span', 'tag');
  const size = el('span', '', formatSize(item.size));
  const method = el('span', '', '等待处理');
  sub.append(tag, size, method);
  main.append(name, sub);
  const status = el('div', 'fc-status', '排队中');
  const remove = el('button', 'fc-remove', '×');
  remove.title = '移除';
  remove.addEventListener('click', () => removeItem(item));
  top.append(icon, main, status, remove);

  const track = el('div', 'progress-track');
  const fill = el('div', 'progress-fill');
  track.append(fill);

  const bottom = el('div', 'fc-bottom');
  const result = el('div', 'fc-result');
  const actions = el('div', 'fc-actions');
  bottom.append(result, actions);
  const err = el('div', 'fc-error');

  card.append(top, track, bottom, err);
  item.el = card;
  item.ui = { icon, tag, method, status, fill, result, actions, err };
  refs.fileList.append(card);
  updateCard(item);
}

function updateCard(item) {
  const u = item.ui;
  if (!u) return;
  const platform = item.platform || guessPlatform(item.name);
  const info = PLATFORM[platform] || PLATFORM.plain;
  u.icon.textContent = PLATFORM_ICON[platform] || '音频';
  u.icon.style.color = info.color;
  u.icon.style.background = `${info.color}18`;
  u.icon.style.borderColor = `${info.color}44`;
  u.tag.textContent = info.short;
  u.tag.style.color = info.color;
  u.tag.style.borderColor = `${info.color}44`;
  u.tag.style.background = `${info.color}14`;
  u.method.textContent = item.methodLabel ? `· ${item.methodLabel}` : '';

  const cls = ['file-card'];
  if (item.status === 'done') cls.push('done');
  if (item.status === 'error') cls.push('error');
  item.el.className = cls.join(' ');

  const labels = { queued: '排队中', running: '解密中', done: '已完成', error: '失败' };
  u.status.className = `fc-status ${item.status}`;
  u.status.textContent = item.status === 'running'
    ? `${Math.round(item.progress * 100)}%`
    : labels[item.status];
  u.fill.style.width = `${Math.round(item.progress * 100)}%`;

  u.result.replaceChildren();
  u.actions.replaceChildren();
  u.err.textContent = '';

  if (item.status === 'done' && item.result) {
    const r = item.result;
    if (r.coverUrl) {
      const img = el('img', 'cover-thumb');
      img.src = r.coverUrl;
      img.alt = '专辑封面';
      u.result.append(img);
    }
    const arrow = el('span', 'arrow', '→');
    const text = el('div', 'meta-text');
    text.append(el('b', '', r.suggestedName));
    text.append(el('span', 'fc-meta-sub', `${r.formatLabel} · ${formatSize(r.audio.length)}${r.meta.title ? ` · ${r.meta.title}${r.meta.artist ? ' / ' + r.meta.artist : ''}` : ''}`));
    u.result.append(arrow, text);

    const dl = el('button', 'btn primary tiny', '下载音频');
    dl.addEventListener('click', () => downloadItem(item));
    u.actions.append(dl);
    if (r.coverBytes) {
      const cv = el('button', 'btn ghost tiny', '下载封面');
      cv.addEventListener('click', () => downloadCover(item));
      u.actions.append(cv);
    }
  } else if (item.status === 'error') {
    u.err.textContent = item.error || '处理失败';
    const retry = el('button', 'btn ghost tiny', '重试');
    retry.addEventListener('click', () => { resetItem(item); enqueue(item); schedule(); });
    u.actions.append(retry);
    if (item.code === 'NEED_KGM_MASK') {
      const jump = el('button', 'btn ghost tiny', '去导入密钥表');
      jump.addEventListener('click', () => refs.maskPanel.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      u.actions.append(jump);
    }
  }
}

function updateStats() {
  const items = [...state.items.values()];
  const done = items.filter((i) => i.status === 'done');
  const failed = items.filter((i) => i.status === 'error');
  refs.statTotal.textContent = String(items.length);
  refs.statDone.textContent = String(done.length);
  refs.statFailed.textContent = String(failed.length);
  refs.statSize.textContent = formatSize(done.reduce((n, i) => n + (i.result ? i.result.audio.length : 0), 0));
  refs.btnDownloadAll.disabled = done.length === 0;
  refs.btnRetry.disabled = failed.length === 0;
  refs.btnClear.disabled = items.length === 0;
  refs.emptyState.style.display = items.length ? 'none' : 'block';
}

function addFiles(files) {
  const list = [...files].filter((f) => f && f.size > 0);
  if (!list.length) return;
  for (const file of list) {
    const item = {
      id: state.nextItemId++, file, name: file.name, size: file.size,
      status: 'queued', progress: 0, result: null, error: '', code: '',
      platform: null, methodLabel: '', cancelled: false,
    };
    state.items.set(item.id, item);
    buildCard(item);
    enqueue(item);
  }
  updateStats();
  toast(`已加入 ${list.length} 个文件，开始处理`);
  schedule();
}

function removeItem(item) {
  if (!state.items.has(item.id)) return;
  item.cancelled = true;
  const idx = state.queue.findIndex((t) => t.item.id === item.id);
  if (idx >= 0) state.queue.splice(idx, 1);
  if (item.result && item.result.coverUrl) URL.revokeObjectURL(item.result.coverUrl);
  state.items.delete(item.id);
  item.el.remove();
  updateStats();
}

function resetItem(item) {
  if (item.result && item.result.coverUrl) URL.revokeObjectURL(item.result.coverUrl);
  item.status = 'queued'; item.progress = 0; item.result = null;
  item.error = ''; item.code = ''; item.platform = null; item.methodLabel = ''; item.cancelled = false;
  updateCard(item);
  updateStats();
}

function enqueue(item) {
  item.status = 'queued'; item.progress = 0;
  updateCard(item);
  state.queue.push({ item });
}

function updateProgress(item, p) {
  if (!state.items.has(item.id) || item.status !== 'running') return;
  item.progress = Math.max(item.progress, Math.min(1, p));
  item.ui.fill.style.width = `${Math.round(item.progress * 100)}%`;
  item.ui.status.textContent = `${Math.round(item.progress * 100)}%`;
}

function completeItem(item, result) {
  if (!state.items.has(item.id) || item.cancelled) { updateStats(); return; }
  const audio = new Uint8Array(result.audioBuffer);
  let coverUrl = null, coverBytes = null;
  const cover = result.meta && result.meta.cover;
  if (cover && cover.coverBuffer && cover.coverBuffer.byteLength) {
    coverBytes = new Uint8Array(cover.coverBuffer);
    if (coverBytes.length > 8) coverUrl = URL.createObjectURL(new Blob([coverBytes], { type: cover.mime || 'image/jpeg' }));
  }
  item.result = {
    audio, coverUrl, coverBytes, coverMime: cover ? (cover.mime || 'image/jpeg') : null,
    ext: result.ext, formatLabel: result.formatLabel, mime: result.mime,
    suggestedName: result.suggestedName, meta: result.meta || {},
  };
  item.status = 'done'; item.progress = 1;
  item.platform = result.platform; item.methodLabel = result.methodLabel;
  updateCard(item); updateStats();
}

function failItem(item, message, code) {
  if (!state.items.has(item.id) || item.cancelled) { updateStats(); return; }
  item.status = 'error'; item.error = message || '处理失败'; item.code = code || 'DECRYPT_FAILED';
  item.progress = 1;
  updateCard(item); updateStats();
}

// ---------------------------------------------------------------- 调度与 Worker
function initWorkers() {
  if (location.protocol === 'file:') { state.useWorkers = false; return; }
  try {
    const count = Math.min(3, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = onWorkerMessage;
      worker.onerror = (e) => {
        console.error('Worker 异常，切换为主线程模式', e.message);
        const slot = state.slots.find((s) => s.worker === worker);
        if (slot) slot.dead = true;
        state.useWorkers = false;
        scheduleMain();
      };
      state.slots.push({ worker, busy: false, dead: false });
    }
    broadcastMask();
  } catch (err) {
    console.warn('Worker 不可用，使用主线程模式', err);
    state.useWorkers = false;
    state.slots = [];
  }
}

function broadcastMask() {
  if (!state.mask || !state.useWorkers) return;
  for (const slot of state.slots) {
    if (slot.dead) continue;
    try { slot.worker.postMessage({ id: 0, type: 'SET_MASK', payload: { mask: state.mask.slice() } }); } catch { /* 忽略 */ }
  }
}

function onWorkerMessage(event) {
  const msg = event.data || {};
  if (msg.type === 'MASK_OK' || msg.type === 'PROGRESS') {
    if (msg.type === 'PROGRESS') {
      const h = state.handlers.get(msg.id);
      if (h) updateProgress(h.task.item, msg.progress);
    }
    return;
  }
  const h = state.handlers.get(msg.id);
  if (!h) return;
  state.handlers.delete(msg.id);
  h.slot.busy = false;
  if (msg.type === 'DONE') completeItem(h.task.item, msg.result);
  else if (msg.type === 'ERROR') failItem(h.task.item, msg.message, msg.code);
  schedule();
}

function schedule() {
  state.queue = state.queue.filter((t) => !t.item.cancelled && state.items.has(t.item.id));
  if (!state.useWorkers) { scheduleMain(); return; }
  for (const slot of state.slots) {
    if (slot.busy || slot.dead || !state.queue.length) continue;
    const task = state.queue.shift();
    if (!task || task.item.cancelled || !state.items.has(task.item.id)) continue;
    slot.busy = true;
    const id = state.nextTaskId++;
    state.handlers.set(id, { task, slot });
    task.item.status = 'running';
    updateCard(task.item);
    task.item.file.arrayBuffer().then((buffer) => {
      if (task.item.cancelled) {
        state.handlers.delete(id); slot.busy = false; schedule(); return;
      }
      slot.worker.postMessage({ id, type: 'DECRYPT', payload: { buffer, name: task.item.name } }, [buffer]);
    }).catch((err) => {
      state.handlers.delete(id); slot.busy = false;
      failItem(task.item, `读取文件失败：${err.message}`, 'READ_ERROR');
      schedule();
    });
  }
}

// file:// 或 Worker 不可用时的降级路径（顺序处理，避免阻塞过久）
async function scheduleMain() {
  if (state.mainRunning) return;
  state.mainRunning = true;
  while (state.queue.length) {
    const task = state.queue.shift();
    const item = task.item;
    if (item.cancelled || !state.items.has(item.id)) continue;
    item.status = 'running';
    updateCard(item);
    try {
      const buffer = await item.file.arrayBuffer();
      if (state.mask) setKgmMask(state.mask);
      const result = decryptFile(new Uint8Array(buffer), item.name, (p) => updateProgress(item, p));
      completeItem(item, {
        audioBuffer: result.data.buffer, ext: result.ext, formatLabel: result.formatLabel,
        mime: result.mime, platform: result.platform, methodLabel: result.methodLabel,
        suggestedName: result.suggestedName,
        coverMime: result.meta.cover ? (result.meta.cover.mime || 'image/jpeg') : null,
        meta: {
          title: result.meta.title || '', artist: result.meta.artist || '', album: result.meta.album || '',
          cover: result.meta.cover ? { coverBuffer: result.meta.cover.bytes.buffer, mime: result.meta.cover.mime } : null,
        },
      });
    } catch (err) {
      failItem(item, err.message, err.code);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  state.mainRunning = false;
}

// ---------------------------------------------------------------- 下载
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function downloadItem(item) {
  if (!item.result) return;
  triggerDownload(new Blob([item.result.audio], { type: item.result.mime }), item.result.suggestedName);
}

function coverExtension(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

function downloadCover(item) {
  const r = item.result;
  if (!r || !r.coverBytes) return;
  const mime = r.coverMime || 'image/jpeg';
  const ext = coverExtension(mime);
  const base = stripExtension(r.suggestedName);
  triggerDownload(new Blob([r.coverBytes], { type: mime }), `${base}_cover.${ext}`);
}

function downloadAll() {
  const done = [...state.items.values()].filter((i) => i.status === 'done' && i.result);
  if (!done.length) { toast('还没有可下载的文件'); return; }
  const entries = [];
  const used = new Set();
  const uniqueName = (name) => {
    if (!used.has(name)) { used.add(name); return name; }
    const dot = name.lastIndexOf('.');
    const base = dot < 0 ? name : name.slice(0, dot);
    const ext = dot < 0 ? '' : name.slice(dot);
    let k = 2;
    while (used.has(`${base} (${k})${ext}`)) k++;
    const final = `${base} (${k})${ext}`;
    used.add(final);
    return final;
  };
  for (const item of done) {
    const r = item.result;
    entries.push({ name: uniqueName(r.suggestedName), data: r.audio });
    if (r.coverBytes && r.coverBytes.length > 8) {
      const mime = r.coverMime || 'image/jpeg';
      const ext = coverExtension(mime);
      entries.push({ name: uniqueName(`${stripExtension(r.suggestedName)}_cover.${ext}`), data: r.coverBytes });
    }
  }
  try {
    const zip = makeZip(entries);
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    triggerDownload(new Blob([zip], { type: 'application/zip' }), `音锁-解锁文件-${stamp}.zip`);
    toast(`已打包 ${done.length} 首音频（${formatSize(zip.length)}）`);
  } catch (err) {
    toast(`打包失败：${err.message}`);
  }
}

// ---------------------------------------------------------------- 密钥表
function updateMaskStatus() {
  refs.maskStatus.replaceChildren();
  const dot = el('span', `status-dot ${state.mask ? 'ready' : 'muted'}`);
  const text = state.mask
    ? `已加载 ${state.maskName} · ${formatSize(state.mask.length)} · 最大支持单文件约 ${formatSize(state.mask.length * 16)}`
    : '未加载 · KGM / VPR 暂不可用';
  refs.maskStatus.append(dot, el('span', '', text));
}

async function loadMask(file) {
  try {
    let bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持 gzip 解压，请先在本机解压为 .bin');
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (bytes.length > 6 && bytes[0] === 0xfd && bytes[1] === 0x37) {
      throw new Error('检测到 xz 压缩格式，浏览器无法直接解压，请先在本机解压为 .bin 后重试');
    }
    if (bytes.length < 4096) throw new Error('密钥表过小，可能不是有效的 kgm.maskfile');
    state.mask = bytes;
    state.maskName = file.name;
    setKgmMask(bytes);
    broadcastMask();
    updateMaskStatus();
    toast(`密钥表已加载，可处理约 ${formatSize(bytes.length * 16)} 以内的单个文件`);
  } catch (err) {
    toast(`密钥表加载失败：${err.message}`);
  }
}

async function tryAutoLoadMask() {
  try {
    const res = await fetch('./kgm.maskfile', { method: 'GET' });
    if (!res.ok) return;
    const blob = await res.blob();
    if (blob.size < 4096) return;
    await loadMask(new File([blob], 'kgm.maskfile'));
  } catch { /* 站点未放置密钥表时静默跳过 */ }
}

// ---------------------------------------------------------------- 事件绑定
function bindDrop(target, onFiles, dragClass = 'dragover') {
  ['dragenter', 'dragover'].forEach((type) => target.addEventListener(type, (e) => {
    e.preventDefault(); e.stopPropagation(); target.classList.add(dragClass);
  }));
  ['dragleave', 'drop'].forEach((type) => target.addEventListener(type, (e) => {
    e.preventDefault(); e.stopPropagation();
    if (type === 'dragleave' && target.contains(e.relatedTarget)) return;
    target.classList.remove(dragClass);
  }));
  target.addEventListener('drop', (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) onFiles(files);
  });
}

refs.dropzone.addEventListener('click', (e) => {
  if (e.target === refs.fileInput) return; // 避免程序化 click 冒泡造成递归
  refs.fileInput.click();
});
refs.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); refs.fileInput.click(); }
});
refs.fileInput.addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});
bindDrop(refs.dropzone, addFiles);
bindDrop(document, (files) => {
  addFiles(files);
  refs.dropzone.scrollIntoView({ behavior: 'smooth', block: 'center' });
}, 'dragover');

refs.maskInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) loadMask(e.target.files[0]);
  e.target.value = '';
});
bindDrop(refs.maskDrop, (files) => { if (files[0]) loadMask(files[0]); });
// 文件拖到密钥表区域时不要同时被全局拖放接管
refs.maskDrop.addEventListener('drop', (e) => e.stopPropagation());

refs.btnDownloadAll.addEventListener('click', downloadAll);
refs.btnRetry.addEventListener('click', () => {
  const failed = [...state.items.values()].filter((i) => i.status === 'error');
  for (const item of failed) { resetItem(item); enqueue(item); }
  if (failed.length) { schedule(); toast(`已重新排队 ${failed.length} 个失败项`); }
});
refs.btnClear.addEventListener('click', () => {
  for (const item of [...state.items.values()]) removeItem(item);
  state.queue = [];
  updateStats();
});

renderMatrix();
updateMaskStatus();
initWorkers();
updateStats();
tryAutoLoadMask();

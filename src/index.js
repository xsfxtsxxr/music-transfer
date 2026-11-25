// 统一解密管线：按魔数优先识别 → 分派解密器 → 嗅探真实音频格式 → 生成输出文件名
import {
  fileExtension, stripExtension, safeName, DecryptError,
} from './utils.js';
import { isNcm, decryptNcm } from './ncm.js';
import { isQmcExtension, decryptQmc } from './qmc.js';
import { isKwm, decryptKwm } from './kwm.js';
import { isKgm, decryptKgm, hasKgmMask } from './kgm.js';
import { sniffAudio } from './sniff.js';

export const PLATFORM = {
  netease: { name: '网易云音乐', short: '网易云', color: '#f0473e' },
  qq: { name: 'QQ 音乐', short: 'QQ 音乐', color: '#31c48d' },
  kugou: { name: '酷狗音乐', short: '酷狗', color: '#3b9dff' },
  kuwo: { name: '酷我音乐', short: '酷我', color: '#f5a623' },
  plain: { name: '未加密 / 后缀伪装', short: '普通音频', color: '#9aa6b8' },
};

// 需要官方服务器或客户端账号密钥的变体：本地无解，明确拒绝而不是产出坏文件
const SERVER_KEY_EXTENSIONS = new Set(['kgg', 'vgm', 'ofl_en', 'kwma']);
const KGM_EXTENSIONS = new Set(['kgm', 'kgma', 'vpr', 'kgg', 'vgm']);
const KWM_EXTENSIONS = new Set(['kwm', 'kwma']);

export function detect(data, ext) {
  if (isNcm(data)) return { method: 'ncm', platform: 'netease' };
  if (isKwm(data)) return { method: 'kwm', platform: 'kuwo' };
  if (isKgm(data)) return { method: 'kgm', platform: 'kugou' };

  // 已是标准音频（很多「加密文件」其实只是被改了后缀）
  if (sniffAudio(data)) return { method: 'plain', platform: 'plain' };

  if (SERVER_KEY_EXTENSIONS.has(ext)) {
    throw new DecryptError(
      `.${ext} 属于新版加密变体，解密密钥由平台服务器 / 客户端账号体系下发，离线环境无法获取，本站不做破解`,
      'NEEDS_SERVER_KEY'
    );
  }
  if (ext === 'ncm') return { method: 'ncm', platform: 'netease' };
  if (isQmcExtension(ext)) return { method: 'qmc', platform: 'qq' };
  if (KWM_EXTENSIONS.has(ext)) return { method: 'kwm', platform: 'kuwo' };
  if (KGM_EXTENSIONS.has(ext)) return { method: 'kgm', platform: 'kugou' };

  throw new DecryptError(`未识别的加密格式 .${ext || '(无后缀)'}，请确认文件来自受支持的平台`, 'UNSUPPORTED');
}

const METHOD_LABEL = {
  ncm: 'NCM · AES 密钥盒',
  'qmc-static': 'QMC · 静态掩码',
  'qmc-map': 'QMC · Map 密钥',
  'qmc-rc4': 'QMC · RC4 密钥',
  kwm: 'KWM · 32 字节掩码',
  kgm: 'KGM · 大掩码表',
  plain: '仅修正扩展名',
};

function buildName(original, meta, ext) {
  let base;
  if (meta && meta.title) {
    const artist = (meta.artist || '').trim();
    base = artist ? `${artist} - ${meta.title}` : meta.title;
  } else {
    base = stripExtension(original);
  }
  return safeName(base) + ext;
}

export function decryptFile(data, filename, onProgress = () => {}) {
  const ext = fileExtension(filename);
  const det = detect(data, ext);
  let out;
  let method = det.method;

  switch (det.method) {
    case 'plain':
      out = { data: Uint8Array.from(data) };
      break;
    case 'ncm':
      out = decryptNcm(data, onProgress);
      break;
    case 'qmc': {
      const r = decryptQmc(data, onProgress);
      method = `qmc-${r.cipher}`;
      out = r;
      break;
    }
    case 'kwm':
      out = decryptKwm(data, onProgress);
      break;
    case 'kgm':
      if (!hasKgmMask()) {
        throw new DecryptError('酷狗 KGM/VPR 需要一份公开的大掩码表，请先在「酷狗密钥表」区域导入 kgm.maskfile', 'NEED_KGM_MASK');
      }
      out = decryptKgm(data, onProgress);
      break;
    default:
      throw new DecryptError('不支持的解密方式', 'UNSUPPORTED');
  }

  const audio = out.data;
  if (!audio || audio.length < 16) throw new DecryptError('解密结果为空或过短', 'BAD_RESULT');
  const format = sniffAudio(audio);
  if (!format) {
    throw new DecryptError(
      '解密后的数据未识别为常见音频格式。可能是新版加密变体（密钥需服务器下发）、文件损坏，或 ekey 解包失败。',
      'BAD_RESULT'
    );
  }

  const meta = out.meta || {};
  return {
    data: audio,
    ext: format.ext,
    formatLabel: format.label,
    mime: format.mime,
    platform: det.platform,
    method,
    methodLabel: METHOD_LABEL[method] || method,
    meta,
    suggestedName: buildName(filename, meta, format.ext),
    bytesSaved: audio.length,
  };
}

export { sniffAudio };

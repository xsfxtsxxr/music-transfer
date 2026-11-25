// 解密后按文件魔数嗅探真实音频格式（不是按输入后缀猜）
import { hasPrefix } from './utils.js';

const FORMATS = [
  { ext: '.mp3', label: 'MP3', mime: 'audio/mpeg', test: (b) => hasPrefix(b, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
  { ext: '.flac', label: 'FLAC 无损', mime: 'audio/flac', test: (b) => hasPrefix(b, 'fLaC') },
  { ext: '.ogg', label: 'Ogg Vorbis', mime: 'audio/ogg', test: (b) => hasPrefix(b, 'OggS') },
  { ext: '.m4a', label: 'M4A / AAC', mime: 'audio/mp4', test: (b) => hasPrefix(b, 'ftyp', 4) },
  { ext: '.wav', label: 'WAV', mime: 'audio/wav', test: (b) => hasPrefix(b, 'RIFF') && hasPrefix(b, 'WAVE', 8) },
  { ext: '.ape', label: 'APE', mime: 'audio/x-ape', test: (b) => hasPrefix(b, 'MAC ') || hasPrefix(b, 'APETAGEX') },
  { ext: '.wv', label: 'WavPack', mime: 'audio/x-wavpack', test: (b) => hasPrefix(b, 'wvpk') },
  { ext: '.aiff', label: 'AIFF', mime: 'audio/aiff', test: (b) => hasPrefix(b, 'FORM') && (hasPrefix(b, 'AIFF', 8) || hasPrefix(b, 'AIFC', 8)) },
  { ext: '.amr', label: 'AMR', mime: 'audio/amr', test: (b) => hasPrefix(b, '#!AMR') },
  { ext: '.dff', label: 'DSD / DFF', mime: 'audio/x-dff', test: (b) => hasPrefix(b, 'FRM8') },
];

export function sniffAudio(data) {
  if (!data || data.length < 12) return null;
  const head = data.subarray(0, 32);
  for (const f of FORMATS) {
    try { if (f.test(head)) return f; } catch { /* 数据不足 */ }
  }
  return null;
}

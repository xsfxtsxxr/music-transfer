// 解密 Worker：所有字节运算都在这里跑，主线程只负责界面与下载
import { decryptFile } from './index.js';
import { setKgmMask } from './kgm.js';

self.onmessage = (event) => {
  const { id, type, payload } = event.data || {};
  try {
    if (type === 'SET_MASK') {
      const len = payload && payload.mask ? setKgmMask(payload.mask) : 0;
      self.postMessage({ id, type: 'MASK_OK', length: len });
      return;
    }
    if (type === 'DECRYPT') {
      const data = new Uint8Array(payload.buffer);
      const result = decryptFile(data, payload.name, (progress) => {
        self.postMessage({ id, type: 'PROGRESS', progress });
      });
      const transfer = [];
      const audio = result.data;
      transfer.push(audio.buffer);
      const cover = result.meta && result.meta.cover;
      if (cover && cover.bytes && cover.bytes.buffer) transfer.push(cover.bytes.buffer);

      self.postMessage({
        id,
        type: 'DONE',
        result: {
          audioBuffer: audio.buffer,
          ext: result.ext,
          formatLabel: result.formatLabel,
          mime: result.mime,
          platform: result.platform,
          method: result.method,
          methodLabel: result.methodLabel,
          suggestedName: result.suggestedName,
          meta: {
            title: result.meta.title || '',
            artist: result.meta.artist || '',
            album: result.meta.album || '',
            cover: cover ? { coverBuffer: cover.bytes.buffer, mime: cover.mime } : null,
          },
        },
      }, transfer);
      return;
    }
    self.postMessage({ id, type: 'ERROR', message: '未知的 Worker 指令', code: 'UNKNOWN' });
  } catch (err) {
    self.postMessage({
      id,
      type: 'ERROR',
      message: err && err.message ? err.message : String(err),
      code: (err && err.code) || 'DECRYPT_FAILED',
    });
  }
};

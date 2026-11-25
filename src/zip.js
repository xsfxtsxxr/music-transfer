// 零依赖 ZIP（store 模式，不压缩）。音频本身已是压缩格式，store 最快且无损。
import { utf8 } from './utils.js';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  u16(v) { const b = new Uint8Array(2); b[0] = v & 0xff; b[1] = (v >>> 8) & 0xff; this.raw(b); }
  u32(v) { const b = new Uint8Array(4); b[0] = v & 0xff; b[1] = (v >>> 8) & 0xff; b[2] = (v >>> 16) & 0xff; b[3] = (v >>> 24) & 0xff; this.raw(b); }
  raw(bytes) { this.parts.push(bytes); this.length += bytes.length; }
  finish() {
    const out = new Uint8Array(this.length);
    let pos = 0;
    for (const p of this.parts) { out.set(p, pos); pos += p.length; }
    return out;
  }
}

function dosDateTime(date = new Date()) {
  const y = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

// entries: [{ name: string, data: Uint8Array }]
export function makeZip(entries) {
  const w = new Writer();
  const central = [];
  const { time, date } = dosDateTime();
  const FLAGS = 0x0800; // UTF-8 文件名

  for (const entry of entries) {
    const name = utf8(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    const offset = w.length;

    w.u32(0x04034b50);
    w.u16(20); w.u16(FLAGS); w.u16(0); w.u16(time); w.u16(date);
    w.u32(crc); w.u32(data.length); w.u32(data.length);
    w.u16(name.length); w.u16(0);
    w.raw(name); w.raw(data);

    const c = new Writer();
    c.u32(0x02014b50);
    c.u16(20); c.u16(20); c.u16(FLAGS); c.u16(0); c.u16(time); c.u16(date);
    c.u32(crc); c.u32(data.length); c.u32(data.length);
    c.u16(name.length); c.u16(0); c.u16(0);
    c.u16(0); c.u16(0); c.u32(0);
    c.u32(offset);
    c.raw(name);
    central.push(c.finish());
  }

  const cdOffset = w.length;
  let cdSize = 0;
  for (const c of central) { w.raw(c); cdSize += c.length; }

  w.u32(0x06054b50);
  w.u16(0); w.u16(0);
  w.u16(entries.length); w.u16(entries.length);
  w.u32(cdSize); w.u32(cdOffset);
  w.u16(0);

  return w.finish();
}

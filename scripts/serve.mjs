// 零依赖静态服务器：npm run dev
// 只用于本地预览；部署时把整个目录放到任意静态托管即可。
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.gz': 'application/gzip',
  '.bin': 'application/octet-stream',
  '.maskfile': 'application/octet-stream',
  '.woff2': 'font/woff2',
};

createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const target = join(ROOT, normalize(pathname).replace(/^([/\\])+/, ''));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = statSync(target);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(target).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
}).listen(PORT, () => {
  console.log(`\n  音锁 UnlockTune 已启动\n  → http://localhost:${PORT}\n`);
  console.log('  按 Ctrl+C 停止。所有解密都在浏览器内完成，服务器只提供静态文件。\n');
});

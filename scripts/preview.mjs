import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './build.mjs';

const site = path.join(ROOT, 'site');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.ics': 'text/calendar; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(site, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(site + path.sep)) { res.writeHead(403).end(); return; }
    const content = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(content);
  } catch { res.writeHead(404).end('not found'); }
});
server.listen(8898, '127.0.0.1', () => console.log('本地预览 http://127.0.0.1:8898/；仅供本机，不是公开订阅地址。'));

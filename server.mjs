import http from 'node:http';
import { mkdir, readFile, writeFile, rename, readdir, unlink, open } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mergeSnapshots, equal } from './public/merge.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const metadata = b => ({ id: b.id, title: b.title, updated: b.updated, revision: b.revision, thumb: b.thumb || '' });

export async function createApp({ dataDir = resolve(process.env.DATA_DIR || join(ROOT, 'data')) } = {}) {
  const boardDir = join(dataDir, 'boards'), assetDir = join(dataDir, 'assets');
  await mkdir(boardDir, { recursive: true }); await mkdir(assetDir, { recursive: true });
  const index = new Map(), locks = new Map();
  for (const file of await readdir(boardDir)) {
    if (!file.endsWith('.json') || !UUID.test(file.slice(0, -5))) continue;
    try { const b = JSON.parse(await readFile(join(boardDir, file), 'utf8')); validateBoard(b); index.set(b.id, metadata(b)); }
    catch (e) { throw new Error(`Cannot read board ${file}; restore it from backup before restarting.`, { cause: e }); }
  }
  async function atomicWrite(path, bytes) {
    const tmp = path + '.' + randomUUID() + '.tmp';
    try { const fd = await open(tmp, 'wx'); try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); } await rename(tmp, path); }
    finally { await unlink(tmp).catch(() => {}); }
  }
  async function serial(id, fn) {
    const previous = locks.get(id) || Promise.resolve();
    const job = previous.catch(() => {}).then(fn); locks.set(id, job);
    try { return await job; } finally { if (locks.get(id) === job) locks.delete(id); }
  }
  async function readBoard(id) { try { return JSON.parse(await readFile(join(boardDir, id + '.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') fail(404, 'Board not found'); throw e; } }
  async function saveBoard(b) { await atomicWrite(join(boardDir, b.id + '.json'), JSON.stringify(b)); index.set(b.id, metadata(b)); return b; }
  async function body(req, limit) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) fail(413, 'Upload too large'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function parse(req) { try { return JSON.parse((await body(req, 18 * 1024 * 1024)).toString()); } catch (e) { if (e instanceof HttpError) throw e; fail(400, 'Invalid JSON'); } }
  const server = http.createServer(async (req, res) => {
    const common = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store' };
    const json = (status, data) => { res.writeHead(status, { ...common, 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (!['GET', 'HEAD'].includes(req.method)) {
        // No CORS: other websites cannot write into a LAN instance.
        if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'Cross-site writes are disabled');
        if (req.headers.origin) {
          const origin = new URL(req.headers.origin);
          if (origin.host !== req.headers.host) fail(403, 'Cross-origin writes are disabled');
        }
      }
      if ((path === '/' || path === '/index.html' || path === '/merge.mjs') && ['GET', 'HEAD'].includes(req.method)) {
        const bytes = await readFile(join(ROOT, 'public', path === '/merge.mjs' ? 'merge.mjs' : 'index.html'));
        res.writeHead(200, { ...common, 'Content-Type': path === '/merge.mjs' ? 'text/javascript;charset=utf-8' : 'text/html;charset=utf-8', 'Content-Length': bytes.length });
        res.end(req.method === 'HEAD' ? undefined : bytes); return;
      }
      if (path === '/api/health' && req.method === 'GET') { json(200, { ok: true }); return; }
      if (path === '/api/boards' && req.method === 'GET') { json(200, [...index.values()].sort((a,b) => b.updated-a.updated)); return; }
      const match = path.match(/^\/api\/boards\/([a-f0-9-]{36})$/i);
      if (match && UUID.test(match[1])) {
        const id = match[1];
        if (req.method === 'GET') { const known = new URL(req.url, 'http://localhost').searchParams.get('revision'); if (index.has(id) && known === String(index.get(id).revision)) { res.writeHead(204, common); res.end(); return; } json(200, await readBoard(id)); return; }
        if (req.method === 'PUT') {
          const input = await parse(req); validateBoard(input.board);
          if (input.board.id !== id || input.create !== true) fail(400, 'Use PATCH to edit an existing board');
          const b = await serial(id, async () => {
            if (index.has(id)) fail(409, 'Board already exists');
            return saveBoard({ ...input.board, revision: 1, updated: Date.now() });
          }); json(201, b); return;
        }
        if (req.method === 'PATCH') {
          const input = await parse(req); validateSnapshot(input.base); validateBoard(input.board);
          if (input.board.id !== id || !Number.isInteger(input.baseRevision) || input.baseRevision < 1) fail(400, 'Invalid revision');
          const result = await serial(id, async () => {
            const remote = await readBoard(id);
            if (input.baseRevision > remote.revision) fail(409, 'Revision is newer than server');
            const merged = mergeSnapshots(input.base, input.board, remote);
            if (merged.conflicts.length) return { conflict: true, conflicts: merged.conflicts, board: remote };
            if (equal(merged.board.items, remote.items) && merged.board.title === remote.title) return { board: remote };
            const b = merged.board;
            // A thumbnail made from a stale snapshot cannot represent merged work.
            b.thumb = input.baseRevision === remote.revision ? input.board.thumb || '' : '';
            b.revision = remote.revision + 1; b.updated = Date.now();
            validateBoard(b); return { board: await saveBoard(b) };
          }); json(result.conflict ? 409 : 200, result); return;
        }
        if (req.method === 'DELETE') {
          const revision = Number(req.headers['if-match']);
          await serial(id, async () => {
            const b = await readBoard(id); if (revision !== b.revision) fail(409, 'Board changed. Reload the list before deleting.');
            await unlink(join(boardDir, id + '.json')); index.delete(id);
          }); res.writeHead(204, common); res.end(); return;
        }
      }
      if (path === '/api/assets' && req.method === 'POST') {
        const type = req.headers['content-type'], ext = TYPES[type]; if (!ext) fail(415, 'Use PNG, JPEG, WebP, or GIF');
        const bytes = await body(req, 15 * 1024 * 1024);
        const valid = ext === 'png' ? bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : ext === 'jpg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : ext === 'webp' ? bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' : ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6));
        if (!valid) fail(415, 'Image data does not match its type');
        const id = randomUUID(); await atomicWrite(join(assetDir, id + '.' + ext), bytes);
        json(201, { url: '/api/assets/' + id + '.' + ext }); return;
      }
      const asset = path.match(/^\/api\/assets\/([a-f0-9-]{36})\.(png|jpg|webp|gif)$/i);
      if (asset && UUID.test(asset[1]) && ['GET','HEAD'].includes(req.method)) {
        let bytes; try { bytes = await readFile(join(assetDir, asset[1] + '.' + asset[2])); } catch(e) { if(e.code === 'ENOENT') fail(404,'Image not found'); throw e; }
        res.writeHead(200, { ...common, 'Cache-Control': 'private,max-age=86400,immutable', 'Content-Type': Object.keys(TYPES).find(k => TYPES[k] === asset[2]), 'Content-Length': bytes.length }); res.end(req.method === 'HEAD' ? undefined : bytes); return;
      }
      fail(404, 'Not found');
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (!e.status) console.error(e);
      json(e.status || 500, { error: e.status ? e.message : 'Unable to save. Check server storage and try again.' });
    }
  });
  server.requestTimeout = 30000;
  return server;
}
function validateSnapshot(b) {
  if (!b || typeof b.title !== 'string' || b.title.length > 120 || !Array.isArray(b.items) || b.items.length > 20000) fail(400, 'Invalid board');
  const ids = new Set();
  for (const o of b.items) {
    if (!o || !UUID.test(o.id || '') || ids.has(o.id) || !['pen','rect','ellipse','arrow','note','text','image'].includes(o.type)) fail(400, 'Invalid canvas object');
    ids.add(o.id);
    if (o.type === 'pen') {
      if (!Array.isArray(o.points) || !o.points.length || o.points.length > 100000 || o.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) fail(400, 'Invalid drawing');
    } else if (!['x','y','w','h'].every(k => Number.isFinite(o[k]))) fail(400, 'Invalid geometry');
    if (['note','text'].includes(o.type) && (typeof o.text !== 'string' || o.text.length > 100000 || !Number.isFinite(o.size) || o.size < 1 || o.size > 1000)) fail(400, 'Invalid text');
    if (o.type === 'image' && !/^\/api\/assets\/[a-f0-9-]{36}\.(png|jpg|webp|gif)$/i.test(o.src || '')) fail(400, 'Invalid image reference');
    if (o.color !== undefined && !/^#[a-f0-9]{6}$/i.test(o.color)) fail(400, 'Invalid color');
    if (o.width !== undefined && (!Number.isFinite(o.width) || o.width <= 0 || o.width > 100)) fail(400, 'Invalid stroke width');
  }
}
function validateBoard(b) {
  validateSnapshot(b);
  if (!UUID.test(b.id || '') || Buffer.byteLength(JSON.stringify(b)) > 8*1024*1024) fail(400, 'Board too large or invalid ID');
  if (b.thumb && (typeof b.thumb !== 'string' || !/^data:image\/(webp|png);base64,[A-Za-z0-9+/=]+$/.test(b.thumb) || b.thumb.length > 1000000)) fail(400, 'Invalid preview');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createApp(); const port = Number(process.env.PORT || 3000), host = process.env.HOST || '0.0.0.0';
  server.listen(port, host, () => console.log(`Glassboard listening on http://${host}:${port} — shared boards, no accounts`));
  const stop = () => server.close(() => process.exit(0)); process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

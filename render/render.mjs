#!/usr/bin/env node
// Renders Chromaflux offline, frame-exact, through headless Chromium (SwiftShader WebGL2).
// The page runs the deterministic timeline (?render=1) and POSTs every frame back here.
//
//   node render/render.mjs --mode=png --w=960 --h=540 --every=60 --out=out/stills
//   node render/render.mjs --mode=raw --w=1920 --h=1080 --fps=60 --out=out/master.mp4
//   node render/render.mjs --mode=audio --out=out/score.wav
//   node render/render.mjs --mode=raw --chunk=600 --out=out/master.mp4   (resumable: 10 s segments + checkpoints;
//                                                                         just run the same command again after a crash)
//
// Extra page options pass straight through: --dye --sim --parts --from --to
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
for (const m of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
  try { ({ chromium } = require(m)); break; } catch { /* try next */ }
}
if (!chromium) { console.error('playwright not found'); process.exit(1); }

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : '1'];
}));
const mode = args.mode || 'png';
const W = +(args.w || 1920), H = +(args.h || 1080), FPS = +(args.fps || 60);
const out = path.resolve(args.out || (mode === 'png' ? 'out/stills' : mode === 'audio' ? 'out/score.wav' : 'out/master.mp4'));
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

if (mode === 'png') fs.mkdirSync(out, { recursive: true });
else fs.mkdirSync(path.dirname(out), { recursive: true });

const CHUNK = +(args.chunk || 0);
const segDir = out + '.parts', ckDir = path.join(segDir, 'ckpt');
function encoder(file) {
  return spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
    '-vf', 'vflip', '-c:v', 'libx264', '-preset', args.preset || 'medium', '-crf', args.crf || '14', '-pix_fmt', 'yuv420p',
    '-x264-params', 'aq-mode=3', '-movflags', '+faststart', file], { stdio: ['pipe', 'inherit', 'inherit'] });
}
let ff = null, curSeg = -1, resumeAt = 0;
if (mode === 'raw' && !CHUNK) ff = encoder(out);
if (mode === 'raw' && CHUNK) {
  fs.mkdirSync(ckDir, { recursive: true });
  const latest = path.join(ckDir, 'latest');
  if (fs.existsSync(latest) && args.resume !== '0') resumeAt = +fs.readFileSync(latest, 'utf8');
  for (const f of fs.readdirSync(segDir)) {   // drop segments the resumed run will render again
    const m = f.match(/^seg_(\d+)(\.part)?\.mp4$/);
    if (m && (m[2] || +m[1] * CHUNK >= resumeAt)) fs.rmSync(path.join(segDir, f));
  }
  if (resumeAt) console.log(`[render] resuming at frame ${resumeAt}`);
}
const segName = (i, part) => path.join(segDir, `seg_${String(i).padStart(3, '0')}${part ? '.part' : ''}.mp4`);
async function closeSeg() {
  if (!ff) return;
  const p = ff; ff = null; p.stdin.end(); await new Promise(r => p.on('close', r));
  if (CHUNK) fs.renameSync(segName(curSeg, true), segName(curSeg, false));
}
async function writeFrame(buf, f) {
  if (CHUNK) {
    const seg = Math.floor(f / CHUNK);
    if (seg !== curSeg) { await closeSeg(); curSeg = seg; ff = encoder(segName(seg, true)); }
  }
  await new Promise(res => { if (ff.stdin.write(buf)) res(); else ff.stdin.once('drain', res); });
}
const ckFile = (next, name) => path.join(ckDir, String(next), name);

let finish;
const finished = new Promise(r => { finish = r; });
let frames = 0;
const tStart = Date.now();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local');
  if (req.method === 'GET') {
    if (u.pathname.startsWith('/ckpt/')) {
      res.writeHead(200); fs.createReadStream(ckFile(resumeAt, path.basename(u.pathname))).pipe(res); return;
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      fs.createReadStream(path.join(root, 'index.html')).pipe(res);
    } else { res.writeHead(404); res.end(); }
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  switch (u.pathname) {
    case '/log': console.log('[page]', body.toString(), `(${((Date.now() - tStart) / 1000).toFixed(0)}s)`); break;
    case '/frame': await writeFrame(body, +u.searchParams.get('f')); frames++; break;
    case '/still': {
      const f = String(u.searchParams.get('f')).padStart(5, '0');
      fs.writeFileSync(path.join(out, `f${f}_t${u.searchParams.get('t')}.png`), body); frames++; break;
    }
    case '/audio': fs.writeFileSync(out, body); break;
    case '/done': finish(); break;
    default:
      if (u.pathname.startsWith('/ckpt/')) {
        const next = +u.searchParams.get('next'), name = path.basename(u.pathname);
        fs.mkdirSync(path.join(ckDir, String(next)), { recursive: true });
        fs.writeFileSync(ckFile(next, name), body);
        if (name === 'state.json') {            // state arrives last: seal the segment, then flip the pointer atomically
          await closeSeg();
          fs.writeFileSync(path.join(ckDir, 'latest.tmp'), String(next));
          fs.renameSync(path.join(ckDir, 'latest.tmp'), path.join(ckDir, 'latest'));
          for (const d of fs.readdirSync(ckDir)) if (/^\d+$/.test(d) && +d !== next) fs.rmSync(path.join(ckDir, d), { recursive: true });
          console.log(`[render] checkpoint @ frame ${next}`);
        }
      }

  }
  res.writeHead(200); res.end('ok');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--autoplay-policy=no-user-gesture-required']
});
const page = await browser.newPage({ viewport: { width: Math.min(W, 1920), height: Math.min(H, 1080) } });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 4000)); });
page.on('pageerror', e => console.log('[pageerror]', e.message));

const qs = new URLSearchParams({ render: '1', w: W, h: H, fps: FPS, mode });
if (CHUNK) qs.set('chunk', CHUNK);
if (resumeAt) qs.set('resume', '1');
for (const k of ['dye', 'sim', 'parts', 'every', 'from', 'to', 'start']) if (args[k] != null) qs.set(k, args[k]);
await page.goto(`http://127.0.0.1:${port}/index.html?${qs}`);
await page.waitForFunction(() => window.CF && window.CF.ready, null, { timeout: 30000 });

if (mode === 'audio') {
  const dur = +(args.dur || 80);
  await page.evaluate(async d => {
    const ab = await window.CF.renderAudio(d.dur, d.raw);
    await fetch('/audio', { method: 'POST', body: ab });
  }, { dur, raw: args.raw === '1' });
} else {
  page.evaluate(() => { window.CF.runRender().catch(e => fetch('/log', { method: 'POST', body: 'ERROR ' + e.stack }).then(() => fetch('/done', { method: 'POST', body: 'x' }))); });
  await finished;
}

await browser.close();
server.close();
await closeSeg();
if (mode === 'raw' && CHUNK) {
  const segs = fs.readdirSync(segDir).filter(f => /^seg_\d+\.mp4$/.test(f)).sort();
  fs.writeFileSync(path.join(segDir, 'list.txt'), segs.map(f => `file '${path.join(segDir, f)}'`).join('\n'));
  await new Promise(r => spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(segDir, 'list.txt'),
    '-c', 'copy', '-movflags', '+faststart', out], { stdio: 'inherit' }).on('close', r));
  console.log(`[render] joined ${segs.length} segments`);
}
console.log(`done: ${frames} frames → ${out} in ${((Date.now() - tStart) / 1000).toFixed(0)}s`);

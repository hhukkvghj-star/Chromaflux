#!/usr/bin/env node
// Regression test for the interactive page: gestures, the glass, pouring out and the singing glass.
// The live rAF loop is parked and the page's own tick() is stepped by hand at exactly 1/60 s. Gestures are
// timed on that same frame clock and the random source is seeded, so every run computes the same thing,
// even in headless Chromium without a GPU (SwiftShader manages only a few real frames per second).
//
//   node test/glass.mjs                      run all checks, exit code 1 on any failure
//   node test/glass.mjs --stills=out/test    also save a screenshot after each scenario
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
for (const m of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
  try { ({ chromium } = require(m)); break; } catch { /* try next */ }
}
if (!chromium) { console.error('playwright not found'); process.exit(1); }

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.length ? v.join('=') : '1']; }));
const stills = args.stills ? path.resolve(args.stills) : null;
if (stills) fs.mkdirSync(stills, { recursive: true });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// serve the page with a hook into its closure, so the test can step the sim and read its state
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace('window.CF = {', 'window.__x = c => eval(c);\nwindow.CF = {');
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(html); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' || /INVALID_|GL_OUT_OF/.test(m.text())) errors.push(m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => { try { return !!window.__x('dye'); } catch (_) { return false; } }, null, { timeout: 60000 });
await page.click('#bStart');

const X = c => page.evaluate(c => window.__x(c), c);
// park the live loop, seed the randomness, and count what the page does: bursts, drops, pours, the voices of the glass
await X(`gated = true; freeRng.s = 20261013;
  window.__n = {};
  const wrap = (f, name, test) => function () { if (!test || test()) window.__n[name] = (window.__n[name] || 0) + 1; return f.apply(this, arguments); };
  const fromPointer = () => { const st = new Error().stack; return /applyPointers/.test(st) && !/pourStep|dropAt/.test(st); };
  userBurst = wrap(userBurst, 'burst'); dropAt = wrap(dropAt, 'drop'); pourStep = wrap(pourStep, 'pour');
  dsplat = wrap(dsplat, 'paint', fromPointer); vsplat = wrap(vsplat, 'stir', fromPointer);
  ['bubble', 'ping', 'glug'].forEach(k => { audio[k] = wrap(audio[k], k); }); 0`);
const counts = () => X(`(() => { const c = window.__n; window.__n = {}; return c; })()`);
// n frames of the page's own tick(), then a real GPU sync (a read from the default framebuffer)
const step1 = n => X(`(() => { for (let i = 0; i < ${n}; i++) tick(1 / 60, 1 / 60);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); return 0; })()`);
const run = async n => { while (n > 0) { const k = Math.min(n, 10); await step1(k); n -= k; } };
const ptr = (type, x, y, id = 1) => X(`(() => { const r = canvas.getBoundingClientRect(); canvas.dispatchEvent(new PointerEvent('${type}', { pointerId: ${id}, clientX: r.left + ${x} * r.width, clientY: r.top + ${y} * r.height, bubbles: true })); return 0; })()`);
const two = async (type, y) => { await ptr(type, 0.4, y, 1); await ptr(type, 0.6, y, 2); };
const tap = async (x, y) => { await ptr('pointerdown', x, y); await ptr('pointerup', x, y); };
const drag = async (x0, y0, frames = 24) => { await ptr('pointerdown', x0, y0); for (let i = 1; i <= frames; i++) { await ptr('pointermove', x0 + 0.3 * i / frames, y0 + 0.1 * Math.sin(i / 4)); await run(1); } await ptr('pointerup', x0 + 0.3, y0); };
const press = async (x, y, frames = 90) => { await ptr('pointerdown', x, y); await run(frames); await ptr('pointerup', x, y); };
const swipeUp = async (restFrames = 0, holdFrames = 0) => {
  await two('pointerdown', 0.8); await run(1 + restFrames);
  for (const y of [0.7, 0.6, 0.5]) { await two('pointermove', y); await run(1); }      // a quick swipe, well under a second
  await run(holdFrames); await two('pointerup', 0.5);
};
const motion = (ax, ay, n) => `for (let i = 0; i < ${n}; i++) window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: { x: ${ax}, y: ${ay}, z: 0 }, accelerationIncludingGravity: { x: ${ax}, y: ${ay} + 9.81, z: 0 }, rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 }));`;
const shake = async () => { await X(motion(25, 4, 6) + ' 0'); await run(2); await X(motion(0, 0, 16) + ' 0'); };   // a jolt, then the phone comes to rest
const dyeStats = () => X('stats(dye.read)');
const mass = async () => (await dyeStats()).mean[3];
const snap = async name => { if (!stills) return; await X('stillDirty = true; 0'); await page.waitForTimeout(1200); await page.screenshot({ path: path.join(stills, name + '.png'), timeout: 180000 }); };

let failed = 0;
const check = (name, ok, info) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); if (!ok) failed++; };
const j = o => JSON.stringify(o);

// ---- demo: unchanged — a tap detonates, dragging paints light, shaking does nothing
await run(30); await counts();
await tap(0.5, 0.5); await run(2); let c = await counts();
check('demo: tap detonates', c.burst === 1 && !c.drop, j(c));
await drag(0.3, 0.5); c = await counts();
check('demo: drag paints and stirs', c.paint > 0 && c.stir > 0, j(c));
await shake(); await run(5); c = await counts();
check('demo: shaking does nothing', !c.burst, j(c));

// ---- free play, ink palette: the glass
await X(`setAutopilot(false, true); jumpChapter(1); 0`); await run(60); await counts();
await tap(0.3, 0.4); await run(2); c = await counts();
check('glass: tap drops liquid with a blub and the glass ringing', c.drop === 1 && !c.burst && c.bubble === 1 && c.ping === 1, j(c));
for (const [x, y] of [[0.2, 0.3], [0.45, 0.35], [0.6, 0.3], [0.8, 0.35], [0.7, 0.45]]) { await tap(x, y); await run(6); }
await counts(); await press(0.5, 0.3); c = await counts();
check('glass: a long press pours and gurgles', c.pour > 50 && c.bubble >= 5 && !c.drop, j(c));
await drag(0.3, 0.6); c = await counts();
check('glass: dragging only stirs', !c.paint && c.stir > 0 && !c.drop && !c.pour, j(c));
await run(120); const m0 = await mass(); await run(240); const m1 = await mass();
check('glass: the liquid stays in the glass', m1 > 0.6 * m0, `mass ${m0} → ${m1} in 4 s`);
await snap('1-glass-full');
const pitchFull = await X('glassMidi()');
check('glass: a fuller glass sings lower', pitchFull < Math.max(...await X('PAL[targetPal].scale')), `midi ${pitchFull}`);
await shake(); await run(5); c = await counts();
check('glass: shaking detonates', c.burst === 1, j(c));
await run(60);

// ---- pouring out with two fingers swiped up
await counts();
await swipeUp();
check('pour out: a two-finger swipe up starts it', await X('Out.t > 0'));
await run(60); await snap('2-pouring-out');
await run(150); const m2 = await mass(); await run(90); c = await counts();
check('pour out: the glass runs empty', m2 < 0.05 * m1, `mass ${m1} → ${m2}`);
check('pour out: it glugs, and the empty glass rings exactly once', c.glug >= 4 && c.ping === 1, j(c));

// fingers that rested long enough to pour must stop pouring once their swipe pours the glass out
await X(`jumpChapter(1); 0`); await run(60); await counts();
await swipeUp(30, 30); c = await counts();
const pourAfter = c.pour;
check('pour out: resting fingers stop pouring when they swipe', await X('Out.t > 0') && pourAfter <= 33, `pour steps ${pourAfter} (≤ 33 = only while resting)`);
await run(240);

// a pour-out cut short by a new palette must neither drain the fresh glass nor ring
await X(`jumpChapter(1); 0`); await run(90); await counts();
await X(`pourOut(); 0`); await run(40);
const armed = await X('Level.armed'); await X(`jumpChapter(2); 0`);
check('pour out: a new palette mid-pour disarms the empty-glass ring', armed && !await X('Level.armed'), `armed before ${armed}`);
await run(180); c = await counts();
check('pour out: a new palette mid-pour gets a fresh glass, no ring', await mass() > 0.02 && !c.ping, `mass ${await mass()} ${j(c)}`);
check('pour out: key X works too', await X(`(() => { gated = false; window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' })); gated = true; return Out.t > 0; })()`));
await run(240); await counts();

// ---- hold mode: tilt drives the liquid, taps still drop, the finger does not stir, upside down it pours out
await X(`pourOut(); 0`); await run(20); await X(`enterHold(); 0`);      // X then G: hold mode must not keep pouring
await run(90);
check('hold: entering it stops a running pour-out and fills a fresh glass', await X('Out.t === 0') && await mass() > 0.02, `mass ${await mass()}`);
await counts();
for (const [x, y] of [[0.3, 0.3], [0.5, 0.25], [0.7, 0.3], [0.4, 0.4], [0.6, 0.4]]) { await tap(x, y); await run(8); }
c = await counts();
check('hold: taps drop liquid', c.drop === 5 && !c.burst, j(c));
await drag(0.3, 0.5); c = await counts();
check('hold: the finger does not stir', !c.stir && !c.paint, j(c));
await shake(); await run(5); c = await counts();
check('hold: shaking detonates', c.burst === 1, j(c));
await X(`Hold.got = false; Hold.lin[0] = Hold.lin[1] = 0; 0`);   // the fake shake is over: back to the simulated tilt
await run(240); const h0 = await mass(); await snap('3-hold-pooled');
await X(`Hold.sim[0] = 0; Hold.sim[1] = 0.3; 0`); await run(30);
check('hold: a slight tip past the rim opens it only a little', await X('sim.rim > 0 && sim.rim < 0.3'), `rim ${(await X('sim.rim')).toFixed(2)}`);
await X(`Hold.sim[0] = 0.35; Hold.sim[1] = 0.94; 0`);            // turned well over the rim
await run(30);
check('hold: upside down the rim opens', await X('Out.open > 0.9'));
await run(270); const h1 = await mass(); c = await counts();
check('hold: upside down the glass empties', h1 < 0.05 * h0, `mass ${h0} → ${h1}`);
check('hold: it glugs, and the empty glass rings exactly once', c.glug >= 3 && c.ping === 1, j(c));
await X(`Hold.sim[0] = 0; Hold.sim[1] = -0.85; exitHold(); 0`); await run(10);

// ---- back to the demo
await X(`setAutopilot(true); 0`); await run(10); await counts();
await tap(0.5, 0.5); await run(2); c = await counts();
check('demo again: tap detonates', c.burst === 1 && !c.drop, j(c));
const st = await dyeStats();
check('the simulation stays finite', st.nan === 0, j(st));
check('no WebGL errors', await X('gl.getError()') === 0);
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close(); server.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);

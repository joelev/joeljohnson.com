// Engine Synthesizer: the playable page. Wires the engine (real WebAssembly simulator, or the
// replay mock with ?mock=1) to the 3D scene, the instruments and the controls.
//
// Engine pages: the published build (tools/build_site.py) has a page per engine at e/<id>/, the same
// page with a base tag pointing two folders up and <meta name="engine" content="<id>">; that meta tag picks the
// engine ahead of ?engine=. In that build (window.__enginePages) Share copies <site root>/e/<id>/ and
// the address bar follows the running engine there; on the development server it stays ?engine=.
//
// URL parameters: mock=1 (replay recorded telemetry), engine=<preset name>, view=<camera>,
// quality=auto|light|heavy, orbit=0 (no idle auto-orbit), waves=0 or off (plain grid floor, no sound picture),
// firstrun=1 (force the first-run teaching sequence) or 0 (skip it), ui=0 (no teaching cues either;
// it used to hide the key hints, which the key caps have replaced),
// debug=1 (status line and test beeps), slow=<k> (test hook: make the simulator k times as costly,
// to stand in for a slower device).
//
// Start-up: the page loads the simulator, benchmarks one engine on the main thread to estimate
// this device's speed, and draws the chosen engine from a preview session (no audio yet). The
// AudioContext is created inside the handler of the press that starts it (the Space key, or a
// click or tap on the space-bar key cap), which iOS needs; the engine is then created on the audio
// thread. That key cap stays where it is and is the throttle from then on.

import { LiveScene } from './scene.js?v=fe9cc229ea';
import { pressureColor, chargeColor, config } from './engine-model.js?v=fe9cc229ea';
import { FirstRun } from './firstrun.js?v=fe9cc229ea';
import { SpectroSource, LiveSpectro } from './spectro.js?v=fe9cc229ea';

const Q = new URLSearchParams(location.search);
const PAGE_ENGINE = (document.querySelector('meta[name="engine"]') || {}).content || null;
const ENGINE_PAGES = window.__enginePages === true;
/** The folder the app is served from: the base href on an engine page, the page's own folder at the root. */
const SITE_ROOT = new URL('./', document.baseURI);
const enginePage = (name) => new URL(`e/${encodeURIComponent(name)}/`, SITE_ROOT);
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const showError = (e) => { $('err').textContent = String((e && e.stack) || e); console.error(e); };
const REDUCED = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

const S = {
  engine: null, scene: null, ctx: null, analyser: null, presets: [], name: null, overrides: {},
  started: false, starting: false, mock: false, mode: 'drive', auto: true, LiveEngine: null, preview: null,
  thrTarget: 0, thr: 0, brake: 0, keysDown: new Set(), pedalDrag: false, pedalId: null, padThr: 0,
  rpm: 0, torque: 0, power: 0, lamps: [], lampHold: [], tachMax: 8000, ws: null, busy: false,
  speed: null, observed: {}, demoted: new Set(),
};
window.__app = S;
const FR = S.firstRun = new FirstRun(Q.get('ui') === '0' ? '0' : Q.get('firstrun'), {
  space: $('btnStart'), down: $('btnDown'), up: $('btnUp'), brake: $('btnBrake'),
});
/** How much of the space-bar key is lit while the page loads (0..1). */
const setLoad = (x) => { $('btnStart').style.setProperty('--load', String(x)); if (S.scene) S.scene.setLoadProgress(x); };
const setLabel = (t) => { $('startlabel').textContent = t; };

// ------------------------------------------------------------------ what this browser can do
// The simulator is WebAssembly with SIMD (Safari 16.4+, Chrome 91+, Firefox 89+); sound runs in an
// AudioWorklet (needs a secure https:// page); the picture needs WebGL2.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
function missingFeatures() {
  const miss = [];
  try {
    if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') miss.push('WebAssembly');
    else if (!WebAssembly.validate(SIMD_PROBE)) miss.push('WebAssembly SIMD');
  } catch (e) { miss.push('WebAssembly'); }
  const AC = window.AudioContext;
  if (!AC || typeof window.AudioWorkletNode !== 'function' || !('audioWorklet' in AC.prototype)) miss.push(window.isSecureContext === false ? 'AudioWorklet (it needs an https:// address)' : 'AudioWorklet');
  try {
    if (!document.createElement('canvas').getContext('webgl2')) miss.push('WebGL2');
  } catch (e) { miss.push('WebGL2'); }
  return miss;
}
/** Show a message above the space-bar key, which is hidden or (with buttonText) relabelled to act on it. */
function startMessage(html, buttonText, onClick) {
  const m = $('startmsg');
  m.innerHTML = html;
  m.hidden = false;
  const b = $('btnStart');
  FR.teach(null);
  if (buttonText) { b.hidden = false; b.disabled = false; setLabel(buttonText); b.onclick = onClick; b.classList.remove('loading', 'starting'); setLoad(1); S.failed = true; }
  else b.hidden = true;
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function unsupported(miss) {
  startMessage(`<b>This browser cannot run the engine synthesizer.</b> It needs ${esc(miss.join(', '))}, which this browser does not provide. Current versions of Chrome, Edge, Firefox and Safari (16.4 or later) have them.`);
}
function loadFailed(what, e) {
  console.error(e);
  startMessage(`<b>${esc(what)}.</b> ${esc((e && e.message) || e || '')}<br>Check the connection and reload the page.`, 'Reload', () => location.reload());
}

// ------------------------------------------------------------------ device speed and engine cost
// Audio-thread cost of each engine at the light quality level, predicted from its spec alone, in
// seconds of computing per second of sound on the machine the fit was made on. Fitted (least
// squares on relative error) to the WebAssembly loads of all 61 engines measured in node on an M4:
// mean error 12%, worst 28%. One engine is benchmarked on this device at load to scale it; once an
// engine has run, the audio thread's own load figures replace the benchmark.
const COST = { base: 0.0356, unit: 0.0372, itbUnit: 0.0068 };
const REF_ENGINE = 'i4';
const TOO_HEAVY = 0.85;   // predicted light-level load above which an engine is marked as not keeping up
const HEAVY_OVER_LIGHT = 2.6;   // typical heavy/light load ratio (2.2 to 3.3 across the library)
const presetOf = (name) => S.presets.find((p) => p.name === name);
function costOf(name) {
  const p = presetOf(name);
  if (!p) return null;
  const n = p.units || (p.spec.firing || []).length || 1;
  return COST.base + COST.unit * n + COST.itbUnit * n * (p.spec.itb ? 1 : 0);
}
/** Light-level audio load expected for this engine on this device (null when unknown). */
function predictLoad(name) {
  const o = S.observed[name];
  if (o && o.light !== undefined) return o.light;
  const c = costOf(name), f = S.factor;
  return c === null || !f ? null : c * f;
}
async function benchmarkDevice(LE) {
  // best of three short runs, so a cold start (unoptimised code, loading work) does not count
  let best = Infinity;
  for (let k = 0; k < 3; k++) {
    await new Promise((r) => setTimeout(r, 0));
    best = Math.min(best, await LE.measure(REF_ENGINE, {}, 0));
    setLoad(0.55 + 0.15 * k);
  }
  S.benchRef = best;
  S.benchFactor = best / costOf(REF_ENGINE);
  S.factor = S.benchFactor;
}
const PREFERRED = ['v8_cross', 'flat6', 'i6', 'boxer4_uel', 'i4', 'vtwin45', 'single'];
/** An engine that should run on this device: the first of a short list of characterful ones that fits. */
function defaultEngine(except) {
  for (const n of PREFERRED) {
    if (n === except || !presetOf(n)) continue;
    const p = predictLoad(n);
    if (p === null || p < 0.7) return n;
  }
  const ok = S.presets.filter((p) => p.name !== except).sort((a, b) => (predictLoad(a.name) || 0) - (predictLoad(b.name) || 0));
  return (ok[0] || S.presets[0]).name;
}
function qualityFor(name) {
  const forced = Q.get('quality');
  if (S.demoted.has(name)) return 'light';
  if (forced === 'light' || forced === 'heavy') return forced;
  const p = predictLoad(name);
  // the heavy level clearly will not fit: skip the measurement LiveEngine would make to find out
  if (p !== null && p * HEAVY_OVER_LIGHT > 0.6) return 'light';
  return 'auto';
}

// ------------------------------------------------------------------ engine + audio
async function boot() {
  const miss = missingFeatures();
  if (miss.length) { unsupported(miss); return; }
  try {
    S.scene = new LiveScene($('gl'), { lit: false, view: Q.get('view') || undefined, idleOrbit: Q.get('orbit') !== '0', reducedMotion: REDUCED.matches, preserve: Q.get('preserve') === '1', maxPixelRatio: +Q.get('dpr') || 2 });
  } catch (e) { console.error(e); unsupported(['WebGL2']); return; }
  if (REDUCED.addEventListener) REDUCED.addEventListener('change', () => S.scene.setReducedMotion(REDUCED.matches));
  if (S.applyWaves) S.applyWaves();
  S.scene.setAttract(true);
  setLoad(0.15);
  requestAnimationFrame(loop);
  S.mock = Q.get('mock') === '1';
  let mod;
  // ?capture=1: the simulator stepped on the main thread for offline video (live/capture-engine.js; not shipped in the public build)
  try { mod = await import(Q.get('capture') === '1' ? './capture-engine.js' : S.mock ? './mock-engine.js?v=fe9cc229ea' : './engine.js?v=fe9cc229ea'); } catch (e) { loadFailed('The engine simulator could not be loaded', e); return; }
  const LiveEngine = S.LiveEngine = mod.LiveEngine;
  setLoad(0.3);
  if (+Q.get('slow') > 1) LiveEngine.slow = Math.round(+Q.get('slow'));
  try {
    S.presets = await LiveEngine.presets();
    if (!S.presets.length) throw new Error('no engines found');
    setLoad(0.4);
  } catch (e) { loadFailed('The engine simulator could not be loaded', e); return; }
  // Draw an engine before the benchmark, so the floor is there to spread while the rest loads: the
  // one asked for, or the first choice. If the benchmark then says this device needs a lighter
  // default, that one is drawn instead.
  const want = PAGE_ENGINE || Q.get('engine');
  if (want && !presetOf(want)) S.unknownEngine = want;
  let first = presetOf(want) ? want : PREFERRED.find(presetOf) || S.presets[0].name;
  const draw = async (name) => { if (LiveEngine.preview) await showPreview(name, {}); };
  S.name = first;
  try { await draw(first); } catch (e) { loadFailed('The engine could not be built', e); return; }
  placeKey();
  setLoad(0.5);
  try { if (!S.mock) await benchmarkDevice(LiveEngine); } catch (e) { loadFailed('The engine simulator could not be loaded', e); return; }
  S.name = presetOf(want) ? want : defaultEngine();
  for (const e of document.querySelectorAll('.ecount')) e.textContent = String(S.presets.length);
  buildPicker();
  if (S.name !== first) { try { await draw(S.name); } catch (e) { loadFailed('The engine could not be built', e); return; } }
  const b = $('btnStart');
  setLoad(1);
  S.scene.setReady();
  b.disabled = false;
  b.classList.remove('loading');
  setLabel('start');
  FR.ready();
  if (S.unknownEngine) { $('starttext').textContent = `There is no engine called “${S.unknownEngine}” here, so this is the ${presetOf(S.name).label}.`; $('starttext').hidden = false; }
}
/** The previous/next engine key caps sit just right of the "Engines" pill, whose width changes with its tag. */
function placeStep() {
  const g = document.querySelector('.engbtn-go'), b = $('brand').getBoundingClientRect(), r = g.getBoundingClientRect();
  if (!r.width) return;
  $('engstep').style.left = `${Math.round(r.right - b.left + 10)}px`;
  $('engstep').style.top = `${Math.round(r.top - b.top + (r.height - $('engstep').offsetHeight) / 2)}px`;
}
window.addEventListener('resize', placeStep);
/** Tell the scene where the space-bar key is on screen, so the opening ripples start under it. */
function placeKey() {
  const r = $('btnStart').getBoundingClientRect();
  if (S.scene && r.width) S.scene.setKeyPoint((r.left + r.width / 2) / innerWidth * 2 - 1, 1 - (r.top + r.height / 2) / innerHeight * 2);
}
window.addEventListener('resize', placeKey);
async function showPreview(name, overrides) {
  const pv = await S.LiveEngine.preview(name, overrides);
  S.preview = pv;
  showHeader(pv.header);
}

function banner(text, ms = 6000) {
  $('banner').textContent = text;
  $('banner').hidden = !text;
  clearTimeout(banner.t);
  if (text) banner.t = setTimeout(() => { $('banner').hidden = true; }, ms);
}

function onRebuild() {
  const h = S.engine.header;
  if (!h) return;
  const changed = S.shownEngine !== S.engine.engine;
  S.shownEngine = S.engine.engine;
  showHeader(h);
  WD.skip = 1; WD.hot = 0; WD.hotSince = null;
  if (changed) { hideTooHeavy(); WD.noticeFor = null; }
  setUrlEngine(S.engine.engine);
}

function showHeader(h) {
  const sp = h.spec, n = sp.firing.length;
  S.header = h;
  try {
    S.scene.setHeader(h);
  } catch (e) {
    // the drawing code does not know every kind of engine yet; the sound does not depend on it
    S.scene.clear();
    console.warn('picture: cannot draw this engine:', e);
    banner(`The ${sp.label} cannot be drawn yet, so the picture is empty; the sound and the dials are not affected.`, 9000);
  }
  showChargeLegend();
  $('elabel').textContent = sp.label;
  const rotary = h.kind === 'wankel';
  if (rotary) {
    // one chamber's displacement; the litre figure is the usual four-stroke equivalent
    const cc = 3 * Math.sqrt(3) * sp.ecc * sp.rotor_r * sp.rotor_w * 1e6, nr = h.units;
    $('espec').textContent = `${(nr * cc / 1000).toFixed(1)} L (${nr} × ${Math.round(cc)} cc) · ${nr} rotors · redline ${Math.round(sp.redline)}`;
  } else {
    const litres = Math.PI / 4 * sp.bore * sp.bore * sp.stroke * n * 1000;
    $('espec').textContent = `${litres.toFixed(litres < 2 ? 2 : 1)} L · ${n} cyl · ${(sp.bore * 1000).toFixed(1)} × ${(sp.stroke * 1000).toFixed(1)} mm · redline ${Math.round(sp.redline)}`;
  }
  // the vehicle the engine pushes in Drive, when its definition has one (README "Vehicles in Drive")
  const veh = h.vehicle, ev = $('evehicle');
  ev.hidden = !veh;
  ev.textContent = veh ? vehicleLine(veh) : '';
  ev.title = veh ? `In Drive this engine pushes its own ${veh.kind}: ${Math.round(veh.mass_kg)} kg is its curb weight plus ${veh.kind === 'motorcycle' ? 'a rider' : 'a driver'}` : '';
  for (const b of document.querySelectorAll('#views button')) b.classList.toggle('on', b.dataset.view === S.scene.viewName);
  const lamps = $('lamps');
  lamps.replaceChildren();
  S.lamps = [];
  S.lampHold = [];
  // rotary: one lamp per chamber, grouped by rotor
  for (let i = 0; i < n; i++) { const el = document.createElement('i'); if (rotary && i > 0 && i % 3 === 0) el.className = 'g'; lamps.appendChild(el); S.lamps.push(el); }
  S.tachMax = Math.ceil(sp.redline * 1.1 / 1000) * 1000;
  for (const c of document.querySelectorAll('.eng')) c.classList.toggle('on', c.dataset.name === S.name);
  const tag = $('curtag');
  tag.className = sp.generic === false ? 'tag real' : 'tag gen';
  tag.textContent = sp.generic === false ? 'Real' : 'Generic';
  placeStep();
  $('cam').hidden = !(sp.cam_switch_rpm > 0);
  S.camHigh = false;
  if (BR.open) renderDetail(presetOf(BR.active));
  syncWorkshop();
}

/** Keep the address bar in step with the running engine, so a reload or a copied URL keeps it: the
 * engine's own page e/<id>/ in the published build (other parameters kept, ?engine= dropped), else ?engine=. */
function setUrlEngine(name) {
  try {
    const u = new URL(location.href);
    if (ENGINE_PAGES && presetOf(name)) {
      const p = enginePage(name);
      u.searchParams.delete('engine');
      p.search = u.search; p.hash = u.hash;
      if (p.href !== location.href) history.replaceState(null, '', p);
      return;
    }
    if (u.searchParams.get('engine') === name) return;
    u.searchParams.set('engine', name);
    history.replaceState(null, '', u);
  } catch (e) { /* not allowed here (file:// or sandboxed) */ }
}

// A tiny silent WAV, looped through a media element. On iOS a playing media element puts the
// page in the "playback" audio category, so Web Audio is not muted by the ring/silent switch
// (older iOS has no navigator.audioSession to ask for that directly).
function silentWav() {
  const n = 4800, b = new ArrayBuffer(44 + n * 2), v = new DataView(b);
  const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 48000, true); v.setUint32(28, 96000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
function unlockAudio() {
  // everything here must run inside the tap/click/key handler, before any await
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
  if (isIOS()) {
    try {
      if (!S.keepAlive) { S.keepAlive = new Audio(silentWav()); S.keepAlive.loop = true; S.keepAlive.setAttribute('playsinline', ''); }
      S.keepAlive.play().catch(() => {});
    } catch (e) { /* ignore */ }
  }
  try { const src = S.ctx.createBufferSource(); src.buffer = S.ctx.createBuffer(1, 1, S.ctx.sampleRate); src.connect(S.ctx.destination); src.start(0); } catch (e) { /* ignore */ }
  return S.ctx.resume();
}
function newAudioContext() {
  // 48 kHz is what the simulator writes; latencyHint 0 asks for the shortest output buffer the device allows
  for (const o of [{ sampleRate: 48000, latencyHint: 0 }, { sampleRate: 48000 }, {}]) {
    try { return new AudioContext(o); } catch (e) { /* try the next, plainer request */ }
  }
  throw new Error('this browser refused to open an audio output');
}
function audioStatus() {
  const e = S.engine, st = (e && e.stats) || {};
  let level = '?';
  if (S.analyser) { const b = new Float32Array(1024); S.analyser.getFloatTimeDomainData(b); let q = 0; for (const v of b) q += v * v; level = Math.sqrt(q / b.length).toFixed(3); }
  return `SIGNAL ${level} · ` + audioStatusRest(e, st);
}
function debugBeep() {
  // a plain tone straight to the speaker, bypassing the engine: tells "phone is silent" from "engine is silent"
  try {
    const o = S.ctx.createOscillator(), g = S.ctx.createGain(); o.frequency.value = 660; g.gain.value = 0.15;
    o.connect(g); g.connect(S.ctx.destination); o.start(); o.stop(S.ctx.currentTime + 0.4);
  } catch (e) { /* ignore */ }
}
function audioStatusRest(e, st) {
  return `audio ${S.ctx ? S.ctx.state : 'none'} @ ${S.ctx ? S.ctx.sampleRate : '?'} Hz · session ${navigator.audioSession ? navigator.audioSession.type : 'n/a'} · engine ${e && e.frame ? 'running' : 'no frames'} · load ${Math.round((st.load || 0) * 100)}% ${st.quality || ''} · picture ${PIC.level} · build ${window.__build || 'dev'}`;
}
/** The press that starts the engine. The synchronous part (audio session, context, unlock) must stay before any await. */
function start() {
  if (S.started || S.starting || S.failed || !S.LiveEngine || $('btnStart').disabled) return;
  S.starting = true;
  let resumed;
  try {
    if (!S.ctx) S.ctx = newAudioContext();
    resumed = unlockAudio();
  } catch (e) { S.starting = false; loadFailed('Sound could not be started', e); return; }
  $('btnStart').classList.add('starting');
  setLabel('starting');
  startEngine(resumed).catch((e) => { S.starting = false; loadFailed('The engine could not start', e); });
}
async function startEngine(resumed) {
  try {
    S.engine = await S.LiveEngine.create(S.ctx, { engine: S.name, overrides: S.overrides, quality: qualityFor(S.name) });
  } catch (e) {
    S.starting = false;
    loadFailed('The engine could not start', e);
    return;
  }
  const master = S.ctx.createGain();
  master.gain.value = 0.8;
  S.analyser = S.ctx.createAnalyser();
  S.analyser.fftSize = 4096;
  S.analyser.smoothingTimeConstant = 0.55;
  S.engine.output.connect(master);
  master.connect(S.ctx.destination);
  master.connect(S.analyser);
  // the spectrum of the sound being played, for the spectrogram widget and the floor
  S.spectrum = new SpectroSource(S.ctx, master);
  // offline capture: no sound is played, so the oscilloscope and the spectrum read the computed samples instead
  if (S.engine.tap) { S.analyser = S.engine.tap.analyser; S.spectrum = S.engine.tap.spectrum; }
  S.scene.setSpectrum(S.spectrum);
  // every visit starts in Drive with automatic shifting, at rest: the first hold of the throttle pulls away
  S.engine.setMode(S.mode);
  S.engine.addEventListener('rebuild', onRebuild);
  S.engine.addEventListener('stats', onStats);
  onRebuild();
  syncFuel();
  if (S.mock) {
    $('wsnote').textContent = 'This is a replay of a recording, so the workshop and the throttle are inactive. Open the page without ?mock=1 for the live engine.';
    for (const el of document.querySelectorAll('#workshop input, #workshop button')) el.disabled = true;
  }
  S.started = true; S.starting = false;
  // iOS suspends or "interrupts" the context on calls, app switches and screen lock: resume on the next touch
  const again = () => { if (S.ctx && S.ctx.state !== 'running') unlockAudio(); };
  window.addEventListener('pointerdown', again); window.addEventListener('keydown', again);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) again(); });
  // lights up: the engine swings round to its view as the picture brightens, the dials and keys arrive
  $('btnStart').classList.remove('starting');
  $('start').hidden = true;
  document.body.classList.replace('pre', 'run');
  const orbiting = S.scene.attract;
  S.scene.setAttract(false);
  placeKey();
  S.scene.ignite();
  if (orbiting && S.scene.model) S.scene.setView(S.scene.viewName);
  FR.started();
  syncDrive();
  PIC.reset();
  await Promise.resolve(resumed).catch(() => {});
  setTimeout(() => {
    if (S.ctx.state !== 'running') banner('Sound is not running (' + S.ctx.state + '). Tap anywhere to try again.');
  }, 1500);
  // ?debug=1 keeps a live status line on screen (for reading off a phone)
  if (Q.has('debug')) { debugBeep(); setTimeout(debugBeep, 1200); }
  if (Q.has('debug')) setInterval(() => { $('banner').textContent = audioStatus(); $('banner').hidden = false; }, 1000);
}

// ------------------------------------------------------------------ audio load watchdog
// The audio thread reports its load about once a second. Above about 0.9 for two reports at the
// heavy level, the engine is rebuilt at the light level. The too-heavy notice is for an engine this
// device really cannot run, not for a busy moment: at the light level the load must stay above 0.9
// for NOTICE_AFTER seconds without one report under it; the notice goes away by itself after three
// reports under NOTICE_CLEAR; and an engine the viewer chose to keep is never flagged again.
const NOTICE_AFTER = 6, NOTICE_CLEAR = 0.8;
const WD = { hot: 0, skip: 1, noticeFor: null, hotSince: null, cool: 0, kept: new Set() };
function onStats() {
  const e = S.engine;
  if (!e || S.mock || !e.header) return;
  if (WD.skip > 0) { WD.skip--; return; }   // the report that straddles a rebuild
  const load = e.stats.load, name = e.engine, stock = !Object.keys(e.overrides || {}).length;
  S.lastLoad = load;
  if (stock) {
    // what this engine really costs here; the first engine run at the light level also rescales
    // every prediction (the audio thread can be slower than the main-thread benchmark)
    const o = S.observed[name] || (S.observed[name] = {});
    const lvl = e.level;
    o[lvl] = o[lvl] === undefined ? load : 0.6 * o[lvl] + 0.4 * load;
    if (lvl === 'light') {
      const f = o.light / costOf(name);
      S.factor = S.audioFactor === undefined ? f : 0.7 * S.factor + 0.3 * f;
      S.audioFactor = S.factor;
      if (BR.open) markLoads();
    }
  }
  const now = performance.now();
  if (load > 0.9) { WD.hot += load > 1.3 ? 2 : 1; if (WD.hotSince === null) WD.hotSince = now; } else { WD.hot = 0; WD.hotSince = null; }
  // the notice clears itself once the load has recovered
  if (WD.noticeFor === name && !$('heavy').hidden) { WD.cool = load < NOTICE_CLEAR ? WD.cool + 1 : 0; if (WD.cool >= 3) { hideTooHeavy(); WD.noticeFor = null; WD.hotSince = null; } }
  if (WD.hot >= 2 && e.level === 'heavy' && !S.busy) {
    WD.hot = 0;
    S.demoted.add(name);
    banner('Switched to the light quality level so the sound keeps up on this device.');
    S.busy = true;
    e.setQuality('light').catch(showError).finally(() => { S.busy = false; });
  } else if (e.level === 'light' && WD.hotSince !== null && now - WD.hotSince >= NOTICE_AFTER * 1000 && WD.noticeFor !== name && !WD.kept.has(name)) {
    showTooHeavy(name, load);
  }
}
function showTooHeavy(name, load) {
  WD.noticeFor = name; WD.cool = 0;
  const alt = defaultEngine(name);
  $('heavyText').textContent = `Simulating the ${presetOf(name) ? presetOf(name).label : name} takes about ${Math.round(load * 100)}% of real time here, even at the lightest quality level, so the sound will stutter.`;
  const b = $('heavySwitch');
  b.textContent = `Switch to ${presetOf(alt).label}`;
  b.onclick = () => { hideTooHeavy(); pickEngine(alt); };
  $('heavy').hidden = false;
}
function hideTooHeavy() { $('heavy').hidden = true; }

// ------------------------------------------------------------------ picture watchdog
// After start, frame times are watched in windows of 1.5 s (at least 20 frames). If frames do not fit (the
// display's refresh, or 55 fps, whichever is slower) or the page's own per-frame work grows past
// 12 ms, the picture steps down: pixel ratio, then the floor reflection, then bloom, then a lower
// pixel ratio again, and last, drawing every other frame.
const PIC = {
  level: 0, steps: [], frames: [], work: [], settle: 0, half: false,
  reset() {
    const sc = S.scene, r0 = sc.pixelRatio;
    this.steps = [];
    if (r0 > 1.5) this.steps.push(['pixel ratio 1.5', () => sc.setPixelRatio(1.5)]);
    if (r0 > 1) this.steps.push(['pixel ratio 1', () => sc.setPixelRatio(1)]);
    this.steps.push(['no floor reflection', () => sc.setReflection(false)]);
    this.steps.push(['no bloom', () => sc.setBloom(false)]);
    this.steps.push(['pixel ratio 0.75', () => sc.setPixelRatio(0.75)]);
    this.steps.push(['half frame rate', () => { this.half = true; }]);
    this.level = 0; this.frames = []; this.work = []; this.settle = 1500; this.log = [];
    this.on = true;
    S.pic = this;
  },
  sample(dtMs, workMs) {
    if (!this.on || document.hidden) return;
    // settle (ms) after start and after each step; a stall over 250 ms (tab switch, engine rebuild) is not a frame
    if (this.settle > 0 || dtMs > 250) { this.settle = Math.max(this.settle - Math.min(dtMs, 250), 0); return; }
    this.frames.push(dtMs); this.work.push(workMs);
    this.span = (this.span || 0) + dtMs;
    if (this.span < 1500 || this.frames.length < 20) return;
    this.span = 0;
    const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
    const f = this.frames.slice().sort((x, y) => x - y);
    const refresh = clamp(f[Math.floor(f.length * 0.1)], 6, 34);   // the display's own interval, near enough
    const dt = med(this.frames), work = med(this.work) / (this.half ? 2 : 1);
    const fits = dt <= Math.max(refresh * 1.3, 18.2) && work < 12;
    this.frames = []; this.work = [];
    if (fits || this.level >= this.steps.length) return;
    const [what, apply] = this.steps[this.level++];
    apply();
    this.log.push(`${what} (frame ${dt.toFixed(1)} ms, work ${work.toFixed(1)} ms)`);
    this.settle = 1000;
  },
};

// ------------------------------------------------------------------ engine library
// A browser for however many engines the simulator carries: grouped by family, searchable,
// with a details pane (sourced facts, what is estimated, links). Nothing here is a fixed list;
// families and counts come from the presets.
const FAMILY_RANK = { single: 1, twin: 2, triple: 3, three: 3, 'inline-four': 4, four: 4, five: 5, 'inline-five': 5, six: 6, 'inline-six': 6, v6: 6.5, eight: 8, 'inline-eight': 8, 'straight-eight': 8, v8: 8.5, v10: 10, v12: 12, w: 12.6, w8: 8.7, w12: 12.6, v16: 16, w16: 16.5, flat: 50, boxer: 50, rotary: 60, wankel: 60, radial: 70, 'two-stroke': 80, 'two-strokes': 80, two_stroke: 80 };
const FAMILY_TITLE = { single: 'Singles', twin: 'Twins', triple: 'Triples', three: 'Triples', 'inline-four': 'Inline-fours', four: 'Fours', five: 'Fives', 'inline-five': 'Fives', six: 'Inline-sixes', 'inline-six': 'Inline-sixes', eight: 'Straight-eights', flat: 'Flat', boxer: 'Flat', rotary: 'Rotary', wankel: 'Rotary', radial: 'Radial', w: 'W', 'two-stroke': 'Two-strokes', two_stroke: 'Two-strokes' };
const isRotary = (sp) => sp.layout === 'rotary' || sp.kind === 'wankel';
const unitsOf = (sp) => (isRotary(sp) ? (sp.rotor_phase || []).length : sp.firing.length);
const litresOf = (sp) => (isRotary(sp)
  ? unitsOf(sp) * 3 * Math.sqrt(3) * sp.ecc * sp.rotor_r * sp.rotor_w * 1000
  : Math.PI / 4 * sp.bore * sp.bore * sp.stroke * sp.firing.length * 1000);
const fmtL = (l) => (l < 2 ? (l < 1 ? `${Math.round(l * 1000)} cc` : `${l.toFixed(2)} L`) : `${l.toFixed(1)} L`);
function layoutWord(sp) {
  if (isRotary(sp)) return 'rotary';
  if (sp.layout === 'radial') return 'radial';
  if (sp.layout === 'flat') return 'flat';
  if (sp.layout === 'w') return 'W';
  if (sp.layout === 'v') return 'vee';
  return sp.firing.length === 1 ? 'single' : 'inline';
}
function bankSpread(sp) {
  if (Array.isArray(sp.bank_dirs) && sp.bank_dirs.length > 1) {
    const d = sp.bank_dirs.map((x) => ((x + 180) % 360 + 360) % 360 - 180);
    return Math.max(...d) - Math.min(...d);
  }
  return sp.bank_angle || 0;
}
function describeLayout(sp) {
  const n = unitsOf(sp);
  if (isRotary(sp)) return `${n}-rotor Wankel`;
  if (sp.layout === 'radial') return `${n}-cylinder radial, one row`;
  if (sp.layout === 'flat') return `Flat-${n}`;
  if (sp.layout === 'w') return `W${n}, ${new Set(sp.bank).size} rows of cylinders`;
  if (sp.layout === 'v') return `${n === 2 ? 'V-twin' : `V${n}`}, ${Math.round(bankSpread(sp))}° between banks`;
  return n === 1 ? 'Single cylinder' : `Inline-${n}`;
}
const familyKey = (p) => String(p.spec.family || p.spec.layout || 'other').trim();
function familyGroups(list) {
  const groups = new Map();
  for (const p of list) { const k = familyKey(p); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  const rank = (k, members) => {
    const key = k.toLowerCase().replace(/\s+/g, '-');
    if (key in FAMILY_RANK) return FAMILY_RANK[key];
    const lay = members[0].spec.layout;
    if (members.every((m) => m.spec.kind === 'two_stroke')) return 80;
    if (members.every((m) => m.spec.layout === lay)) { if (lay === 'flat') return 50; if (isRotary(members[0].spec)) return 60; if (lay === 'radial') return 70; }
    return Math.min(...members.map((m) => unitsOf(m.spec))) + 0.9;      // unknown family: by cylinder count
  };
  return [...groups.entries()].map(([k, members]) => ({ key: k, title: FAMILY_TITLE[k.toLowerCase()] || (k.length <= 3 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)), members, rank: rank(k, members) }))
    .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
}
function haystack(p) {
  const sp = p.spec, n = unitsOf(sp);
  return [p.label, p.name, sp.family, sp.based_on, layoutWord(sp), describeLayout(sp), `${n} cylinder ${n}cyl ${n}-cyl`, sp.layout === 'v' ? `v${n}` : '', sp.layout === 'inline' ? `i${n} l${n} straight` : '', sp.layout === 'flat' ? 'boxer' : '', isRotary(sp) ? 'wankel rotor' : '', sp.generic === false ? 'real' : 'generic invented', sp.itb ? 'individual throttles itb' : '', sp.cam_switch_rpm > 0 ? 'cam switching two-stage cam' : '', sp.kind === 'two_stroke' ? 'two-stroke 2-stroke two stroke expansion chamber' : '']
    .join(' ').toLowerCase();
}
const BR = { open: false, filter: 'all', q: '', active: null, shown: [] };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const isPhone = () => window.matchMedia('(max-width: 900px)').matches;
const tagFor = (sp) => (sp.generic === false ? el('span', 'tag real', 'Real') : el('span', 'tag gen', 'Generic'));

function buildPicker() {
  for (const p of S.presets) p._hay = haystack(p);
  $('engcount').textContent = S.presets.length;
  $('btnEngines').onclick = () => (BR.open ? closeBrowser() : openBrowser());
  $('brClose').onclick = closeBrowser;
  $('brScrim').onclick = closeBrowser;
  $('brSearch').addEventListener('input', () => { BR.q = $('brSearch').value; renderList(); });
  for (const b of document.querySelectorAll('#brFilter button')) b.onclick = () => {
    BR.filter = b.dataset.f;
    for (const o of document.querySelectorAll('#brFilter button')) o.classList.toggle('on', o === b);
    renderList();
  };
  renderList();
}
function renderList() {
  const words = BR.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = S.presets.filter((p) => (BR.filter === 'all' || (BR.filter === 'real') === (p.spec.generic === false)) && words.every((w) => (p._hay || (p._hay = haystack(p))).includes(w)));
  const box = $('brList');
  box.replaceChildren();
  BR.shown = [];
  for (const g of familyGroups(list)) {
    const h = el('h3', '', g.title);
    h.appendChild(el('span', '', String(g.members.length)));
    const grid = el('div', 'br-grid');
    for (const p of g.members) {
      const sp = p.spec;
      const b = el('button', 'eng');
      b.dataset.name = p.name;
      b.type = 'button';
      const n = el('div', 'n', String(unitsOf(sp)));
      n.appendChild(el('small', '', layoutWord(sp)));
      const t = el('div');
      t.append(el('div', 'l', p.label), el('div', 's', sp.generic === false ? (sp.based_on || 'Real engine') : `${fmtL(litresOf(sp))} · ${Math.round(sp.redline)} rpm`));
      const side = el('div', 'side');
      side.appendChild(tagFor(sp));
      const slow = el('span', 'tag slow', 'heavy');
      slow.title = 'Predicted not to keep up in real time on this device';
      slow.hidden = true;
      side.appendChild(slow);
      const info = el('span', 'info', 'i');
      info.setAttribute('role', 'button');
      info.setAttribute('aria-label', `Details for ${p.label}`);
      info.onclick = (e) => { e.stopPropagation(); setActive(p.name, false); $('browser').classList.add('detail'); };
      side.appendChild(info);
      b.append(n, t, side);
      b.classList.toggle('on', p.name === S.name);
      b.onclick = () => { setActive(p.name, false); pickEngine(p.name).then(() => { if (isPhone()) closeBrowser(); }); };
      b.onfocus = () => setActive(p.name, false);
      grid.appendChild(b);
      BR.shown.push(p.name);
    }
    box.append(h, grid);
  }
  if (!list.length) box.appendChild(el('p', 'hint', 'No engine matches that search.'));
  $('brCount').textContent = list.length === S.presets.length ? `${list.length} engines` : `${list.length} of ${S.presets.length} engines`;
  markLoads();
  if (!BR.shown.includes(BR.active)) BR.active = BR.shown.includes(S.name) ? S.name : (BR.shown[0] || null);
  setActive(BR.active, false);
}
/** Mark engines predicted (or seen) not to keep up on this device. */
function markLoads() {
  for (const c of document.querySelectorAll('#brList .eng')) {
    const p = predictLoad(c.dataset.name), t = c.querySelector('.tag.slow');
    if (t) t.hidden = !(p !== null && p > TOO_HEAVY);
  }
}
function loadLine(name) {
  const o = S.observed[name], p = predictLoad(name);
  if (p === null) return null;
  const pct = `${Math.round(p * 100)}% of real time`;
  const how = o && o.light !== undefined ? 'measured while it ran' : 'predicted';
  return p > TOO_HEAVY ? `${pct} (${how}): too heavy for this device` : `${pct} (${how})`;
}
function setActive(name, scroll = true) {
  BR.active = name;
  for (const c of document.querySelectorAll('#brList .eng')) {
    const on = c.dataset.name === name;
    c.classList.toggle('active', on);
    if (on && scroll) c.scrollIntoView({ block: 'nearest' });
  }
  renderDetail(S.presets.find((p) => p.name === name));
}
/** "In Drive: Citroën 2CV A (1949) · 575 kg · 4-speed" from the header's or library's vehicle block. */
function vehicleLine(v) {
  return `In Drive: ${v.name} · ${Math.round(v.mass_kg)} kg · ${v.gear_count}-speed`;
}
function renderDetail(p) {
  const box = $('brDetail');
  box.replaceChildren();
  if (!p) return;
  const sp = p.spec, n = unitsOf(sp), real = sp.generic === false;
  const back = el('button', 'btn back', '← All engines');
  back.onclick = () => $('browser').classList.remove('detail');
  box.append(back, tagFor(sp), el('h2', '', p.label));
  box.appendChild(el('div', 'based', real ? (sp.based_on || 'A real engine') : 'An invented, typical engine of this layout'));
  const dl = el('dl');
  const row = (k, v) => { if (v !== null && v !== undefined && v !== '') dl.append(el('dt', '', k), el('dd', '', v)); };
  row('Layout', describeLayout(sp));
  if (isRotary(sp)) {
    row('Displacement', `${fmtL(litresOf(sp))} (${n} × ${Math.round(litresOf(sp) / n * 1000)} cc)`);
    row('Rotor', `R ${(sp.rotor_r * 1000).toFixed(0)} mm, e ${(sp.ecc * 1000).toFixed(0)} mm, width ${(sp.rotor_w * 1000).toFixed(0)} mm`);
  } else {
    row('Displacement', fmtL(litresOf(sp)));
    row('Bore × stroke', `${(sp.bore * 1000).toFixed(1)} × ${(sp.stroke * 1000).toFixed(1)} mm`);
    row('Valves per cylinder', String((sp.in_valves === 1 ? 1 : 2) + (sp.ex_valves === 1 ? 1 : 2)));
  }
  row('Compression', `${(+sp.cr).toFixed(1)} : 1`);
  row('Redline', `${Math.round(sp.redline)} rpm`);
  row('Idle', `${Math.round(sp.idle)} rpm`);
  row('Intake', sp.itb ? 'individual throttles' : 'one throttle, plenum');
  if (sp.cam_switch_rpm > 0) row('Cam switch', `${Math.round(sp.cam_switch_rpm)} rpm`);
  box.appendChild(dl);
  const ll = loadLine(p.name);
  if (ll) {
    const pl = el('p', 'loadline' + (predictLoad(p.name) > TOO_HEAVY ? ' warn' : ''), `Simulation load here: ${ll}.`);
    pl.title = 'Share of one processor core the simulation needs to keep up with real time on this device, at the light quality level';
    box.appendChild(pl);
  }
  const pub = sp.published;
  if (pub && (pub.power_kw || pub.torque_nm)) {
    box.appendChild(el('h4', '', 'Published figures'));
    const d2 = el('dl');
    if (pub.power_kw) d2.append(el('dt', '', 'Power'), el('dd', '', `${Math.round(pub.power_kw)} kW (${Math.round(pub.power_kw * 1.341)} hp)${pub.power_rpm ? ` at ${Math.round(pub.power_rpm)}` : ''}`));
    if (pub.torque_nm) d2.append(el('dt', '', 'Torque'), el('dd', '', `${Math.round(pub.torque_nm)} N·m${pub.torque_rpm ? ` at ${Math.round(pub.torque_rpm)}` : ''}`));
    box.appendChild(d2);
  }
  if (p.vehicle && sp.vehicle) {
    const v = p.vehicle, vs = sp.vehicle, rider = v.kind === 'motorcycle' ? 'rider' : 'driver';
    box.appendChild(el('h4', '', 'In Drive'));
    const d3 = el('dl');
    const r3 = (k, val) => { if (val) d3.append(el('dt', '', k), el('dd', '', val)); };
    r3(v.kind === 'motorcycle' ? 'Motorcycle' : v.kind === 'race car' ? 'Race car' : 'Car', v.name);
    r3('Weight', `${Math.round(v.mass_kg)} kg with ${rider} (${Math.round(vs.curb_kg)} kg curb)`);
    r3('Gearbox', `${v.gear_count}-speed${Array.isArray(vs.gears) && vs.gears.length ? `: ${vs.gears.map((g) => (+g).toFixed(2)).join(', ')}` : ''}`);
    if (vs.final_drive) r3(v.kind === 'motorcycle' ? 'Primary × final' : 'Final drive', (+vs.final_drive).toFixed(2));
    if (vs.tyre) r3('Tyre', vs.tyre);
    if (vs.top_speed_kmh) r3('Top speed', `${Math.round(vs.top_speed_kmh)} km/h`);
    box.appendChild(d3);
    if (vs.notes) box.appendChild(el('p', 'vnotes', vs.notes));
  }
  if (sp.notes) { box.appendChild(el('h4', '', real ? 'What is estimated' : 'About this engine')); box.appendChild(el('p', '', sp.notes)); }
  if (Array.isArray(sp.sources) && sp.sources.length) {
    box.appendChild(el('h4', '', 'Sources'));
    const ul = el('ul');
    for (const src of sp.sources) {
      if (!src || !/^https?:\/\//i.test(src.url || '')) continue;
      const li = el('li'), a = el('a', '', src.what || src.url);
      a.href = src.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      let host = '';
      try { host = new URL(src.url).hostname.replace(/^www\./, ''); } catch (e) { /* shown without a host */ }
      li.append(a, el('small', '', host));
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  const actions = el('div', 'actions');
  if (p.name === S.name) actions.appendChild(el('span', 'hint', 'Running now'));
  else { const go = el('button', 'btn on wide', 'Load this engine'); go.onclick = () => pickEngine(p.name).then(() => { if (isPhone()) closeBrowser(); else renderDetail(p); }); actions.appendChild(go); }
  box.appendChild(actions);
}
function openBrowser() {
  BR.open = true;
  $('browser').hidden = false;
  $('brScrim').hidden = false;
  $('browser').classList.remove('detail');
  document.body.classList.add('lib');
  if (S.scene) S.scene.setShift(isPhone() ? 0 : $('browser').offsetWidth / 2);   // the engine moves to the middle of what is left
  $('btnEngines').setAttribute('aria-expanded', 'true');
  $('workshop').classList.remove('open');
  $('btnWorkshop').setAttribute('aria-expanded', 'false');
  BR.active = S.name;
  renderList();
  setActive(BR.shown.includes(S.name) ? S.name : BR.shown[0], true);
  // the search box is not focused on opening: Space and the other keys keep playing the engine while
  // browsing. A click, or the / key, goes to the search box.
}
function closeBrowser() {
  BR.open = false;
  $('browser').hidden = true;
  $('brScrim').hidden = true;
  document.body.classList.remove('lib');
  if (S.scene) S.scene.setShift(0);
  $('btnEngines').setAttribute('aria-expanded', 'false');
  if (document.activeElement && $('browser').contains(document.activeElement)) document.activeElement.blur();
}
/** Keys that belong to the library (Esc, up and down, Enter, / for search). Returns true when it used the key. */
function browserKey(e, inText) {
  if (!BR.open) {
    if (e.key === '/' && !inText && S.presets.length) { e.preventDefault(); openBrowser(); return true; }
    return false;
  }
  if (e.key === '/' && !inText) { e.preventDefault(); $('brSearch').focus(); return true; }
  if (e.key === 'Escape') { if ($('browser').classList.contains('detail')) $('browser').classList.remove('detail'); else closeBrowser(); return true; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const i = BR.shown.indexOf(BR.active), j = clamp(i + (e.key === 'ArrowDown' ? 1 : -1), 0, BR.shown.length - 1);
    if (BR.shown.length) setActive(BR.shown[j], true);
    return true;
  }
  if (e.key === 'Enter' && BR.active && !(e.target && e.target.tagName === 'BUTTON' && !e.target.classList.contains('eng'))) {
    e.preventDefault();
    const name = BR.active;
    pickEngine(name).then(() => { if (isPhone()) closeBrowser(); else setActive(name, false); });
    return true;
  }
  return false;   // everything else (Space, 1 to 9, D, Q, E, S) still plays the engine while browsing
}

/** Library order: the list as the drawer shows it unfiltered (by family, then as the simulator lists them). */
function libraryOrder() {
  return S.order || (S.order = familyGroups(S.presets).flatMap((g) => g.members.map((p) => p.name)));
}
/** Step to the next (+1) or previous (-1) engine, wrapping round. Throttle, Drive and shifting mode carry
 *  across, so holding the throttle and stepping auditions each engine pulling away from rest. */
function stepEngine(d) {
  if (!S.presets.length) return;
  const order = libraryOrder(), from = S.pending ? S.pending.name : S.name;
  const name = order[(order.indexOf(from) + d + order.length) % order.length];
  pickEngine(name);
  if (BR.open) { if (!BR.shown.includes(name)) { BR.q = ''; $('brSearch').value = ''; BR.filter = 'all'; for (const o of document.querySelectorAll('#brFilter button')) o.classList.toggle('on', o.dataset.f === 'all'); renderList(); } setActive(name, true); }
}
async function pickEngine(name, overrides = {}) {
  // a rebuild is under way: remember the newest request and run it when this one is done
  if (S.busy) { S.pending = { name, overrides }; return; }
  S.busy = true;
  try {
    if (name !== S.name) S.wsValues = null;
    S.name = name;
    S.overrides = overrides;
    if (!S.engine) {
      // not started yet: redraw the preview; the engine is built at Start
      if (S.LiveEngine && S.LiveEngine.preview) { await showPreview(name, overrides); setUrlEngine(name); }
    } else {
      if (S.engine.setQuality) await S.engine.setQuality(qualityFor(name), false);
      await S.engine.setEngine(name, overrides);
    }
  } catch (e) { showError(e); }
  S.busy = false;
  if (S.pending) { const q = S.pending; S.pending = null; if (q.name !== S.name || Object.keys(q.overrides).length) return pickEngine(q.name, q.overrides); }
}

// ------------------------------------------------------------------ workshop
function baseSpec() {
  const p = S.presets.find((q) => q.name === S.name);
  return (p && p.spec) || (S.header && S.header.spec);
}
/** Which side of the engine a cylinder's bank leans to (+1 or -1), from its bank direction. Works for V, flat and W. */
function sideOf(base, i) {
  const dirs = Array.isArray(base.bank_dirs) && base.bank_dirs.length ? base.bank_dirs : null;
  const d = dirs ? dirs[base.bank[i]] : (base.bank[i] === 0 ? -1 : 1);
  return (((d + 180) % 360 + 360) % 360 - 180) < 0 ? 1 : -1;
}
const hasSides = (base) => base.layout !== 'inline' && base.layout !== 'radial' && base.layout !== 'rotary' && new Set(base.firing.map((_, i) => sideOf(base, i))).size > 1;
function syncWorkshop() {
  const base = baseSpec();
  if (!base) return;
  const v = S.wsValues || (S.wsValues = { header: 100, unequal: 0, exhaust: 100, cam: 0, muffler: base.muffler_len > 0 });
  $('wsHeader').value = v.header; $('wsUnequal').value = v.unequal; $('wsExhaust').value = v.exhaust; $('wsCam').value = v.cam;
  $('wsMuffler').checked = v.muffler;
  $('wsMuffler').disabled = S.mock || !(base.muffler_len > 0);
  const twoBanks = hasSides(base);
  $('lblUnequal').textContent = twoBanks ? 'Side-to-side difference' : 'Unequal headers';
  $('wsUnequal').disabled = S.mock || base.firing.length < 2;
  const rotary = base.layout === 'rotary';
  // a radial has no banks or sides to set against each other, and a rotary has one header per rotor
  $('wsUnequal').closest('.row').hidden = rotary || base.layout === 'radial';
  // a two-stroke's pipe is one expansion chamber per cylinder (spec.chamber): the header slider scales
  // the whole pipe; there is no cam, no separate exhaust run and no muffler to change
  const two = base.kind === 'two_stroke';
  $('wsCam').closest('.row').hidden = two;
  $('wsExhaust').closest('.row').hidden = two;
  $('wsMuffler').closest('.row').hidden = two;
  $('lblHeader').textContent = two ? 'Expansion chamber length' : 'Header length';
  $('lblCam').textContent = rotary ? 'Port overlap' : 'Cam overlap';
  if (!S.mock) $('wsnote').textContent = rotary
    ? 'Changes rebuild the engine when you let go of a slider. Port overlap moves the exhaust port\'s closing edge later (a wider port) and the intake port\'s opening edge earlier.'
    : 'Changes rebuild the engine when you let go of a slider.';
  const isV8 = S.name === 'v8_cross' || S.name === 'v8_flat';
  $('rowCrank').hidden = !isV8 || !S.presets.some((p) => p.name === 'v8_flat');
  for (const b of document.querySelectorAll('[data-crank]')) b.classList.toggle('on', b.dataset.crank === S.name);
  labelWorkshop();
}
function labelWorkshop() {
  const base = baseSpec();
  if (!base) return;
  const two = base.kind === 'two_stroke' && Array.isArray(base.chamber) && base.chamber.length;
  const mean = two ? base.chamber.reduce((a, c) => a + c[0], 0) : base.primary_len.reduce((a, b) => a + b, 0) / base.primary_len.length;
  $('oHeader').textContent = `${Math.round(mean * +$('wsHeader').value)} cm`;   // metres x percent = centimetres
  $('oUnequal').textContent = `${+$('wsUnequal').value > 0 ? '+' : ''}${$('wsUnequal').value}%`;
  $('oExhaust').textContent = `${$('wsExhaust').value}%`;
  const ov = +$('wsCam').value;
  $('oCam').textContent = base.layout === 'rotary'
    ? `${Math.round(base.port_ex[1] - base.port_in[0] + 6 * ov)}°`     // shaft degrees with both ports open to one chamber
    : `${Math.round(base.ivo + base.evc + 2 * ov)}°`;
}
function workshopOverrides() {
  const base = baseSpec();
  const rotary = base.layout === 'rotary';
  const hs = +$('wsHeader').value / 100, un = rotary || base.layout === 'radial' ? 0 : +$('wsUnequal').value / 100, es = +$('wsExhaust').value / 100, ov = +$('wsCam').value;
  const twoBanks = hasSides(base);
  const side = (i) => (twoBanks ? sideOf(base, i) : (i % 2 ? -1 : 1));
  const o = {};
  if (base.kind === 'two_stroke' && Array.isArray(base.chamber) && base.chamber.length) {
    // scale every section's length, keep its diameters: the tuned speed moves, the shape stays
    if (hs !== 1) o.chamber = base.chamber.map((c) => [+(c[0] * hs).toFixed(4), c[1], c[2]]);
    return o;
  }
  if (hs !== 1 || un !== 0) o.primary_len = base.primary_len.map((L, i) => +(L * hs * (1 + un * side(i))).toFixed(4));
  if (es !== 1) { o.secondary_len = +(base.secondary_len * es).toFixed(4); o.mid_len = +(base.mid_len * es).toFixed(4); o.tail_len = +(base.tail_len * es).toFixed(4); }
  if (ov !== 0 && rotary) {
    // three shaft degrees per step: the exhaust port closes later, the intake port opens earlier
    o.port_ex = [base.port_ex[0], base.port_ex[1] + 3 * ov];
    o.port_in = [base.port_in[0] - 3 * ov, base.port_in[1]];
  } else if (ov !== 0) { o.ivo = base.ivo + ov; o.evc = base.evc + ov; }
  if (base.muffler_len > 0 && !$('wsMuffler').checked) o.muffler_len = 0;
  return o;
}
function applyWorkshop() {
  S.wsValues = { header: +$('wsHeader').value, unequal: +$('wsUnequal').value, exhaust: +$('wsExhaust').value, cam: +$('wsCam').value, muffler: $('wsMuffler').checked };
  pickEngine(S.name, workshopOverrides());
}
function initWorkshop() {
  for (const id of ['wsHeader', 'wsUnequal', 'wsExhaust', 'wsCam']) {
    $(id).addEventListener('input', labelWorkshop);
    $(id).addEventListener('change', applyWorkshop);   // fires on release
  }
  $('wsMuffler').addEventListener('change', applyWorkshop);
  $('wsReset').onclick = () => { S.wsValues = null; syncWorkshop(); resetFuel(); pickEngine(S.name, {}); };
  for (const b of document.querySelectorAll('[data-crank]')) b.onclick = () => { if (b.dataset.crank !== S.name) pickEngine(b.dataset.crank); };
  initFuel();
}

// Fueling: shown only when the running engine offers these controls (they arrive with the
// afterfire work); they act at once, without a rebuild, and the engine keeps them across swaps.
const hasFuel = (e) => !!e && typeof e.setMixture === 'function' && typeof e.setOverrunFuel === 'function' && typeof e.setLimiter === 'function';
function labelFuel() {
  const m = +$('fuMix').value, o = +$('fuOver').value;
  $('oMix').textContent = Math.abs(m - 1) < 0.005 ? 'stoich.' : `${m < 1 ? 'lean' : 'rich'} ${m.toFixed(2)}`;
  $('oOver').textContent = o <= 0 ? 'off' : `${Math.round(o * 100)}%`;
  const pp = +$('fuPops').value;
  $('oPops').textContent = pp <= 0 ? 'off' : `${Math.round(pp * 100)}%`;
}
function syncFuel() {
  const e = S.engine, on = hasFuel(e) && !S.mock;
  $('fuel').hidden = !on;
  if (!on) return;
  if (typeof e.mixture === 'number') $('fuMix').value = e.mixture;
  if (typeof e.overrunFuel === 'number') $('fuOver').value = e.overrunFuel;
  // lift-off pops: only where the engine object offers it
  $('rowPops').hidden = typeof e.setLiftoffPops !== 'function';
  if (typeof e.liftoffPops === 'number') $('fuPops').value = e.liftoffPops;
  const lim = e.limiter === 'spark' ? 'spark' : 'fuel';
  for (const b of document.querySelectorAll('[data-limiter]')) b.classList.toggle('on', b.dataset.limiter === lim);
  labelFuel();
}
function resetFuel() {
  if (!hasFuel(S.engine)) return;
  S.engine.setMixture(1); S.engine.setOverrunFuel(0); S.engine.setLimiter('fuel');
  if (S.engine.setLiftoffPops) S.engine.setLiftoffPops(0);
  syncFuel();
}
function initFuel() {
  $('fuMix').addEventListener('input', () => { labelFuel(); if (hasFuel(S.engine)) S.engine.setMixture(+$('fuMix').value); });
  $('fuOver').addEventListener('input', () => { labelFuel(); if (hasFuel(S.engine)) S.engine.setOverrunFuel(+$('fuOver').value); });
  $('fuPops').addEventListener('input', () => { labelFuel(); if (S.engine && S.engine.setLiftoffPops) S.engine.setLiftoffPops(+$('fuPops').value); });
  for (const b of document.querySelectorAll('[data-limiter]')) b.onclick = () => {
    if (!hasFuel(S.engine)) return;
    S.engine.setLimiter(b.dataset.limiter);
    for (const o of document.querySelectorAll('[data-limiter]')) o.classList.toggle('on', o === b);
  };
}

// ------------------------------------------------------------------ share
function shareUrl() {
  if (ENGINE_PAGES && presetOf(S.name)) return enginePage(S.name).toString();
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  u.searchParams.set('engine', S.name);
  return u.toString();
}
async function shareEngine() {
  const url = shareUrl(), label = presetOf(S.name) ? presetOf(S.name).label : S.name;
  const note = Object.keys(S.overrides || {}).length ? ' (the stock engine; Workshop changes are not in the link)' : '';
  let ok = false;
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(url); ok = true; } } catch (e) { /* denied: try the old way */ }
  if (!ok) {
    try {
      const t = document.createElement('textarea');
      t.value = url; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select(); t.setSelectionRange(0, url.length);
      ok = document.execCommand('copy');
      t.remove();
    } catch (e) { ok = false; }
  }
  S.lastShared = url;
  if (ok) banner(`Link to the ${label} copied${note}.`, 4000);
  else banner(`Copy this link: ${url}`, 15000);
}

// ------------------------------------------------------------------ controls
// The controls are drawn as their keys (#kb): the space bar is the throttle, 1 to 9 part throttle,
// Q and E shift, A automatic shifting, S brake, D drive/neutral with its lever. A cap goes down
// while its key is held, and on a touch screen the caps are the buttons.
//
// Space is sacrosanct: inside this page it is the throttle and nothing else. It never scrolls,
// never presses a focused button, chip, slider or checkbox, and works with the engine library, the
// Workshop or About open. The only exception is a real text field (the library's search box),
// where it types a space. The other control keys follow the same rule.
const THR_KEYS = new Set(['Space', 'KeyW', 'ArrowUp', 'PtrSpace']);
const BRAKE_KEYS = new Set(['KeyS', 'ArrowDown', 'KeyB']);
/** Throttle a key asks for while held: 1 for Space/W/Up and for 0, 0.1 to 0.9 for the number keys 1 to 9. */
function keyThrottle(code) {
  if (THR_KEYS.has(code)) return 1;
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  return m ? (+m[1] || 10) / 10 : 0;
}
const heldThrottle = () => { let t = 0; for (const k of S.keysDown) t = Math.max(t, keyThrottle(k)); return t; };
function sendThrottle(x) { S.thr = x; if (S.engine) S.engine.setThrottle(x); S.thrSent = x; }
/** Close the throttle at once if nothing is holding it open any more. */
function releaseThrottle() { if (S.started && S.engine && !S.pedalDrag && heldThrottle() === 0) sendThrottle(Math.min(S.thr, 0.08)); }
const NUM_CAPS = [...document.querySelectorAll('#pedal .num')];
const CAPS = { KeyQ: 'btnDown', BracketLeft: 'btnDown', KeyE: 'btnUp', BracketRight: 'btnUp', KeyA: 'btnAuto', KeyD: 'btnMode', ArrowLeft: 'btnPrevEng', ArrowRight: 'btnNextEng' };
/** Press down exactly the caps whose keys (or fingers) are held. */
function syncCaps() {
  const held = new Set();
  for (const k of S.keysDown) {
    if (THR_KEYS.has(k)) held.add('btnStart');
    else if (BRAKE_KEYS.has(k)) held.add('btnBrake');
    else if (CAPS[k]) held.add(CAPS[k]);
  }
  if (S.brakeBtn) held.add('btnBrake');
  for (const id of ['btnStart', 'btnBrake', 'btnDown', 'btnUp', 'btnAuto', 'btnMode', 'btnPrevEng', 'btnNextEng']) $(id).classList.toggle('down', held.has(id));
  let n = 0;
  for (const k of S.keysDown) { const t = keyThrottle(k); if (t > 0 && !THR_KEYS.has(k)) n = Math.max(n, Math.round(t * 10)); }
  if (S.pedalDrag) n = Math.max(n, Math.round((S.pedalVal || 0) * 10));
  NUM_CAPS.forEach((c, i) => c.classList.toggle('down', i + 1 === n));
}
/** Lever, D cap and gear readout follow the mode. */
function syncDrive() {
  const on = S.mode === 'drive';
  $('kb').classList.toggle('drive', on);
  $('btnMode').classList.toggle('on', on);
  $('btnMode').setAttribute('aria-pressed', String(on));
}
function setMode(m) {
  if (!S.engine) return;
  S.mode = m;
  S.engine.setMode(m);
  syncDrive();
}
const toggleMode = () => setMode(S.mode === 'drive' ? 'free' : 'drive');
function setAuto(on) {
  if (!S.engine) return;
  S.auto = !!on;
  S.engine.setAutoShift(S.auto);
  $('btnAuto').classList.toggle('on', S.auto);
  $('btnAuto').setAttribute('aria-pressed', String(S.auto));
  $('btnAuto').querySelector('i').textContent = S.auto ? 'auto' : 'manual';   // the legend says which way shifting is now
}
function toggleAuto() {
  if (!S.engine) return;
  setAuto(!S.auto);
  FR.shifted();
}
/** A shift asked for by the player. In gear with automatic shifting on, it also takes over the shifting; the A key gives it back. */
function shift(d) {
  if (!S.engine) return;
  if (S.mode === 'drive') {
    if (S.auto) {
      setAuto(false);
      if (!S.nudged) { S.nudged = true; $('btnAuto').classList.add('nudge'); }
    }
    FR.shifted();
  }
  S.engine.shift(d);
}
const openNote = () => { $('note').hidden = false; const c = $('note').querySelector('.card'); c.scrollTop = 0; c.focus({ preventScroll: true }); };
const closeNote = () => { $('note').hidden = true; };
/** A field where typing is the point: keys belong to it, including Space. */
const isTextField = (t) => !!t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
  || (t.tagName === 'INPUT' && !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/.test(t.type)));
const isSlider = (t) => !!t && t.tagName === 'INPUT' && t.type === 'range';
function onKeyDown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;            // browser and system shortcuts stay theirs
  const text = isTextField(e.target);
  if (e.code === 'Space' && !text) e.preventDefault();       // no scroll, no click on whatever has focus
  if (!$('note').hidden && e.key === 'Escape') { closeNote(); return; }
  if (browserKey(e, text)) return;
  if (text) return;
  const arrow = e.code === 'ArrowUp' || e.code === 'ArrowDown';
  if (arrow && isSlider(e.target)) return;                    // arrows move a focused slider
  if (THR_KEYS.has(e.code) || BRAKE_KEYS.has(e.code)) e.preventDefault();
  if (e.repeat) return;
  if (!S.started) {
    if (S.starting) { if (keyThrottle(e.code) > 0) { S.keysDown.add(e.code); syncCaps(); } return; }
    // the press that starts the engine is not also a throttle press: it never enters keysDown, so
    // holding it does nothing more until it has been released and pressed again
    if (e.code === 'Space' || (e.code === 'Enter' && !(e.target && /^(BUTTON|A)$/.test(e.target.tagName) && e.target !== $('btnStart')))) {
      e.preventDefault();
      if (e.code === 'Space') { S.startKey = true; $('btnStart').classList.add('down'); }
      start();
    }
    return;
  }
  S.keysDown.add(e.code);
  // answer a throttle key at once (do not wait for the next animation frame or the ramp)
  const k = keyThrottle(e.code);
  if (k > 0 && S.engine) { const v = k === 1 ? 0.9 : k; if (S.thr < v) sendThrottle(v); }
  if (e.code === 'KeyD') toggleMode();
  if (e.code === 'KeyE' || e.code === 'BracketRight') shift(1);
  if (e.code === 'KeyQ' || e.code === 'BracketLeft') shift(-1);
  if (e.code === 'KeyA') toggleAuto();
  if ((e.code === 'ArrowRight' || e.code === 'ArrowLeft') && !isSlider(e.target)) { e.preventDefault(); stepEngine(e.code === 'ArrowRight' ? 1 : -1); }
  syncCaps();
}
function onKeyUp(e) {
  if (e.code === 'Space' && !isTextField(e.target)) { e.preventDefault(); S.spaceUpAt = performance.now(); }
  if (e.code === 'Space' && S.startKey) { S.startKey = false; $('btnStart').classList.remove('down'); }
  S.keysDown.delete(e.code);
  // let go of the last throttle key: close at once; with another still held, the loop eases down to it
  if (keyThrottle(e.code) > 0) releaseThrottle();
  syncCaps();
}
function initControls() {
  // capture phase on the document: these see every key before whatever has focus does
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  // belt and braces: a click made by the keyboard right after Space came up is Space pressing a focused control
  document.addEventListener('click', (e) => {
    if (e.detail === 0 && e.isTrusted && performance.now() - (S.spaceUpAt || -1e9) < 120) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  window.addEventListener('blur', () => { S.keysDown.clear(); S.pedalDrag = false; S.pedalId = null; S.spaceId = null; S.brakeBtn = false; S.startKey = false; syncCaps(); });

  // the space-bar key: a click or tap starts the engine; after that, holding it is full throttle
  const sp = $('btnStart');
  S.spaceId = null;
  sp.onclick = start;
  sp.addEventListener('pointerdown', (e) => {
    if (!S.started) return;                                    // before the start, the click that follows does the work
    e.preventDefault();
    if (S.spaceId !== null && S.spaceId !== e.pointerId) return;
    try { sp.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    S.spaceId = e.pointerId;
    S.keysDown.add('PtrSpace');
    if (S.thr < 0.9) sendThrottle(0.9);
    syncCaps();
  });
  const spUp = (e) => {
    if (e.pointerId !== S.spaceId) return;
    S.spaceId = null;
    S.keysDown.delete('PtrSpace');
    releaseThrottle();
    syncCaps();
  };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) sp.addEventListener(ev, spUp);
  sp.addEventListener('touchstart', (e) => { if (S.started) e.preventDefault(); }, { passive: false });
  sp.addEventListener('contextmenu', (e) => e.preventDefault());

  // the number row: press or slide along it for 10 to 100% (mouse, pen and touch)
  const pedal = $('pedal');
  const fromPointer = (e) => { const r = pedal.getBoundingClientRect(); return clamp(Math.floor((e.clientX - r.left) / r.width * 10) + 1, 1, 10) / 10; };
  pedal.addEventListener('pointerdown', (e) => {
    if (S.pedalId !== null && S.pedalId !== e.pointerId) return;   // a second finger on the row is ignored
    try { pedal.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
    S.pedalId = e.pointerId; S.pedalDrag = true; S.pedalVal = fromPointer(e);
    if (S.started && S.pedalVal > S.thr) sendThrottle(S.pedalVal);
    syncCaps();
    e.preventDefault();
  });
  pedal.addEventListener('pointermove', (e) => { if (S.pedalDrag && e.pointerId === S.pedalId) { S.pedalVal = fromPointer(e); syncCaps(); } });
  const up = (e) => {
    if (e.pointerId !== S.pedalId) return;
    S.pedalDrag = false; S.pedalId = null;
    releaseThrottle();
    syncCaps();
  };
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) pedal.addEventListener(ev, up);
  // no scrolling, zooming, text selection or callout from a finger held on a key
  for (const b of [pedal, $('btnBrake')]) b.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  syncDrive();   // drawn in Drive from the first frame: that is how every visit starts
  $('btnMode').onclick = toggleMode;
  $('lever').onclick = toggleMode;
  $('btnAuto').onclick = toggleAuto;
  $('btnAuto').addEventListener('animationend', () => $('btnAuto').classList.remove('nudge'));
  $('btnUp').onclick = () => shift(1);
  $('btnDown').onclick = () => shift(-1);
  const br = $('btnBrake');
  br.addEventListener('pointerdown', (e) => { try { br.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ } S.brakeBtn = true; syncCaps(); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) br.addEventListener(ev, () => { S.brakeBtn = false; syncCaps(); });
  $('gear').addEventListener('animationend', () => $('gear').classList.remove('tick'));
  $('tach').addEventListener('animationend', () => $('tach').classList.remove('kick'));
  $('btnPrevEng').onclick = () => stepEngine(-1);
  $('btnNextEng').onclick = () => stepEngine(1);
  $('btnInfo').onclick = openNote;
  $('btnAbout').onclick = openNote;
  $('btnShare').onclick = shareEngine;
  $('noteClose').onclick = closeNote;
  $('note').addEventListener('click', (e) => { if (e.target === $('note')) closeNote(); });
  $('heavyKeep').onclick = () => { if (WD.noticeFor) WD.kept.add(WD.noticeFor); hideTooHeavy(); };
  for (const b of document.querySelectorAll('#views button')) b.onclick = () => {
    if (!S.scene) return;
    S.scene.setView(b.dataset.view);
    for (const o of document.querySelectorAll('#views button')) o.classList.toggle('on', o === b);
  };
  const toggle = (btn, panel) => () => { const open = !panel.classList.contains('open'); panel.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); };
  $('btnWorkshop').onclick = () => { if (BR.open) closeBrowser(); toggle($('btnWorkshop'), $('workshop'))(); };
  initWaves();
}
/** The sound picture on the floor (viz/wave-studies.js): on unless ?waves=0 or off; the "Sound
 *  waves" button toggles it. Off leaves the plain grid floor. */
function initWaves() {
  const b = $('btnWaves');
  const set = (on) => { S.scene && S.scene.setWaves(on); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); S.wavesOn = on; };
  S.wavesOn = !/^(0|off)$/.test(Q.get('waves') || '');
  b.onclick = () => set(!S.wavesOn);
  S.applyWaves = () => set(S.wavesOn);
}
function readGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  S.padThr = 0; S.padBrake = 0;
  for (const p of pads) {
    if (!p || !p.buttons || p.buttons.length < 8) continue;
    S.padThr = Math.max(S.padThr, p.buttons[7].value);
    S.padBrake = Math.max(S.padBrake, p.buttons[6].value);
    const upNow = p.buttons[5].pressed, dnNow = p.buttons[4].pressed;
    if (upNow && !S.padUp) shift(1);
    if (dnNow && !S.padDn) shift(-1);
    S.padUp = upNow; S.padDn = dnNow;
  }
}

// ------------------------------------------------------------------ instruments
const tach = $('tach'), tctx = tach.getContext('2d');
function drawTach(rpm, gear, speed, cut) {
  const W = tach.width, c = W / 2, R = W * 0.44;
  const a0 = 140 * Math.PI / 180, sweep = 260 * Math.PI / 180;
  const max = S.tachMax, red = S.header ? S.header.spec.redline : max;
  const ang = (v) => a0 + sweep * clamp(v / max, 0, 1);
  tctx.clearRect(0, 0, W, W);
  // face
  const face = tctx.createRadialGradient(c, c * 0.9, R * 0.1, c, c, R * 1.08);
  face.addColorStop(0, 'rgba(22,26,36,.88)');
  face.addColorStop(1, 'rgba(5,6,10,.9)');
  tctx.beginPath(); tctx.arc(c, c, R * 1.08, 0, 2 * Math.PI); tctx.fillStyle = face; tctx.fill();
  tctx.lineWidth = 2; tctx.strokeStyle = 'rgba(255,255,255,.10)'; tctx.stroke();
  // track, redline, value
  tctx.lineCap = 'butt';
  tctx.lineWidth = R * 0.085;
  tctx.beginPath(); tctx.arc(c, c, R * 0.93, a0, a0 + sweep); tctx.strokeStyle = 'rgba(255,255,255,.07)'; tctx.stroke();
  tctx.beginPath(); tctx.arc(c, c, R * 0.93, ang(red), a0 + sweep); tctx.strokeStyle = 'rgba(255,60,40,.75)'; tctx.stroke();
  const over = rpm >= red * 0.985;
  const g = tctx.createConicGradient(a0, c, c);
  g.addColorStop(0, '#6fb4ff'); g.addColorStop(0.42, '#ffe2b0'); g.addColorStop(0.68, '#ff9a3c'); g.addColorStop(0.73, '#ff3d24'); g.addColorStop(1, '#ff3d24');
  tctx.beginPath(); tctx.arc(c, c, R * 0.93, a0, ang(rpm)); tctx.strokeStyle = g;
  tctx.shadowColor = over ? 'rgba(255,60,30,.9)' : 'rgba(255,170,80,.7)'; tctx.shadowBlur = 26; tctx.stroke(); tctx.shadowBlur = 0;
  // ticks and numbers
  const stepMajor = max > 12000 ? 2000 : 1000, stepMinor = stepMajor / (max > 12000 ? 4 : 5);
  tctx.textAlign = 'center'; tctx.textBaseline = 'middle';
  for (let v = 0; v <= max + 1; v += stepMinor) {
    const major = Math.abs(v / stepMajor - Math.round(v / stepMajor)) < 1e-6, a = ang(v);
    const r0 = R * (major ? 0.74 : 0.80), r1 = R * 0.86;
    tctx.beginPath(); tctx.moveTo(c + r0 * Math.cos(a), c + r0 * Math.sin(a)); tctx.lineTo(c + r1 * Math.cos(a), c + r1 * Math.sin(a));
    tctx.lineWidth = major ? 4 : 2; tctx.strokeStyle = v >= red ? 'rgba(255,90,70,.95)' : major ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.3)'; tctx.stroke();
    if (major) {
      tctx.font = `500 ${R * 0.115}px ui-monospace, Menlo, monospace`;
      tctx.fillStyle = v >= red ? 'rgba(255,120,100,.95)' : 'rgba(220,226,236,.85)';
      tctx.fillText(String(Math.round(v / 1000)), c + R * 0.62 * Math.cos(a), c + R * 0.62 * Math.sin(a));
    }
  }
  // needle
  const an = ang(rpm);
  tctx.save(); tctx.translate(c, c); tctx.rotate(an);
  tctx.shadowColor = 'rgba(255,120,60,.9)'; tctx.shadowBlur = 18;
  tctx.beginPath(); tctx.moveTo(-R * 0.12, -R * 0.022); tctx.lineTo(R * 0.86, -R * 0.006); tctx.lineTo(R * 0.86, R * 0.006); tctx.lineTo(-R * 0.12, R * 0.022); tctx.closePath();
  tctx.fillStyle = '#ff5a2e'; tctx.fill(); tctx.restore();
  tctx.beginPath(); tctx.arc(c, c, R * 0.36, 0, 2 * Math.PI); tctx.fillStyle = 'rgba(6,7,11,.96)'; tctx.fill();
  tctx.lineWidth = 2; tctx.strokeStyle = 'rgba(255,255,255,.12)'; tctx.stroke();
  // digits
  tctx.fillStyle = over || cut ? '#ffb38f' : '#f3f6fb';
  tctx.font = `600 ${R * 0.21}px ui-monospace, Menlo, monospace`;
  tctx.fillText(String(Math.round(rpm / 10) * 10), c, c - R * 0.03);
  tctx.font = `500 ${R * 0.075}px -apple-system, system-ui, sans-serif`;
  tctx.fillStyle = 'rgba(140,150,168,.95)';
  tctx.fillText('RPM', c, c + R * 0.16);
  tctx.fillText('× 1000', c, c - R * 0.50);
  // gear and road speed
  tctx.font = `600 ${R * 0.24}px ui-monospace, Menlo, monospace`;
  tctx.fillStyle = gear > 0 ? '#ffb04a' : 'rgba(140,150,168,.9)';
  tctx.fillText(gear > 0 ? String(Math.round(gear)) : 'N', c, c + R * 0.60);
  if (gear > 0 || speed > 0.3) {
    tctx.font = `500 ${R * 0.10}px ui-monospace, Menlo, monospace`;
    tctx.fillStyle = 'rgba(220,226,236,.9)';
    tctx.fillText(`${Math.round(speed * 3.6)} km/h`, c, c + R * 0.84);
  }
}

const scope = $('scope'), sctx = scope.getContext('2d');
const spec = $('spec');
let timeBuf = null;
const LUT = (() => {
  const stops = [[0, [4, 5, 10]], [0.25, [40, 22, 96]], [0.5, [168, 40, 96]], [0.72, [255, 122, 40]], [0.9, [255, 214, 130]], [1, [255, 255, 255]]];
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const s = i / 255;
    let k = 1;
    while (k < stops.length - 1 && s > stops[k][0]) k++;
    const a = stops[k - 1], b = stops[k], f = clamp((s - a[0]) / (b[0] - a[0]), 0, 1);
    for (let j = 0; j < 3; j++) out[3 * i + j] = a[1][j] + f * (b[1][j] - a[1][j]);
  }
  return out;
})();
function drawAudio() {
  const an = S.analyser;
  if (!an) return;
  if (!timeBuf) timeBuf = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(timeBuf);
  // scope: start at a rising zero crossing so the trace holds still
  const W = scope.width, H = scope.height, span = 1800;
  let s0 = 0;
  for (let i = 1; i < timeBuf.length - span; i++) if (timeBuf[i - 1] < 0 && timeBuf[i] >= 0) { s0 = i; break; }
  sctx.clearRect(0, 0, W, H);
  sctx.strokeStyle = 'rgba(255,255,255,.07)'; sctx.lineWidth = 1;
  sctx.beginPath(); sctx.moveTo(0, H / 2); sctx.lineTo(W, H / 2); sctx.stroke();
  sctx.beginPath();
  for (let x = 0; x <= W; x += 2) {
    const v = timeBuf[s0 + Math.floor(x / W * span)] || 0;
    const y = H / 2 - v * H * 0.46;
    if (x === 0) sctx.moveTo(x, y); else sctx.lineTo(x, y);
  }
  sctx.strokeStyle = '#ffd9a8'; sctx.lineWidth = 2.5; sctx.shadowColor = 'rgba(255,150,60,.8)'; sctx.shadowBlur = 12; sctx.stroke(); sctx.shadowBlur = 0;
  // spectrogram (live/spectro.js): log frequency, 30 Hz to 12 kHz, five seconds, newest at the right,
  // with the spectrum of the moment in a gutter and marks at multiples of the firing frequency
  if (!S.spectrum) return;
  S.spectrum.read();
  if (!S.liveSpec) S.liveSpec = new LiveSpectro(spec, S.spectrum, LUT);
  const now = performance.now(), h = S.engine && S.engine.header;
  S.liveSpec.draw(Math.min(0.1, (now - (S.specT || now)) / 1000), h ? S.rpm / 60 * h.spec.firing.length * 360 / (h.cycle_deg || 720) : 0);
  S.specT = now;
}
const legendCss = (c) => `rgb(${c.map((v) => Math.round(255 * Math.pow(Math.min(1, v / (1 + 0.25 * v)), 1 / 2.2))).join(',')})`;
/** Boosted engines: the charge air (compressor or blower outlet to the intake valves) has its own
 *  colour scale in the picture (viz/engine-model.js chargeColor); its row of the legend shows it. */
function showChargeLegend() {
  const m = S.scene && S.scene.model, look = m && m.chargeLook;
  $('lgcharge').hidden = !look;
  if (!look) return;
  const stops = [];
  for (let k = 0; k <= 10; k++) { const c = [0, 0, 0]; chargeColor(k / 10 * look.pFull, c, 0, look); stops.push(`${legendCss(c)} ${k * 10}%`); }
  $('legendbar2').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
  $('pfc').textContent = +look.pFull.toFixed(2);
}
function initLegend() {
  const css = legendCss;
  const stops = [];
  for (let k = 0; k <= 20; k++) { const c = [0, 0, 0]; pressureColor((k / 10 - 1) * config.pFull, c, 0); stops.push(`${css(c)} ${k * 5}%`); }
  $('legendbar').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
  for (const el of document.querySelectorAll('.pf')) el.textContent = config.pFull;
}

// ------------------------------------------------------------------ main loop
let last = performance.now(), statTick = 0, frameNo = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const t0 = performance.now(), dtMs = now - last;
  const dt = Math.min(0.05, dtMs / 1000);
  last = now;
  frameNo++;
  const eng = S.engine;
  if (!eng) {
    // before Start: the preview engine, standing still
    if (S.scene) { S.scene.update(S.scene.model && S.preview ? S.preview.frame : null); S.scene.render(); }
    return;
  }
  // throttle: keys, pedal drag or gamepad set a target; the pedal follows it with a short ramp
  readGamepad();
  let target = heldThrottle();
  if (S.pedalDrag) target = Math.max(target, S.pedalVal || 0);
  target = Math.max(target, S.padThr || 0);
  const tau = target > S.thr ? 0.02 : 0.04;
  S.thr += (target - S.thr) * (1 - Math.exp(-dt / tau));
  if (S.thr < 0.002 && target === 0) S.thr = 0;
  let brake = S.brakeBtn ? 1 : 0;
  for (const k of S.keysDown) if (BRAKE_KEYS.has(k)) brake = 1;
  brake = Math.max(brake, S.padBrake || 0);
  if (S.started) {
    if (Math.abs(S.thr - (S.thrSent || 0)) > 0.002 || (S.thr === 0 && S.thrSent !== 0)) { eng.setThrottle(S.thr); S.thrSent = S.thr; }
    if (brake !== S.brakeSent) { eng.setBrake(brake); S.brakeSent = brake; }
  }
  $('btnBrake').classList.toggle('on', brake > 0.5);

  const h = eng.header;
  const f = eng.frame && h === S.header && eng.frame.length >= h.frame_floats ? eng.frame : null;
  // every other frame only, when the picture is at its lowest step or the audio thread is short of time
  const skip = (PIC.half || (S.lastLoad > 0.85 && eng.level === 'light')) && (frameNo & 1);
  if (!skip) {
    S.scene.update(f);
    S.scene.render();
  }
  if (f) {
    const rpm = f[2], torque = f[4], gear = f[5], speed = f[6], cut = f[7] > 0.5;
    S.rpm += (rpm - S.rpm) * (1 - Math.exp(-dt / 0.03));
    S.torque += (torque - S.torque) * (1 - Math.exp(-dt / 0.22));
    const kw = Math.max(0, S.torque * S.rpm * Math.PI / 30 / 1000);
    drawTach(S.rpm, gear, speed, cut);
    $('rTorque').textContent = Math.round(S.torque);
    $('rPower').textContent = Math.round(kw);
    $('rHp').textContent = Math.round(kw * 1.341);
    $('cut').style.visibility = cut ? 'visible' : 'hidden';
    const sw = h.spec.cam_switch_rpm || 0;
    if (sw > 0) {
      // the simulator switches cylinder by cylinder at the next firing TDC; this lamp follows engine speed with the same hysteresis
      if (rpm >= sw) S.camHigh = true; else if (rpm < sw - (h.spec.cam_switch_hyst || 300)) S.camHigh = false;
      $('cam').classList.toggle('on', !!S.camHigh);
    }
    const co = h.cyl_offset;
    for (let k = 0; k < S.lamps.length; k++) {
      // hold each flash briefly so a single frame of combustion is still seen
      const lit = S.lampHold[k] = Math.max(Math.min(1, f[co + 6 * k + 4] / 1.5), (S.lampHold[k] || 0) * Math.exp(-dt / 0.09));
      S.lamps[k].style.background = lit > 0.03 ? `rgba(255,${Math.round(150 + 90 * lit)},${Math.round(60 + 150 * lit)},${lit.toFixed(2)})` : 'transparent';
      S.lamps[k].style.boxShadow = lit > 0.05 ? `0 0 ${Math.round(14 * lit)}px rgba(255,160,60,${(0.9 * lit).toFixed(2)})` : 'none';
    }
    const shown = clamp(S.mock ? f[3] : S.thr, 0, 1);
    // the number row lights left to right with the throttle: key n is full at n x 10%. The row
    // follows the real position through a short lag, so a stab of full throttle is seen to build.
    const row = S.rowShown = (S.rowShown || 0) + (shown - (S.rowShown || 0)) * (1 - Math.exp(-dt / (shown > (S.rowShown || 0) ? 0.07 : 0.1)));
    const q = Math.round(row * 200) / 200;
    if (q !== S.rowDrawn) {
      S.rowDrawn = q;
      NUM_CAPS.forEach((c, i) => { const f = clamp(q * 10 - i, 0, 1); c.style.setProperty('--f', f.toFixed(2)); c.classList.toggle('lit', f > 0.55); });
      $('pedal').setAttribute('aria-valuenow', String(Math.round(100 * shown)));
    }
    // gear readout between Q and E: a small tick each time it changes
    const g = S.mode === 'drive' && gear > 0 ? String(Math.round(gear)) : 'N';
    if (g !== S.gearShown) {
      S.gearShown = g;
      $('gear').textContent = g;
      $('gear').classList.add('tick');
    }
    // a brief emphasis on the tachometer each time the limiter bites
    const limiter = cut && S.thr > 0.5;
    if (limiter && !S.wasLimiter && now - (S.kickAt || 0) > 260) { S.kickAt = now; $('tach').classList.add('kick'); }
    S.wasLimiter = limiter;
    try { FR.tick(dt, { thr: S.thr, mode: S.mode, gear, cut, auto: S.auto, speed, brake }); } catch (e) { if (!S.frErr) { S.frErr = true; console.error(e); } }   // teaching must never stop the instruments
  } else {
    drawTach(S.rpm, 0, 0, false);
  }
  drawAudio();
  statTick += dt;
  if (statTick > 0.4) {
    statTick = 0;
    const st = eng.stats || {};
    $('loadval').textContent = S.mock ? 'replay' : `${Math.round(100 * (st.load || 0))}%`;
    const lat = S.ctx ? Math.round(((S.ctx.baseLatency || 0) + (S.ctx.outputLatency || 0)) * 1000) : 0;
    $('quality').textContent = S.mock ? '' : `${st.quality || ''}${lat ? ' · ' + lat + ' ms out' : ''}`;
    $('loadval').style.color = (st.load || 0) > 0.9 ? '#ff8a6a' : '';
  }
  PIC.sample(dtMs, performance.now() - t0);
}

// for tests: switch engines the way the interface does, and read the load predictions
S.pick = (name, overrides) => pickEngine(name, overrides);
S.predict = predictLoad;
S.cost = costOf;

initControls();
initWorkshop();
initLegend();
// Anything that goes wrong while loading is said plainly, with a way out: the message above the key
// and the key itself reloading the page. (On a development server without cache control, a tab can
// mix old and new script files after an update, which fails here; a reload fetches matching files.)
boot().catch((e) => loadFailed('The page could not finish loading', e));

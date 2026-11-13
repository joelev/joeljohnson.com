// Engine Synthesizer: the playable page. Wires the engine (real WebAssembly simulator, or the
// replay mock with ?mock=1) to the 3D scene, the instruments and the controls.
//
// URL parameters: mock=1 (replay recorded telemetry), engine=<preset name>, view=<camera>,
// quality=auto|light|heavy, orbit=0 (no idle auto-orbit), ui=0 (hide the key hints).

import { LiveScene } from './scene.js?v=4a24fb3a02';
import { pressureColor, config } from './engine-model.js?v=4a24fb3a02';

const Q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const showError = (e) => { $('err').textContent = String((e && e.stack) || e); console.error(e); };

const S = {
  engine: null, scene: null, ctx: null, analyser: null, presets: [], name: null,
  started: false, mock: false, mode: 'free', auto: true,
  thrTarget: 0, thr: 0, brake: 0, keysDown: new Set(), pedalDrag: false, padThr: 0,
  rpm: 0, torque: 0, power: 0, lamps: [], lampHold: [], tachMax: 8000, ws: null, busy: false,
};
window.__app = S;

// ------------------------------------------------------------------ engine + audio
async function boot() {
  S.scene = new LiveScene($('gl'), { view: Q.get('view') || undefined, idleOrbit: Q.get('orbit') !== '0', preserve: Q.get('preserve') === '1', maxPixelRatio: +Q.get('dpr') || 2 });
  let mod;
  S.mock = Q.get('mock') === '1';
  if (!S.mock) {
    try { mod = await import('./engine.js?v=4a24fb3a02'); } catch (e) {
      S.mock = true;
      banner('Live engine not available here: replaying a recording instead.');
    }
  }
  if (S.mock) mod = await import('./mock-engine.js?v=4a24fb3a02');
  const LiveEngine = mod.LiveEngine;
  S.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 0 }); // 0 = the shortest output buffer the device allows
  S.presets = await LiveEngine.presets();
  const want = Q.get('engine');
  S.name = S.presets.some((p) => p.name === want) ? want : (S.presets.find((p) => p.name === 'v8_cross') || S.presets[0]).name;
  buildPicker();
  S.engine = await LiveEngine.create(S.ctx, { engine: S.name, overrides: {}, quality: Q.get('quality') || 'auto' });
  const master = S.ctx.createGain();
  master.gain.value = 0.8;
  S.analyser = S.ctx.createAnalyser();
  S.analyser.fftSize = 4096;
  S.analyser.smoothingTimeConstant = 0.55;
  S.engine.output.connect(master);
  master.connect(S.ctx.destination);
  master.connect(S.analyser);
  S.engine.addEventListener('rebuild', onRebuild);
  onRebuild();
  if (S.mock) {
    $('wsnote').textContent = 'This is a replay of a recording, so the workshop and the throttle are inactive. Open the page without ?mock=1 for the live engine.';
    for (const el of document.querySelectorAll('#workshop input, #workshop button')) el.disabled = true;
  }
  const b = $('btnStart');
  b.disabled = false;
  b.textContent = 'Start engine';
  requestAnimationFrame(loop);
}

function banner(text) {
  $('banner').textContent = text;
  $('banner').hidden = !text;
  if (text) setTimeout(() => { $('banner').hidden = true; }, 6000);
}

function onRebuild() {
  const h = S.engine.header;
  if (!h) return;
  const sp = h.spec, n = sp.firing.length;
  S.scene.setHeader(h);
  S.header = h;
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
  $('cam').hidden = !(sp.cam_switch_rpm > 0);
  S.camHigh = false;
  if (BR.open) renderDetail(S.presets.find((q) => q.name === BR.active));
  syncWorkshop();
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
function unlockAudio() {
  // everything here must run inside the tap/click/key handler, before any await
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))) {
    try {
      if (!S.keepAlive) { S.keepAlive = new Audio(silentWav()); S.keepAlive.loop = true; S.keepAlive.setAttribute('playsinline', ''); }
      S.keepAlive.play().catch(() => {});
    } catch (e) { /* ignore */ }
  }
  try { const src = S.ctx.createBufferSource(); src.buffer = S.ctx.createBuffer(1, 1, S.ctx.sampleRate); src.connect(S.ctx.destination); src.start(0); } catch (e) { /* ignore */ }
  return S.ctx.resume();
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
  return `audio ${S.ctx ? S.ctx.state : 'none'} @ ${S.ctx ? S.ctx.sampleRate : '?'} Hz · session ${navigator.audioSession ? navigator.audioSession.type : 'n/a'} · engine ${e && e.frame ? 'running' : 'no frames'} · load ${Math.round((st.load || 0) * 100)}% ${st.quality || ''} · build ${window.__build || 'dev'}`;
}
async function start() {
  if (S.started) return;
  S.started = true;
  const resumed = unlockAudio();
  // iOS suspends or "interrupts" the context on calls, app switches and screen lock: resume on the next touch
  const again = () => { if (S.ctx && S.ctx.state !== 'running') unlockAudio(); };
  window.addEventListener('pointerdown', again); window.addEventListener('keydown', again);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) again(); });
  await resumed.catch(() => {});
  setTimeout(() => {
    if (S.ctx.state !== 'running') banner('Sound is not running (' + S.ctx.state + '). Tap anywhere to try again.');
  }, 1500);
  // ?debug=1 keeps a live status line on screen (for reading off a phone)
  if (Q.has('debug')) { debugBeep(); setTimeout(debugBeep, 1200); }
  if (Q.has('debug')) setInterval(() => { $('banner').textContent = audioStatus(); $('banner').hidden = false; }, 1000);
  $('start').classList.add('gone');
  setTimeout(() => { $('start').hidden = true; }, 600);
}

// ------------------------------------------------------------------ engine library
// A browser for however many engines the simulator carries: grouped by family, searchable,
// with a details pane (sourced facts, what is estimated, links). Nothing here is a fixed list;
// families and counts come from the presets.
const FAMILY_RANK = { single: 1, twin: 2, triple: 3, three: 3, 'inline-four': 4, four: 4, five: 5, 'inline-five': 5, six: 6, 'inline-six': 6, v6: 6.5, eight: 8, 'inline-eight': 8, 'straight-eight': 8, v8: 8.5, v10: 10, v12: 12, w: 12.6, w8: 8.7, w12: 12.6, v16: 16, w16: 16.5, flat: 50, boxer: 50, rotary: 60, wankel: 60, radial: 70 };
const FAMILY_TITLE = { single: 'Singles', twin: 'Twins', triple: 'Triples', three: 'Triples', 'inline-four': 'Inline-fours', four: 'Fours', five: 'Fives', 'inline-five': 'Fives', six: 'Inline-sixes', 'inline-six': 'Inline-sixes', eight: 'Straight-eights', flat: 'Flat', boxer: 'Flat', rotary: 'Rotary', wankel: 'Rotary', radial: 'Radial', w: 'W' };
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
    if (members.every((m) => m.spec.layout === lay)) { if (lay === 'flat') return 50; if (isRotary(members[0].spec)) return 60; if (lay === 'radial') return 70; }
    return Math.min(...members.map((m) => unitsOf(m.spec))) + 0.9;      // unknown family: by cylinder count
  };
  return [...groups.entries()].map(([k, members]) => ({ key: k, title: FAMILY_TITLE[k.toLowerCase()] || (k.length <= 3 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)), members, rank: rank(k, members) }))
    .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
}
function haystack(p) {
  const sp = p.spec, n = unitsOf(sp);
  return [p.label, p.name, sp.family, sp.based_on, layoutWord(sp), describeLayout(sp), `${n} cylinder ${n}cyl ${n}-cyl`, sp.layout === 'v' ? `v${n}` : '', sp.layout === 'inline' ? `i${n} l${n} straight` : '', sp.layout === 'flat' ? 'boxer' : '', isRotary(sp) ? 'wankel rotor' : '', sp.generic === false ? 'real' : 'generic invented', sp.itb ? 'individual throttles itb' : '', sp.cam_switch_rpm > 0 ? 'cam switching vtec' : '']
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
      const info = el('span', 'info', 'i');
      info.setAttribute('role', 'button');
      info.setAttribute('aria-label', `Details for ${p.label}`);
      info.onclick = (e) => { e.stopPropagation(); setActive(p.name, false); $('browser').classList.add('detail'); };
      side.appendChild(info);
      b.append(n, t, side);
      b.classList.toggle('on', p.name === S.name);
      b.onclick = () => { setActive(p.name, false); pickEngine(p.name).then(() => { if (isPhone()) closeBrowser(); }); };
      b.onmouseenter = () => { if (!isPhone()) setActive(p.name, false); };
      b.onfocus = () => setActive(p.name, false);
      grid.appendChild(b);
      BR.shown.push(p.name);
    }
    box.append(h, grid);
  }
  if (!list.length) box.appendChild(el('p', 'hint', 'No engine matches that search.'));
  $('brCount').textContent = list.length === S.presets.length ? `${list.length} engines` : `${list.length} of ${S.presets.length} engines`;
  if (!BR.shown.includes(BR.active)) BR.active = BR.shown.includes(S.name) ? S.name : (BR.shown[0] || null);
  setActive(BR.active, false);
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
  const pub = sp.published;
  if (pub && (pub.power_kw || pub.torque_nm)) {
    box.appendChild(el('h4', '', 'Published figures'));
    const d2 = el('dl');
    if (pub.power_kw) d2.append(el('dt', '', 'Power'), el('dd', '', `${Math.round(pub.power_kw)} kW (${Math.round(pub.power_kw * 1.341)} hp)${pub.power_rpm ? ` at ${Math.round(pub.power_rpm)}` : ''}`));
    if (pub.torque_nm) d2.append(el('dt', '', 'Torque'), el('dd', '', `${Math.round(pub.torque_nm)} N·m${pub.torque_rpm ? ` at ${Math.round(pub.torque_rpm)}` : ''}`));
    box.appendChild(d2);
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
  $('btnEngines').setAttribute('aria-expanded', 'true');
  $('workshop').classList.remove('open');
  $('btnWorkshop').setAttribute('aria-expanded', 'false');
  BR.active = S.name;
  renderList();
  setActive(BR.shown.includes(S.name) ? S.name : BR.shown[0], true);
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) $('brSearch').focus();   // no on-screen keyboard popping up on touch
}
function closeBrowser() {
  BR.open = false;
  $('browser').hidden = true;
  $('brScrim').hidden = true;
  $('btnEngines').setAttribute('aria-expanded', 'false');
  if (document.activeElement && $('browser').contains(document.activeElement)) document.activeElement.blur();
}
/** Keys that belong to the library. Returns true when the engine controls must not see the key. */
function browserKey(e) {
  if (!BR.open) {
    if (e.key === '/' && !(e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) && S.presets.length) { e.preventDefault(); openBrowser(); return true; }
    return false;
  }
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
  return true;
}

async function pickEngine(name, overrides = {}) {
  if (S.busy) return;
  S.busy = true;
  try {
    if (name !== S.name) S.wsValues = null;
    S.name = name;
    await S.engine.setEngine(name, overrides);
  } catch (e) { showError(e); }
  S.busy = false;
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
  const mean = base.primary_len.reduce((a, b) => a + b, 0) / base.primary_len.length;
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
  $('wsReset').onclick = () => { S.wsValues = null; syncWorkshop(); pickEngine(S.name, {}); };
  for (const b of document.querySelectorAll('[data-crank]')) b.onclick = () => { if (b.dataset.crank !== S.name) pickEngine(b.dataset.crank); };
}

// ------------------------------------------------------------------ controls
const THR_KEYS = new Set(['Space', 'KeyW', 'ArrowUp']);
const BRAKE_KEYS = new Set(['KeyS', 'ArrowDown', 'KeyB']);
function setMode(m) {
  S.mode = m;
  S.engine.setMode(m);
  $('btnMode').textContent = m === 'drive' ? 'Drive' : 'Neutral';
  $('btnMode').classList.toggle('on', m === 'drive');
}
function initControls() {
  window.addEventListener('keydown', (e) => {
    if (browserKey(e)) return;
    if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    if (THR_KEYS.has(e.code) || BRAKE_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    if (!S.started && (e.code === 'Space' || e.code === 'Enter') && !$('btnStart').disabled) { start(); return; }
    S.keysDown.add(e.code);
    // answer a throttle key at once (do not wait for the next animation frame or the pedal ramp)
    if (THR_KEYS.has(e.code) && S.started && S.engine) { S.thr = Math.max(S.thr, 0.9); S.engine.setThrottle(S.thr); S.thrSent = S.thr; }
    if (e.code === 'KeyD') setMode(S.mode === 'drive' ? 'free' : 'drive');
    if (e.code === 'KeyE' || e.code === 'BracketRight') S.engine.shift(1);
    if (e.code === 'KeyQ' || e.code === 'BracketLeft') S.engine.shift(-1);
    if (e.code === 'KeyA') toggleAuto();
    if (e.code === 'Escape') $('note').hidden = true;
  });
  window.addEventListener('keyup', (e) => {
    S.keysDown.delete(e.code);
    if (THR_KEYS.has(e.code) && S.started && S.engine && ![...S.keysDown].some(k => THR_KEYS.has(k)) && !S.pedalDrag) {
      S.thr = Math.min(S.thr, 0.08); S.engine.setThrottle(S.thr); S.thrSent = S.thr;
    }
  });
  window.addEventListener('blur', () => { S.keysDown.clear(); S.pedalDrag = false; });
  const pedal = $('pedal');
  const fromPointer = (e) => { const r = pedal.getBoundingClientRect(); return clamp(1 - (e.clientY - r.top) / r.height, 0, 1); };
  pedal.addEventListener('pointerdown', (e) => { try { pedal.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ } S.pedalDrag = true; S.pedalVal = fromPointer(e) < 0.06 ? 0 : fromPointer(e); e.preventDefault(); });
  pedal.addEventListener('pointermove', (e) => { if (S.pedalDrag) S.pedalVal = fromPointer(e); });
  const up = () => { S.pedalDrag = false; };
  pedal.addEventListener('pointerup', up);
  pedal.addEventListener('pointercancel', up);
  $('btnMode').onclick = () => setMode(S.mode === 'drive' ? 'free' : 'drive');
  $('btnAuto').onclick = toggleAuto;
  $('btnUp').onclick = () => S.engine.shift(1);
  $('btnDown').onclick = () => S.engine.shift(-1);
  const br = $('btnBrake');
  br.addEventListener('pointerdown', (e) => { try { br.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ } S.brakeBtn = true; });
  br.addEventListener('pointerup', () => { S.brakeBtn = false; });
  br.addEventListener('pointercancel', () => { S.brakeBtn = false; });
  $('btnStart').onclick = start;
  $('btnInfo').onclick = () => { $('note').hidden = false; };
  $('noteClose').onclick = () => { $('note').hidden = true; };
  $('note').addEventListener('click', (e) => { if (e.target === $('note')) $('note').hidden = true; });
  for (const b of document.querySelectorAll('#views button')) b.onclick = () => {
    S.scene.setView(b.dataset.view);
    for (const o of document.querySelectorAll('#views button')) o.classList.toggle('on', o === b);
  };
  const toggle = (btn, panel) => () => { const open = !panel.classList.contains('open'); panel.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open)); };
  $('btnWorkshop').onclick = () => { if (BR.open) closeBrowser(); toggle($('btnWorkshop'), $('workshop'))(); };
  if (Q.get('ui') === '0') $('keys').hidden = true;
}
function toggleAuto() {
  S.auto = !S.auto;
  S.engine.setAutoShift(S.auto);
  $('btnAuto').classList.toggle('on', S.auto);
}
function readGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  S.padThr = 0; S.padBrake = 0;
  for (const p of pads) {
    if (!p || !p.buttons || p.buttons.length < 8) continue;
    S.padThr = Math.max(S.padThr, p.buttons[7].value);
    S.padBrake = Math.max(S.padBrake, p.buttons[6].value);
    const upNow = p.buttons[5].pressed, dnNow = p.buttons[4].pressed;
    if (upNow && !S.padUp) S.engine.shift(1);
    if (dnNow && !S.padDn) S.engine.shift(-1);
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
const spec = $('spec'), pctx = spec.getContext('2d');
let timeBuf = null, freqBuf = null, specCol = null, specMap = null;
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
  if (!timeBuf) { timeBuf = new Float32Array(an.fftSize); freqBuf = new Uint8Array(an.frequencyBinCount); }
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
  // spectrogram: log frequency, 30 Hz to 12 kHz, newest column on the right
  an.getByteFrequencyData(freqBuf);
  const PW = spec.width, PH = spec.height;
  if (!specCol) {
    specCol = pctx.createImageData(2, PH);
    specMap = new Float32Array(PH);
    const binHz = S.ctx.sampleRate / an.fftSize;
    for (let y = 0; y < PH; y++) specMap[y] = 30 * Math.pow(12000 / 30, 1 - y / (PH - 1)) / binHz;
    pctx.fillStyle = '#04050a'; pctx.fillRect(0, 0, PW, PH);
  }
  pctx.drawImage(spec, -2, 0);
  const d = specCol.data;
  for (let y = 0; y < PH; y++) {
    const b = specMap[y], i0 = Math.floor(b), f = b - i0;
    const v = Math.round((freqBuf[i0] || 0) * (1 - f) + (freqBuf[i0 + 1] || 0) * f);
    for (let x = 0; x < 2; x++) { const q = (y * 2 + x) * 4; d[q] = LUT[3 * v]; d[q + 1] = LUT[3 * v + 1]; d[q + 2] = LUT[3 * v + 2]; d[q + 3] = 255; }
  }
  pctx.putImageData(specCol, PW - 2, 0);
}
function initLegend() {
  const css = (c) => `rgb(${c.map((v) => Math.round(255 * Math.pow(Math.min(1, v / (1 + 0.25 * v)), 1 / 2.2))).join(',')})`;
  const stops = [];
  for (let k = 0; k <= 20; k++) { const c = [0, 0, 0]; pressureColor((k / 10 - 1) * config.pFull, c, 0); stops.push(`${css(c)} ${k * 5}%`); }
  $('legendbar').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
  for (const el of document.querySelectorAll('.pf')) el.textContent = config.pFull;
}

// ------------------------------------------------------------------ main loop
let last = performance.now(), statTick = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const eng = S.engine;
  if (!eng) return;
  // throttle: keys, pedal drag or gamepad set a target; the pedal follows it with a short ramp
  readGamepad();
  let target = 0;
  for (const k of S.keysDown) if (THR_KEYS.has(k)) target = 1;
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
  S.scene.update(f);
  S.scene.render();
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
    const shown = S.mock ? f[3] : S.thr;
    $('pedalfill').style.height = `${Math.round(100 * clamp(shown, 0, 1))}%`;
    $('pedal').setAttribute('aria-valuenow', String(Math.round(100 * shown)));
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
}

initControls();
initWorkshop();
initLegend();
boot().catch((e) => { showError(e); $('btnStart').textContent = 'Could not start'; });

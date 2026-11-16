// The 3D scene of the live app. Builds an EngineModel from the engine's header, redraws it
// from the newest telemetry frame every animation frame, and adds the things a live page can
// afford: a reflective floor, orbit camera with presets, hot headers, tailpipe plumes,
// overrun flames and a little camera shake.
//
// Simulated and drawn from data: crank/piston/valve motion, gas pressure colour in every pipe
// and volume, header glow (gas temperature in the exhaust pipes), cylinder glow (cylinder
// pressure, burn rate, temperature), plume speed (gas velocity at the open exhaust end),
// the sound picture on the floor (pulses that follow engine speed and each opening's simulated
// loudness, lit by a spectrogram of the sound being played; viz/wave-studies.js).
// Decorative: overrun flames (triggered by the fuel-cut flag; afterfire is not simulated),
// camera shake, floor reflection, vignette, bloom.
//
// Picture quality steps down on slow hardware (setPixelRatio, setReflection, setBloom; the page
// decides when). opts.reducedMotion (or setReducedMotion) turns off camera shake, the idle
// auto-orbit and animated camera moves.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { EngineModel, config } from './engine-model.js?v=7a5737f0f1';
import { SoundFloor } from './wave-studies.js?v=7a5737f0f1';

/** Warm-up: an overall factor on the engine's and pipes' glow, so an idling engine looks restrained
 *  and a hard-run one blazes. Not a simulation of heat: a smoothed state that rises with engine
 *  speed and with time on the throttle, and falls slowly off it. */
export const warmupConfig = {
  low: 0.5,            // glow factor of a cold engine (1 when fully worked)
  rpmShare: 0.6,       // the state heads for rpmShare x (engine speed, idle 0 to redline 1)
  throttleShare: 0.6,  //   + throttleShare x throttle, capped at 1
  attack: 3.0,         // seconds to rise most of the way
  release: 9.0,        // seconds to fall most of the way
};

/** The opening screen (before the sound starts): the floor's lattice spreads from the point under
 *  the space-bar key as the page loads; when ready a slow ripple leaves that point about once a
 *  second and the dark engine lifts a little as it passes under; on the press one big swell
 *  leaves it and the lights come up behind its front. Lengths in metres, times in seconds. */
export const introConfig = {
  dots: 0.55,            // brightness of the lattice before the start, as a share of its running brightness
  spread: 9,             // the lattice has spread this far from the key when loading is done
  spreadSpeed: 7,        // and never spreads faster than this
  beat: 5.75,            // one slow swell leaves the key every this long, and takes all of that time to cross (Joel, 2026-11-15: five times slower, "subtle and classy. Smooth.")
  beatHeight: 0.042, beatWidth: 0.42,
  beatPast: 0.9,         // a heartbeat fades out this far past the engine
  lift: 0.07,            // how much the dark engine brightens as a heartbeat passes under it (lit units, 0..1)
  swellSpeed: 3.4, swellHeight: 0.14, swellWidth: 0.5,   // the start swell
  swellReach: 11,        // it is over when its front has gone this far
  lightsAt: -0.9,        // the lights start to come up when the front is this far from the engine (negative: before it)
};

const V3 = THREE.Vector3;
const RAD = Math.PI / 180;
const MAX_PART = 900;

const FLOOR_VERT = `
varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const FLOOR_FRAG = `
varying vec3 vW; uniform vec3 uCenter; uniform float uGrid;
float gridLine(vec2 p, float s) { vec2 g = abs(fract(p / s - 0.5) - 0.5) / fwidth(p / s); return 1.0 - min(min(g.x, g.y), 1.0); }
void main() {
  float d = distance(vW.xz, uCenter.xz);
  // a dark veil over the mirror: clearest under the engine, opaque far away
  float veil = mix(0.80, 1.0, smoothstep(0.3, 3.5, d));
  float g = max(gridLine(vW.xz, 0.1) * 0.25, gridLine(vW.xz, 1.0) * 0.6) * (1.0 - smoothstep(1.0, 6.0, d)) * uGrid;
  vec3 col = vec3(0.012, 0.014, 0.02) + vec3(0.10, 0.13, 0.19) * g;
  gl_FragColor = vec4(col, max(veil, g * 0.8));
}`;

const PART_VERT = `
attribute float aSize; attribute vec4 aColor;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (700.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const PART_FRAG = `
varying vec4 vColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.0, r);
  gl_FragColor = vec4(vColor.rgb * vColor.a * a * a, 1.0);
}`;

export class LiveScene {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: !!opts.preserve, powerPreference: 'high-performance' });
    this.pixelRatio = Math.min(opts.maxPixelRatio || 2, window.devicePixelRatio || 1);
    renderer.setPixelRatio(this.pixelRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // lit: 1 is the normal picture, 0 the dark engine shown before the sound starts (setLit eases between)
    this.lit = this.litTarget = opts.lit === false ? 0 : 1;
    renderer.toneMappingExposure = this.exposure();
    // the opening screen's state (introConfig); null once the engine is lit
    this.intro = opts.lit === false ? { phase: 'loading', p: 0, reveal: 0, t: 0, lift: 0, key: new V3(), ndc: new THREE.Vector2(0, -0.85), ripple: [0, 1, 0], gain: [1, 1], front: false } : null;
    this.ray = new THREE.Raycaster();
    this.renderer = renderer;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x04050a);
    scene.fog = new THREE.Fog(0x04050a, 6, 22);
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.5;
    pm.dispose();
    const key = new THREE.DirectionalLight(0xfff1e0, 1.25);
    key.position.set(-1.6, 2.6, 2.4);
    const rim = new THREE.DirectionalLight(0x8fb6ff, 1.9);
    rim.position.set(2.5, 1.4, -2.6);
    const fill = new THREE.DirectionalLight(0xffffff, 0.25);
    fill.position.set(-2, -0.5, -1);
    scene.add(key, rim, fill);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.03, 80);
    this.camera.layers.enable(1);
    this.camera.position.set(-2, 1, 2);
    const controls = new OrbitControls(this.camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.7;
    controls.zoomSpeed = 0.8;
    controls.autoRotateSpeed = 0.45;
    controls.maxPolarAngle = 88 * RAD;
    controls.addEventListener('start', () => { this.lastInput = performance.now(); controls.autoRotate = false; this.fly = null; this.attract = false; });
    this.controls = controls;
    this.lastInput = performance.now();
    this.idleOrbit = opts.idleOrbit !== false;
    this.reducedMotion = !!opts.reducedMotion;
    this.bloomOn = true;
    this.reflectionOn = true;

    // floor: a mirror with a dark veil and grid on top (the veil lives on layer 1, which the
    // mirror's own camera does not see)
    const refl = new Reflector(new THREE.CircleGeometry(9, 48), { textureWidth: 1024, textureHeight: 1024, color: 0x8a8f9a, clipBias: 0.002 });
    refl.rotation.x = -Math.PI / 2;
    this.reflector = refl;
    scene.add(refl);
    this.floorMat = new THREE.ShaderMaterial({ vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG, transparent: true, depthWrite: false, uniforms: { uCenter: { value: new V3() }, uGrid: { value: 1 } } });
    const veil = new THREE.Mesh(new THREE.CircleGeometry(9, 48), this.floorMat);
    veil.rotation.x = -Math.PI / 2;
    veil.layers.set(1);
    veil.renderOrder = -1;
    this.veil = veil;
    scene.add(veil);

    // particles: tailpipe plume and overrun flames share one buffer
    const pg = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PART * 3);
    this.pCol = new Float32Array(MAX_PART * 4);
    this.pSize = new Float32Array(MAX_PART);
    this.pVel = new Float32Array(MAX_PART * 3);
    this.pAge = new Float32Array(MAX_PART).fill(1e9);
    this.pLife = new Float32Array(MAX_PART).fill(1);
    this.pKind = new Uint8Array(MAX_PART);
    this.pNext = 0;
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aColor', new THREE.BufferAttribute(this.pCol, 4).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage));
    const pmat = new THREE.ShaderMaterial({ vertexShader: PART_VERT, fragmentShader: PART_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.points = new THREE.Points(pg, pmat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
    this.emitAcc = [];
    this.popTimer = 0;

    const composer = new EffectComposer(renderer);
    composer.setPixelRatio(this.pixelRatio);
    composer.addPass(new RenderPass(scene, this.camera));
    this.wavesOn = true;
    this.warm = 0;       // warm-up state, 0 cold to 1 fully worked
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1280, 720), 0.36, 0.55, 1.5);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    this.composer = composer;

    this.model = null;
    this.shake = new V3();
    this.clock = performance.now();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.viewW = w; this.viewH = h;
    this.applyShift();
    if (this.model) this.computeViews();
  }
  /** Draw the picture moved `px` CSS pixels to the right (eased), so the engine sits in the middle
   *  of what a drawer on the left leaves free. The camera does not move; its lens is shifted. */
  setShift(px) { this.shiftTarget = px || 0; if (this.reducedMotion) { this.shift = this.shiftTarget; this.applyShift(); } }
  applyShift() {
    const s = this.shift || 0;
    if (Math.abs(s) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(this.viewW, this.viewH, -s, 0, this.viewW, this.viewH);
    this.camera.updateProjectionMatrix();
  }

  /** Render at this many device pixels per CSS pixel (capped at the screen's own). */
  setPixelRatio(r) {
    this.pixelRatio = Math.max(0.5, Math.min(r, window.devicePixelRatio || 1));
    this.renderer.setPixelRatio(this.pixelRatio);
    this.composer.setPixelRatio(this.pixelRatio);
    this.resize();
  }
  /** Mirror floor on or off (off: the dark veil and grid stay, nothing is reflected). */
  setReflection(on) { this.reflectionOn = !!on; this.reflector.visible = this.reflectionOn; }
  /** Bloom on or off (off: the scene pass and the output pass still run, so colours do not change). */
  setBloom(on) { this.bloomOn = !!on; this.bloom.enabled = this.bloomOn; }
  setReducedMotion(on) {
    this.reducedMotion = !!on;
    if (on) { this.controls.autoRotate = false; this.shake.set(0, 0, 0); }
  }

  exposure(lit = this.lit) { return 0.13 + 0.87 * Math.min(1, lit); }
  /** Lights up (true) or down (false), eased over about half a second unless instant. */
  setLit(on, instant = false) {
    this.litTarget = on ? 1 : 0;
    if (instant) { this.lit = this.litTarget; this.renderer.toneMappingExposure = this.exposure(); }
  }
  /** Opening screen: where the space-bar key is on screen (normalised device coordinates), so the floor's ripples start under it. */
  setKeyPoint(x, y) { if (this.intro) this.intro.ndc.set(x, y); }
  /** Opening screen: loading progress 0..1 (the lattice spreads with it). */
  setLoadProgress(p) { if (this.intro) this.intro.p = Math.max(this.intro.p, p); }
  /** Opening screen: loaded; the heartbeat begins. */
  setReady() { if (this.intro && this.intro.phase === 'loading') { this.intro.phase = 'ready'; this.intro.t = 0; } }
  /** The press: one swell from the key, and the lights come up behind it. With reduced motion (or
   *  no opening screen) the lights simply fade up. */
  ignite() {
    const I = this.intro;
    if (!I || this.reducedMotion || !this.model) { this.intro = null; this.setLit(true); return; }
    this.updateKey();
    I.phase = 'bloom'; I.t = 0; I.frozen = true;
  }
  /** The point on the floor under the space-bar key, and how far the engine is from it. */
  updateKey() {
    const I = this.intro, y = this.reflector.position.y;
    this.camera.updateMatrixWorld();
    this.ray.setFromCamera(I.ndc, this.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    const t = d.y < -1e-3 ? Math.min(9, (y - o.y) / d.y) : 3;
    I.key.set(o.x + d.x * t, y, o.z + d.z * t);
    const c = this.model.boxEng.getCenter(this._c || (this._c = new V3()));
    I.dEng = Math.hypot(c.x - I.key.x, c.z - I.key.z);
  }
  /** Advance the opening screen by dt; sets the lights and what the floor needs (I.reveal, I.ripple, I.gain). */
  updateIntro(dt) {
    const I = this.intro, c = introConfig;
    if (!I.frozen) this.updateKey();
    I.t += dt;
    I.lift = 0; I.ripple[2] = 0; I.front = false;
    if (this.reducedMotion) I.reveal = 1e6;
    else I.reveal = Math.min(I.reveal + c.spreadSpeed * dt, c.spread * Math.max(0, (I.p - 0.3) / 0.7), 1e6);
    if (I.phase === 'bloom') {
      const r = c.swellSpeed * I.t;
      I.reveal = 1e6;
      I.ripple[0] = r; I.ripple[1] = c.swellWidth * (1 + 0.1 * r); I.ripple[2] = c.swellHeight * (1 - Math.min(1, r / c.swellReach)) * Math.min(1, r / 0.5);
      I.front = true;
      if (r >= I.dEng + c.lightsAt) this.litTarget = 1;
      if (r >= c.swellReach && this.lit >= 1) { this.intro = null; return; }
    } else if (I.phase === 'ready' && !this.reducedMotion && I.reveal >= c.spread * 0.6) {
      // one ripple at a time: it leaves the key, passes under the engine and fades just beyond it
      I.beatT = (I.beatT ?? 0) + dt;
      if (I.beatT >= c.beat) I.beatT -= c.beat;
      const u = I.beatT / c.beat, reach = I.dEng + c.beatPast, r = u * reach;
      const env = Math.sin(Math.PI * u) ** 2;   // rises from nothing and sinks to nothing: no visible start or stop
      I.ripple[0] = r; I.ripple[1] = c.beatWidth * (1 + 0.15 * r); I.ripple[2] = c.beatHeight * env;
      const x = (r - I.dEng) / 0.6;
      I.lift = c.lift * Math.exp(-x * x);
    }
    // the floor keeps its own brightness while the picture's exposure is low: ahead of the swell's
    // front the dim opening level, behind it the running level
    const k = this.exposure(1) / this.exposure(this.lit + I.lift);
    const dim = c.dots + (1 - c.dots) * this.lit;
    I.gain[0] = dim * k; I.gain[1] = I.phase === 'bloom' ? k : dim * k;
  }
  /** Attract mode: orbit slowly without waiting for idle time (the screen before the engine starts). */
  setAttract(on) {
    this.attract = !!on;
    this.controls.autoRotateSpeed = on ? 0.8 : 0.45;
    if (!on) { this.controls.autoRotate = false; this.lastInput = performance.now(); }
  }

  /** Remove the engine from the picture (floor and camera stay). */
  clear() {
    if (this.model) this.model.dispose();
    this.model = null;
  }

  /** Replace the engine. Disposes the old model's GPU resources. Throws if this kind of engine cannot be drawn. */
  setHeader(header) {
    const first = !this.model && !this.hadModel;
    this.clear();
    this.hadModel = true;
    config.pFull = 0.7;
    this.model = new EngineModel(header, { heat: true, lightGain: 0.22, lightRange: 0.9 });
    this.scene.add(this.model.root);
    const y = this.model.boxAll.min.y - 0.07;
    this.reflector.position.y = y;
    this.veil.position.y = y + 0.002;
    this.buildWaves(y);
    this.controls.minDistance = 0.35;
    this.controls.maxDistance = 9;
    this.emitAcc = this.model.outlets.map(() => 0);
    this.pAge.fill(1e9);
    this.computeViews();
    // a rotary is best seen end-on; switching between kinds moves to that kind's natural view
    const kindNow = this.model.L.radial ? 'radial' : this.model.kind;
    const kindChanged = this.lastKind !== kindNow;
    this.lastKind = kindNow;
    const natural = this.model.kind === 'wankel' || this.model.L.radial ? 'front' : 'engine';
    if (first) this.setView(this.opts.view || natural, true);
    else this.setView(kindChanged ? natural : (this.viewName || natural), false);
  }

  /** The sound picture on the floor (viz/wave-studies.js), rebuilt with each engine. On layer 1
   *  like the floor veil, so the mirror does not draw it a second time. */
  buildWaves(floorY) {
    if (this.floor) this.floor.dispose();
    this.floor = new SoundFloor(this.model, { floorY, layer: 1 });
    this.floor.spectrum = this.spectrum || null;
    this.scene.add(this.floor.root);
    this.setWaves(this.wavesOn);
  }
  /** The "Sound waves" button: the floor picture on, or the plain grid floor. */
  setWaves(on) {
    this.wavesOn = !!on;
    if (this.floor) this.floor.setVisible(this.wavesOn);
    // the lattice of dots replaces most of the grid
    this.floorMat.uniforms.uGrid.value = this.wavesOn ? 0.25 : 1;
  }
  /** The page's spectrum reader (live/spectro.js SpectroSource), which lights the floor. */
  setSpectrum(source) { this.spectrum = source; if (this.floor) this.floor.spectrum = source; }

  computeViews() {
    const m = this.model, cam = this.camera;
    const boxC = m.boxEng.getCenter(new V3());
    const core = new V3();
    for (const q of m.ptsCore) core.add(q);
    core.multiplyScalar(1 / 8);
    const engLen = m.crank.x1 - m.crank.x0;
    const narrow = cam.aspect < 1;
    const defs = {
      engine: { pts: m.ptsCore, target: core.clone().add(new V3(0.2 * engLen, 0, 0)), az: -40, el: 13, bx: narrow ? 0.8 : 0.5, by: [-0.30, 0.31], lift: narrow ? 0.34 : 0.17 },
      wide: { pts: m.ptsAll, target: m.boxAll.getCenter(new V3()), az: -30, el: 18, bx: 0.8, by: [-0.42, 0.5], lift: 0.2 },
      exhaust: { pts: m.ptsAll, target: m.boxAll.getCenter(new V3()), az: 58, el: 12, bx: 0.8, by: [-0.42, 0.5], lift: 0.2 },
      front: m.kind === 'wankel'
        ? { pts: m.ptsCore, target: core.clone(), az: -84, el: 5, bx: narrow ? 0.7 : 0.44, by: [-0.44, 0.46], lift: narrow ? 0.3 : 0.2 }
        : { pts: m.ptsEng, target: boxC, az: -90, el: 5, bx: 0.72, by: [-0.4, 0.45], lift: 0.22 },
      top: { pts: m.ptsEng, target: boxC, az: -20, el: 62, bx: 0.7, by: [-0.4, 0.45], lift: 0.16 },
    };
    const probe = new THREE.PerspectiveCamera(cam.fov, cam.aspect, 0.03, 80);
    const place = (c, v, d) => {
      const az = v.az * RAD, e = v.el * RAD;
      c.position.set(v.target.x + d * Math.sin(az) * Math.cos(e), v.target.y + d * Math.sin(e), v.target.z + d * Math.cos(az) * Math.cos(e));
      c.lookAt(v.target);
      c.updateMatrixWorld(true);
    };
    for (const k in defs) {
      const v = defs[k];
      let lo = 0.2, hi = 30;
      for (let it = 0; it < 26; it++) {
        const d = 0.5 * (lo + hi);
        place(probe, v, d);
        const ok = v.pts.every((p) => { const q = p.clone().project(probe); return Math.abs(q.x) < v.bx && q.y > v.by[0] && q.y < v.by[1] && q.z < 1; });
        if (ok) hi = d; else lo = d;
      }
      // look a little below the subject so it sits above the dashboard
      v.target = v.target.clone();
      v.target.y -= hi * Math.tan(0.5 * cam.fov * RAD) * (v.lift || 0);
      place(probe, v, hi);
      v.pos = probe.position.clone();
    }
    this.views = defs;
    this.floorMat.uniforms.uCenter.value.copy(boxC);
  }

  setView(name, instant = false) {
    const v = this.views[name];
    if (!v) return;
    this.viewName = name;
    if (instant || this.reducedMotion) {
      this.fly = null;
      this.camera.position.copy(v.pos);
      this.controls.target.copy(v.target);
      this.controls.update();
    } else {
      this.fly = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: v.pos.clone(), t1: v.target.clone(), u: 0 };
    }
    this.lastInput = performance.now();
    this.controls.autoRotate = false;
  }

  spawn(kind, pos, vel, life, size, r, g, b, a) {
    const i = this.pNext;
    this.pNext = (i + 1) % MAX_PART;
    this.pPos[3 * i] = pos.x; this.pPos[3 * i + 1] = pos.y; this.pPos[3 * i + 2] = pos.z;
    this.pVel[3 * i] = vel.x; this.pVel[3 * i + 1] = vel.y; this.pVel[3 * i + 2] = vel.z;
    this.pAge[i] = 0; this.pLife[i] = life; this.pSize[i] = size; this.pKind[i] = kind;
    this.pCol[4 * i] = r; this.pCol[4 * i + 1] = g; this.pCol[4 * i + 2] = b; this.pCol[4 * i + 3] = a;
  }

  /** Advance the scene to the newest frame. `frame` is a Float32Array in the header's layout. */
  update(frame) {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.clock) / 1000);
    this.clock = now;
    if ((this.shiftTarget || 0) !== (this.shift || 0)) {
      this.shift = (this.shift || 0) + (this.shiftTarget - (this.shift || 0)) * (1 - Math.exp(-dt / 0.09));
      if (Math.abs(this.shiftTarget - this.shift) < 1) this.shift = this.shiftTarget;
      this.applyShift();
    }
    const m = this.model;
    if (this.intro && m) this.updateIntro(dt);
    const lift = this.intro ? this.intro.lift : 0;
    if (this.lit !== this.litTarget || lift !== this.liftShown) {
      this.lit += (this.litTarget - this.lit) * (1 - Math.exp(-dt / 0.22));
      if (Math.abs(this.litTarget - this.lit) < 0.004) this.lit = this.litTarget;
      this.liftShown = lift;
      this.renderer.toneMappingExposure = this.exposure(this.lit + lift);
    }
    if (!m) return;
    if (frame) {
      // warm-up: set before the model draws the frame
      const sp = m.sp, w = warmupConfig, idle = Math.min(0.5 * sp.redline, sp.idle || 0.13 * sp.redline);
      const rev = Math.min(1, Math.max(0, (frame[2] - idle) / (sp.redline - idle)));
      const want = Math.min(1, w.rpmShare * rev + w.throttleShare * Math.min(1, Math.max(0, frame[3])));
      this.warm += (want - this.warm) * (1 - Math.exp(-dt / (want > this.warm ? w.attack : w.release)));
      m.glowScale = w.low + (1 - w.low) * this.warm;
      m.update(frame, 0);
      const rpm = frame[2], torque = frame[4], cut = frame[7] > 0.5, red = m.sp.redline;
      const tmpV = this._v || (this._v = new V3()), tmpP = this._p || (this._p = new V3());
      // plume: emission and speed follow the gas velocity at each open exhaust end
      m.outlets.forEach((o, k) => {
        const u = frame[o.offset + 2], T = frame[o.offset + 1];
        if (u > 3) {
          this.emitAcc[k] += dt * Math.min(140, 18 + u * 1.1);
          const speed = Math.min(3.2, 0.25 + u * 0.016);
          while (this.emitAcc[k] >= 1) {
            this.emitAcc[k] -= 1;
            tmpP.copy(o.pos).add(tmpV.set(0, (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(o.radius * 1.2));
            tmpV.copy(o.dir).multiplyScalar(speed * (0.7 + 0.6 * Math.random()));
            tmpV.x += 0.0; tmpV.y += (Math.random() - 0.3) * 0.12 * speed; tmpV.z += (Math.random() - 0.5) * 0.14 * speed;
            const warm = Math.min(1, Math.max(0, (T - 400) / 500));
            this.spawn(0, tmpP, tmpV, 0.55 + 0.35 * Math.random(), o.radius * 1.6, 0.30 + 0.5 * warm, 0.32 + 0.16 * warm, 0.38, 0.05 + 0.05 * warm);
          }
        }
      });
      // overrun flames: decorative, triggered by the fuel-cut flag at speed
      if (cut && rpm > 0.42 * red) {
        this.popTimer -= dt;
        if (this.popTimer <= 0) {
          this.popTimer = 0.07 + Math.random() * 0.22;
          const o = m.outlets[(Math.random() * m.outlets.length) | 0];
          if (o) {
            const nPop = 10 + ((Math.random() * 10) | 0);
            for (let j = 0; j < nPop; j++) {
              tmpP.copy(o.pos);
              tmpV.copy(o.dir).multiplyScalar(1.2 + 2.6 * Math.random());
              tmpV.y += (Math.random() - 0.5) * 0.5; tmpV.z += (Math.random() - 0.5) * 0.5;
              const blue = Math.random() < 0.3;
              this.spawn(1, tmpP, tmpV, 0.07 + 0.09 * Math.random(), o.radius * (1.3 + Math.random()), blue ? 0.5 : 2.6, blue ? 0.9 : 1.1, blue ? 2.6 : 0.25, 0.9);
            }
          }
        }
      }
      // camera shake from torque and speed (decorative, a millimetre or two)
      const amp = 0.0022 * Math.min(1, Math.abs(torque) / 600) * Math.min(1, rpm / red) + 0.0004 * Math.min(1, rpm / red);
      this.shakeAmp = this.reducedMotion ? 0 : amp;
    }
    if (this.floor && this.wavesOn) {
      const sz = this.renderer.getSize(this._sz || (this._sz = new THREE.Vector2()));
      this.floor.update(frame, dt, this.camera, this.camera.position.distanceTo(this.controls.target), sz.y, this.intro);
    }
    // particles
    const pos = this.pPos, col = this.pCol;
    for (let i = 0; i < MAX_PART; i++) {
      if (this.pAge[i] >= this.pLife[i]) { if (col[4 * i + 3] !== 0) col[4 * i + 3] = 0; continue; }
      this.pAge[i] += dt;
      const f = this.pAge[i] / this.pLife[i];
      const drag = this.pKind[i] ? 0.90 : 0.965;
      this.pVel[3 * i] *= drag; this.pVel[3 * i + 1] = this.pVel[3 * i + 1] * drag + (this.pKind[i] ? 0.02 : 0.012); this.pVel[3 * i + 2] *= drag;
      pos[3 * i] += this.pVel[3 * i] * dt; pos[3 * i + 1] += this.pVel[3 * i + 1] * dt; pos[3 * i + 2] += this.pVel[3 * i + 2] * dt;
      this.pSize[i] *= 1 + dt * (this.pKind[i] ? 3.0 : 2.4);
      if (f >= 1) col[4 * i + 3] = 0; else col[4 * i + 3] *= 1 - dt / this.pLife[i] * (this.pKind[i] ? 2.5 : 1.8);
    }
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;

    // camera
    this.camera.position.sub(this.shake);
    if (this.fly) {
      const fl = this.fly;
      fl.u = Math.min(1, fl.u + dt / 0.9);
      const e = fl.u * fl.u * (3 - 2 * fl.u);
      this.camera.position.lerpVectors(fl.p0, fl.p1, e);
      this.controls.target.lerpVectors(fl.t0, fl.t1, e);
      if (fl.u >= 1) this.fly = null;
    }
    if (this.idleOrbit && !this.reducedMotion && !this.fly && (this.attract || now - this.lastInput > 7000)) this.controls.autoRotate = true;
    this.controls.update(dt);
    const a = this.reducedMotion ? 0 : (this.shakeAmp || 0);
    this.shake.set((Math.random() - 0.5) * a, (Math.random() - 0.5) * a, (Math.random() - 0.5) * a);
    this.camera.position.add(this.shake);
  }

  render() {
    this.composer.render();
  }

  memory() {
    const i = this.renderer.info;
    return { geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs ? i.programs.length : 0 };
  }
}

// The sound picture on the floor of the live app (chosen by Joel on 2026-11-14 from five studies:
// "Membrane + Spectro"). The video renderer still draws the older rings (sound-waves.js).
//
// It reads the telemetry's header.sound (each opening's last 128 samples of radiated pressure,
// pascals at 1 m) and the spectrum of the sound the page plays. It has no clock of its own: what
// moves is driven by the engine's speed and its sound.
//
//   PulseClock    a slow pulse train whose rate glides with engine speed (1 a second at idle to
//                 3.2 at the redline), and the live strength of the real sound that scales it.
//   Membrane      the floor as a lattice of dots that each pulse lifts as a soft swell.
//   SpectroFloor  a spectrogram as a disc on the floor: frequency outward, time round. It lies on
//                 the membrane's swell, and the dots inside it take its light.
//   SoundFloor    the three together, for one engine.
//
// Every number that turns data into picture is in the three config objects below; they are read
// every frame, so they can be changed from the console (window.__app.scene.floor).

import * as THREE from 'three';

/** The pulse clock: a slow visual pulse train whose rate glides with engine speed. */
export const pulseConfig = {
  /** Visual pulses per second at idle and at the redline. In between the rate glides on a
   *  geometric curve of engine speed, so it only ever rises as the revs rise. (The first version
   *  divided the firing rate by a power of two, which held the rate near 2 a second whatever the
   *  engine did and let it drop when the divisor stepped.) */
  rate: [1.0, 3.2],
  /** Loudness to strength (0..1): y = (rms / pRef)^exponent, strength = y / (1 + y). rms is the
   *  root-mean-square radiated pressure (Pa at 1 m) over the opening's 11 ms history. Measured
   *  in the app: about 0.4 Pa (V8 idling) to 40 Pa (four-rotor at the limiter). */
  pRef: 4,
  exponent: 0.7,
  /** The loudness is followed fast upward and slower downward (seconds). */
  attack: 0.03,
  release: 0.30,
  /** drive = strength x (1 - throttleShare + throttleShare x throttle): what scales every swell
   *  on the floor, live, so opening the throttle shows at once and a lift-off relaxes it. */
  throttleShare: 0.45,
  /** A jump in drive of this much above its half-second average starts a pulse at once
   *  (no sooner than kickGap seconds after the last one). */
  kick: 0.10,
  kickGap: 0.16,
  /** Swells travel faster with drive: speed = base x (1 + speedGain x drive). */
  speedGain: 0.6,
  /** Most pulses kept alive. */
  maxPulses: 8,
};

/** The floor membrane. Lengths in metres. */
export const membraneConfig = {
  spacing: 0.030,        // dot pitch of the lattice (hexagonal)
  radius: 4.6,           // lattice radius about the middle of the engine and its openings
  dot: 0.0052,           // dot diameter
  speed: 2.3,            // swell speed at no drive (m/s); see pulseConfig.speedGain
  reach: 3.4,            // a swell fades out by this distance from its opening
  widthShare: 0.30,      // swell half-width as a share of the distance to the next swell
  widthLimits: [0.13, 0.42],
  height: 0.115,         // swell height at drive 1, at its opening
  spread: 0.9,           // height falls as 1 / sqrt(1 + distance / spread)
  light: [-0.35, 0.55, 0.76], // where the slope light comes from
  slopeGain: 9.0,        // how strongly a slope brightens or darkens its dots
  base: 0.17,            // brightness of the flat lattice
  dim: 0.5,              // overall brightness of every dot (Joel, 2026-11-14: "dim the dots of the Membrane by 50%")
  dof: 3.0,              // defocus: extra dot size (pixels) per unit of relative distance from the focus
  // the app's palette: flat lattice, slope facing the light, slope facing away
  flat: [0.20, 0.26, 0.38], warm: [1.0, 0.52, 0.18], cool: [0.20, 0.50, 1.0],
  // the dots inside the spectrogram disc take its light (dots), the disc itself is dimmed to a wash
  // under them (disc), and the slope light is turned down so the two warm colours do not pile up (slope)
  withSpectro: { dots: 2.3, disc: 0.5, slope: 0.6 },
};

/** The spectrogram as a disc on the floor around the engine: frequency runs
 *  outward, time runs round, and a write line sweeps round like a radar. A steady note is a
 *  circle; revving up widens it into a spiral; a throttle blip is a spoke. */
export const spectroFloorConfig = {
  fLo: 30, fHi: 9000,    // frequency span from the inner edge to the outer (log)
  bins: 192,             // frequency steps
  rows: 512,             // time steps round the disc
  seconds: 9,            // one sweep of the write line
  radius: [0.42, 2.9],   // inner and outer radius (m); the inner one is added to the engine's own half-size
  height: 0.03,          // height of the loudest ridge (m)
  gain: 0.40,            // brightness just behind the write line
  rest: 0.28,            // share of that brightness kept by sound a full sweep old
  floor: 0.34,           // levels below this (0..1) are left dark, so only the ridges show
  haze: 0.3,             // brightness of the quieter levels (the palette's violet), as a share of the ridges'
  line: 0.3,             // brightness of the write line itself
};

const MS = 16;   // openings the membrane takes (exhaust first)
const MP = 8;    // pulses alive at once
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ pulse clock
/** A slow pulse train whose rate glides with engine speed, and the live strength of the sound. */
export class PulseClock {
  constructor(H, cfg = pulseConfig) {
    this.cfg = cfg;
    const S = H.sound;
    this.S = S && S.count > 0 ? S : null;
    this.firePerRev = H.spec.firing.length * 360 / (H.cycle_deg || 720);
    this.redline = H.spec.redline || 7000;
    this.idle = Math.min(0.5 * this.redline, H.spec.idle || 0.13 * this.redline);
    this.exhaust = this.S ? S.sources.map((s) => s.stem === 'exhaust') : [];
    if (!this.exhaust.some(Boolean)) this.exhaust = this.exhaust.map(() => true);
    this.ms = new Float32Array(this.S ? S.count : 0);       // each opening's mean square, followed
    this.levels = new Float32Array(this.ms.length);          // each opening's strength now, 0..1
    this.exMs = 0;
    this.level = 0;        // strength of the exhaust openings together, 0..1
    this.rms = 0;          // their rms pressure, Pa at 1 m
    this.drive = 0;        // level x throttle term: what the swells are scaled by, live
    this.slow = 0;         // drive averaged over half a second (for the kick)
    this.rev = 0;          // engine speed, 0 at idle to 1 at the redline
    this.rate = 0; this.fireHz = 0;
    this.acc = 0;          // share of the way to the next pulse
    this.count = 0;        // pulses started
    this.sinceKick = 9;
    this.pulses = [];      // newest first: {age, travel, interval}
    this.lastT = null;
  }
  law(ms) { const y = Math.pow(Math.sqrt(ms) / this.cfg.pRef, this.cfg.exponent); return y / (1 + y); }

  /** `frame` is the newest telemetry frame (or null), `dt` the wall time since the last call (s). */
  update(frame, dt) {
    const c = this.cfg;
    // travel: metres at a base speed of 1 m/s, so each consumer scales it by its own speed
    for (const p of this.pulses) { p.age += dt; p.travel += dt * (1 + c.speedGain * this.drive); }
    while (this.pulses.length && this.pulses[this.pulses.length - 1].age >= 4) this.pulses.pop();
    this.sinceKick += dt;
    if (!frame || !this.S) return;
    // engine time passed: a frame seen twice, or a stopped engine, adds no pulses
    const t = frame[0];
    const dte = this.lastT === null ? 0 : Math.min(0.1, Math.max(0, t - this.lastT));
    this.lastT = t;
    if (dte <= 0) return;
    // loudness of each opening over its history, followed fast up and slower down
    const S = this.S, n = S.samples, kUp = 1 - Math.exp(-dte / c.attack), kDn = 1 - Math.exp(-dte / c.release);
    let ex = 0;
    for (let j = 0; j < S.count; j++) {
      let a = 0;
      const o = S.offset + j * n;
      for (let i = 0; i < n; i++) { const v = frame[o + i]; a += v * v; }
      a /= n;
      if (!Number.isFinite(a)) a = 0;
      this.ms[j] += (a - this.ms[j]) * (a > this.ms[j] ? kUp : kDn);
      this.levels[j] = this.law(this.ms[j]);
      if (this.exhaust[j]) ex += this.ms[j];
    }
    this.rms = Math.sqrt(ex);
    this.level = this.law(ex);
    const thr = Math.min(1, Math.max(0, frame[3]));
    this.throttle = thr;
    this.drive = this.level * (1 - c.throttleShare + c.throttleShare * thr);
    this.slow += (this.drive - this.slow) * (1 - Math.exp(-dte / 0.5));
    // rate: glides with engine speed, idle to redline; below idle it falls away to nothing
    const rpm = Math.max(0, frame[2]);
    this.fireHz = rpm / 60 * this.firePerRev;
    this.rev = Math.min(1, Math.max(0, (rpm - this.idle) / (this.redline - this.idle)));
    this.rate = c.rate[0] * Math.pow(c.rate[1] / c.rate[0], this.rev) * Math.min(1, rpm / this.idle);
    if (this.rate < 0.05) return;
    this.acc += this.rate * dte;
    const kick = this.drive - this.slow > c.kick && this.sinceKick > c.kickGap && this.acc > 0.25;
    if (this.acc >= 1 || kick) {
      this.acc = kick ? 0 : Math.min(this.acc - 1, 0.5);
      this.sinceKick = 0;
      this.count++;
      const interval = 1 / this.rate;
      this.pulses.unshift({ age: 0, travel: 0, interval });
      if (this.pulses.length > c.maxPulses) this.pulses.length = c.maxPulses;
    }
  }
}

// The spectrogram disc's data and light, shared by the disc itself and the membrane's dots.
const SPEC_CHUNK = `
uniform sampler2D uTex; uniform float uHead, uRows;
uniform float uGain, uFloor, uRest, uLine, uHaze;
// uv.x: frequency (inner to outer), uv.y: angle round the disc. Returns the level there and how
// many sweeps ago it was written.
vec2 level(vec2 uv) {
  float row = uv.y * uRows;
  float age = mod(uHead - row, uRows);            // rows since this angle was written
  float v = texture2D(uTex, vec2(uv.x, (floor(row) + 0.5) / uRows)).r;
  float v2 = texture2D(uTex, vec2(uv.x, (floor(row) + 1.5) / uRows)).r;
  // between rows: blend, except across the write line, where old meets new
  v = age < 1.0 ? v : mix(v, v2, fract(row));
  return vec2(v, age / uRows);
}
float shape(vec2 uv) { return smoothstep(0.0, 0.06, uv.x) * (1.0 - smoothstep(0.72, 1.0, uv.x)); }
// the page's spectrogram palette: black, violet, magenta, orange, pale gold, white
vec3 magma(float s) {
  vec3 c = mix(vec3(0.016, 0.02, 0.04), vec3(0.157, 0.086, 0.376), smoothstep(0.0, 0.25, s));
  c = mix(c, vec3(0.659, 0.157, 0.376), smoothstep(0.25, 0.5, s));
  c = mix(c, vec3(1.0, 0.478, 0.157), smoothstep(0.5, 0.72, s));
  c = mix(c, vec3(1.0, 0.839, 0.51), smoothstep(0.72, 0.9, s));
  return mix(c, vec3(1.0), smoothstep(0.9, 1.0, s));
}
vec3 specLight(vec2 uv) {
  vec2 l = level(uv);
  float sh = shape(uv);
  // newest brightest, fading round the disc, and out altogether just ahead of the write line
  float old = mix(1.0, uRest, smoothstep(0.0, 0.7, l.y)) * (1.0 - smoothstep(0.72, 0.985, l.y));
  // soft at the write line itself (the glow below marks it), and weighted toward the loud ridges
  float k = max(smoothstep(uFloor, 1.0, l.x), uHaze * smoothstep(0.12, 0.4, l.x)) * sh * uGain * old * smoothstep(0.0, 10.0, l.y * uRows);
  // palette values are display values; a power takes them most of the way to linear and keeps the violet
  vec3 col = pow(magma(l.x), vec3(1.6)) * k;
  return col + vec3(1.0, 0.62, 0.3) * (uLine * sh * (0.25 + l.x) * exp(-l.y * uRows * 0.22));
}`;
// The membrane's swell, shared by its dots and the spectrogram disc, which lies on it.
const SWELL_CHUNK = `
uniform vec3 uSrc[${MS}];
uniform float uAmp[${MS * MP}];
uniform vec2 uPul[${MP}];          // radius, half-width of each pulse's swell
uniform int uNS, uNP;
uniform float uSpread;
uniform vec3 uKey;                 // the opening screen's ripple: where on the floor it starts
uniform vec3 uKeyPul;              // its radius, half-width and height (height 0: none)
// height of the floor at xz, and its slope (x: height, yz: d/dx, d/dz)
vec3 swell(vec2 xz) {
  float h = 0.0; vec2 g = vec2(0.0);
  for (int j = 0; j < ${MS}; j++) {
    if (j >= uNS) break;
    vec2 d = xz - uSrc[j].xz;
    float dist = length(d) + 1e-4;
    float att = inversesqrt(1.0 + dist / uSpread);
    for (int p = 0; p < ${MP}; p++) {
      if (p >= uNP) break;
      float a = uAmp[p * ${MS} + j] * att;
      if (a <= 0.0) continue;
      // one smooth crest; never below the floor, which would hide the dots
      float w = uPul[p].y, x = (dist - uPul[p].x) / w, e0 = exp(-x * x);
      h += a * e0;
      g += (d / dist) * (a * -2.0 * x * e0 / w);
    }
  }
  if (uKeyPul.z > 0.0) {
    vec2 d = xz - uKey.xz;
    float dist = length(d) + 1e-4, x = (dist - uKeyPul.x) / uKeyPul.y, e0 = exp(-x * x);
    h += uKeyPul.z * e0;
    g += (d / dist) * (uKeyPul.z * -2.0 * x * e0 / uKeyPul.y);
  }
  return vec3(h, g);
}`;

// ------------------------------------------------------------------ membrane
const MEM_VERT = SWELL_CHUNK + SPEC_CHUNK + `
uniform vec3 uOrigin, uLight, uFlat, uWarm, uCool, uCentre;
uniform float uRf, uFocus, uPx, uDot, uSlope, uBase, uDim, uDof, uHRef, uSpecDots, uR0, uR1;
uniform float uReveal;    // opening screen: dots further than this from uKey are not drawn yet
uniform vec3 uIntro;      // brightness ahead of the ripple's front, behind it, and whether there is a front (0 or 1)
varying vec3 vCol;
void main() {
  vec3 P = position + uOrigin;
  vec3 sw = swell(P.xz);
  float h = sw.x; vec2 g = sw.yz;
  P.y += h;
  vec4 mv = viewMatrix * vec4(P, 1.0);
  gl_Position = projectionMatrix * mv;
  float z = max(-mv.z, 0.05);
  // slope light: zero on the flat, positive where the surface faces the light
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  float sl = (dot(n, uLight) - uLight.y) * uSlope;
  float hi = sl / (1.0 + abs(sl));
  float lift = clamp(h / uHRef, -1.0, 1.0);
  vec3 col = uFlat * uBase * (1.0 + 0.6 * max(lift, 0.0)) + uWarm * (1.5 * max(hi, 0.0)) + uCool * (0.9 * max(-hi, 0.0));
  // a dot inside the spectrogram disc takes the disc's light, more where it is lifted
  if (uSpecDots > 0.0) {
    vec2 d = P.xz - uCentre.xz;
    float fx = (length(d) - uR0) / (uR1 - uR0);
    if (fx > 0.0 && fx < 1.0) col += specLight(vec2(fx, fract(atan(d.y, d.x) / 6.2831853))) * (uSpecDots * (1.0 + 0.8 * max(lift, 0.0)));
  }
  // dot size in pixels, defocus away from the focus distance, fade toward the lattice edge
  float px = uDot * uPx / z;
  float coc = uDof * abs(z - uFocus) / uFocus;
  float size = max(px, 1.0) + coc;
  float cover = (px * px) / (size * size);
  float edge = 1.0 - smoothstep(0.42 * uRf, uRf, length(position.xz));
  gl_PointSize = size + 1.0;
  // opening screen: the lattice spreads from the key, and the start swell lights the floor behind its front
  float dk = length(P.xz - uKey.xz);
  float behind = uIntro.z * (1.0 - smoothstep(-0.25, 0.35, dk - uKeyPul.x));
  float gain = mix(uIntro.x, uIntro.y, behind) * (1.0 - smoothstep(uReveal - 0.6, uReveal, dk));
  vCol = col * cover * edge * edge * 1.6 * uDim * gain;
}`;
const MEM_FRAG = `
varying vec3 vCol;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.35, 1.0, r);
  gl_FragColor = vec4(vCol * a, 1.0);
}`;

class Membrane {
  /** `spec` is the SpectroFloor whose light the dots take. */
  constructor(sources, origin, layer, spec, cfg = membraneConfig) {
    this.cfg = cfg;
    this.sources = sources;
    const s = cfg.spacing, R = cfg.radius, rows = Math.ceil(R / (s * 0.866)), pts = [];
    for (let iz = -rows; iz <= rows; iz++) {
      const z = iz * s * 0.866, off = (iz & 1) ? 0.5 * s : 0, half = Math.sqrt(Math.max(0, R * R - z * z));
      for (let x = Math.ceil((-half - off) / s) * s + off; x <= half; x += s) pts.push(x, 0, z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    this.count = pts.length / 3;
    const v3 = (a) => new THREE.Vector3(...a);
    // the swell's uniforms are shared with the spectrogram disc, and the disc's with the dots
    this.swell = {
      uSrc: { value: Array.from({ length: MS }, (_, j) => (sources[j] ? sources[j].pos.clone() : new THREE.Vector3(1e6, 0, 1e6))) },
      uAmp: { value: new Float32Array(MS * MP) }, uPul: { value: Array.from({ length: MP }, () => new THREE.Vector2(0, 1)) },
      uNS: { value: Math.min(MS, sources.length) }, uNP: { value: 0 }, uSpread: { value: 1 },
      uKey: { value: new THREE.Vector3() }, uKeyPul: { value: new THREE.Vector3(0, 1, 0) },
    };
    this.uniforms = {
      ...this.swell, ...spec.light,
      uOrigin: { value: origin.clone() }, uLight: { value: new THREE.Vector3() },
      uFlat: { value: v3(cfg.flat) }, uWarm: { value: v3(cfg.warm) }, uCool: { value: v3(cfg.cool) },
      uRf: { value: R }, uFocus: { value: 3 }, uPx: { value: 1000 }, uDot: { value: cfg.dot },
      uSlope: { value: 1 }, uBase: { value: 1 }, uDim: { value: 1 }, uDof: { value: 0 }, uReveal: { value: 1e6 }, uIntro: { value: new THREE.Vector3(1, 1, 0) }, uHRef: { value: 0.05 }, uSpecDots: { value: 0 },
    };
    this.mesh = new THREE.Points(g, new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: MEM_VERT, fragmentShader: MEM_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(layer);
  }
  /** `intro` (or null): the opening screen's state, see SoundFloor.update. */
  update(clock, camera, focus, viewH, intro) {
    const c = this.cfg, u = this.uniforms, amp = u.uAmp.value;
    if (intro) {
      u.uKey.value.copy(intro.key); u.uKeyPul.value.set(intro.ripple[0], Math.max(0.01, intro.ripple[1]), intro.ripple[2]);
      u.uReveal.value = intro.reveal; u.uIntro.value.set(intro.gain[0], intro.gain[1], intro.front ? 1 : 0);
    } else { u.uKeyPul.value.z = 0; u.uReveal.value = 1e6; u.uIntro.value.set(1, 1, 0); }
    amp.fill(0);
    const P = clock.pulses, np = Math.min(MP, P.length);
    for (let p = 0; p < np; p++) {
      const q = P[p], r = q.travel * c.speed;
      // width from the spacing to the next swell at the rate it was started at
      const w = Math.min(c.widthLimits[1], Math.max(c.widthLimits[0], c.widthShare * c.speed * q.interval));
      u.uPul.value[p].set(r, w * (1 + 0.12 * r));
      const env = smooth(0, 0.3, r) * (1 - smooth(0.45 * c.reach, c.reach, r));
      // height is live: every swell on the floor rises and falls with the sound as it is now
      for (let j = 0; j < u.uNS.value; j++) {
        const s = this.sources[j], lv = clock.levels[s.index] * (1 - clock.cfg.throttleShare + clock.cfg.throttleShare * (clock.throttle || 0));
        amp[p * MS + j] = env * c.height * lv * s.share;
      }
    }
    u.uNP.value = np;
    u.uLight.value.set(...c.light).normalize();
    u.uFlat.value.set(...c.flat); u.uWarm.value.set(...c.warm); u.uCool.value.set(...c.cool);
    u.uFocus.value = focus;
    u.uPx.value = viewH / (2 * Math.tan(0.5 * camera.fov * Math.PI / 180));
    u.uDot.value = c.dot; u.uSpread.value = c.spread; u.uBase.value = c.base; u.uDim.value = c.dim ?? 1;
    u.uSlope.value = c.slopeGain * c.withSpectro.slope;
    u.uSpecDots.value = c.withSpectro.dots;
    u.uDof.value = c.dof * viewH / 720; u.uHRef.value = 0.5 * c.height;
  }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

// ------------------------------------------------------------------ spectrogram on the floor
const SPF_VERT = SPEC_CHUNK + SWELL_CHUNK + `
uniform vec3 uCentre; uniform float uR0, uR1, uHeight;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec2 l = level(uv);
  float a = uv.y * 6.2831853, r = mix(uR0, uR1, uv.x);
  vec3 P = uCentre + vec3(r * cos(a), l.x * l.x * uHeight * shape(uv), r * sin(a));
  // the disc lies on the membrane and is lifted by its swell
  P.y += swell(P.xz).x;
  gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
}`;
const SPF_FRAG = SPEC_CHUNK + `
uniform float uDim;
varying vec2 vUv;
void main() { gl_FragColor = vec4(specLight(vUv) * uDim, 1.0); }`;

class SpectroFloor {
  constructor(model, floorY, cfg = spectroFloorConfig) {
    this.cfg = cfg;
    const core = new THREE.Box3().setFromPoints(model.ptsCore);
    const c = core.getCenter(new THREE.Vector3()), sz = core.getSize(new THREE.Vector3());
    this.inner = 0.5 * Math.min(sz.x, sz.z);
    this.NF = cfg.bins; this.NT = cfg.rows;
    this.data = new Uint8Array(this.NF * this.NT);
    this.tex = new THREE.DataTexture(this.data, this.NF, this.NT, THREE.RedFormat, THREE.UnsignedByteType);
    this.tex.minFilter = this.tex.magFilter = THREE.LinearFilter;
    this.tex.wrapT = THREE.RepeatWrapping; this.tex.wrapS = THREE.ClampToEdgeWrapping;
    this.tex.needsUpdate = true;
    this.col = new Float32Array(this.NF); this.prev = new Float32Array(this.NF);
    this.head = 0; this.acc = 0;
    // `light`: what a shader needs to read the disc's light at a point (shared with the membrane's dots)
    this.light = {
      uTex: { value: this.tex }, uHead: { value: 0 }, uRows: { value: this.NT },
      uCentre: { value: new THREE.Vector3(c.x, floorY + 0.008, c.z) }, uR0: { value: 0.5 }, uR1: { value: 3 },
      uGain: { value: 1 }, uFloor: { value: 0 }, uRest: { value: 0.5 }, uLine: { value: 0 }, uHaze: { value: 0 },
    };
    this.uniforms = { ...this.light, uHeight: { value: 0 }, uDim: { value: 1 } };
  }
  /** The membrane's swell uniforms, so the disc can lie on it. Builds the mesh. */
  attach(swell, layer) {
    Object.assign(this.uniforms, swell);
    // a plane whose uv the shader bends into a ring
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 128, 384), new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: SPF_VERT, fragmentShader: SPF_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(layer);
  }
  /** `source` is the page's SpectroSource (live/spectro.js), or null before sound starts.
   *  `dim` scales the disc's own brightness. */
  update(source, dt, dim = 1) {
    const c = this.cfg, u = this.uniforms;
    u.uDim.value = dim;
    u.uR0.value = this.inner + c.radius[0]; u.uR1.value = c.radius[1]; u.uHeight.value = c.height;
    u.uGain.value = c.gain; u.uFloor.value = c.floor; u.uRest.value = c.rest; u.uLine.value = c.line; u.uHaze.value = c.haze;
    if (!source) return;
    // rows are written at a steady rate, however fast the page draws
    this.acc += Math.min(0.1, dt) * this.NT / c.seconds;
    const n = Math.floor(this.acc);
    if (n > 0) {
      this.acc -= n;
      this.prev.set(this.col);
      source.column(this.col, c.fLo, c.fHi);
      for (let k = 1; k <= n; k++) {
        this.head = (this.head + 1) % this.NT;
        const o = this.head * this.NF, t = k / n;
        for (let i = 0; i < this.NF; i++) this.data[o + i] = Math.round(255 * (this.prev[i] + (this.col[i] - this.prev[i]) * t));
      }
      this.tex.needsUpdate = true;
    }
    u.uHead.value = this.head + this.acc;
  }
  dispose() { this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.tex.dispose(); }
}

// ------------------------------------------------------------------ the floor, for one engine
export class SoundFloor {
  constructor(model, opts = {}) {
    this.model = model;
    const H = model.H, floorY = opts.floorY ?? -0.5, layer = opts.layer ?? 0;
    this.clock = new PulseClock(H);
    this.root = new THREE.Group();
    this.root.name = 'sound-floor';
    // openings: exhaust first, then intake; many openings of one kind share the height between them
    const src = (model.soundSources || []).filter((s) => s.pos);
    const nEx = src.filter((s) => s.stem === 'exhaust').length, nIn = src.length - nEx;
    this.sources = src.slice().sort((a, b) => (a.stem === 'exhaust' ? 0 : 1) - (b.stem === 'exhaust' ? 0 : 1)).slice(0, MS)
      .map((s) => ({ index: s.index, stem: s.stem, pos: s.pos.clone(), share: Math.pow(s.stem === 'exhaust' ? nEx : nIn, -0.75) }));
    const c = model.boxEng.getCenter(new THREE.Vector3());
    const mid = c.clone();
    if (this.sources.length) { mid.set(0, 0, 0); for (const s of this.sources) mid.add(s.pos); mid.multiplyScalar(1 / this.sources.length).lerp(c, 0.5); }
    this.spectro = new SpectroFloor(model, floorY);
    this.membrane = new Membrane(this.sources, new THREE.Vector3(mid.x, floorY + 0.006, mid.z), layer, this.spectro);
    this.spectro.attach(this.membrane.swell, layer);
    this.spectrum = null;      // the page's SpectroSource, once sound has started
    this.root.add(this.spectro.mesh, this.membrane.mesh);
  }
  setVisible(on) { this.root.visible = !!on; }

  /** After the model has drawn `frame`. `dt` is wall time since the last call (s), `focus` the
   *  camera's distance to what it looks at, `viewH` the picture's height in CSS pixels.
   *  `intro` is null in normal running. On the opening screen (live/scene.js drives it) it is
   *  { key: Vector3 on the floor, reveal: radius the lattice has spread to from there (m),
   *    ripple: [radius, half-width, height] of the one ripple leaving the key (height 0: none),
   *    gain: [dot brightness ahead of the ripple's front, behind it], front: whether the two differ }. */
  update(frame, dt, camera, focus, viewH, intro = null) {
    this.clock.update(frame, dt);
    this.membrane.update(this.clock, camera, focus, viewH, intro);
    this.spectro.update(this.spectrum, dt, membraneConfig.withSpectro.disc);
  }

  dispose() {
    this.membrane.dispose();
    this.spectro.dispose();
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}

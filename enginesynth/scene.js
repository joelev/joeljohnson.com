// The 3D scene of the live app. Builds an EngineModel from the engine's header, redraws it
// from the newest telemetry frame every animation frame, and adds the things a live page can
// afford: a reflective floor, orbit camera with presets, hot headers, tailpipe plumes,
// overrun flames and a little camera shake.
//
// Simulated and drawn from data: crank/piston/valve motion, gas pressure colour in every pipe
// and volume, header glow (gas temperature in the exhaust pipes), cylinder glow (cylinder
// pressure, burn rate, temperature), plume speed (gas velocity at the open exhaust end).
// Decorative: overrun flames (triggered by the fuel-cut flag; afterfire is not simulated),
// camera shake, floor reflection, vignette, bloom.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { EngineModel, config } from './engine-model.js?v=a5c5004823';

const V3 = THREE.Vector3;
const RAD = Math.PI / 180;
const MAX_PART = 900;

const FLOOR_VERT = `
varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const FLOOR_FRAG = `
varying vec3 vW; uniform vec3 uCenter;
float gridLine(vec2 p, float s) { vec2 g = abs(fract(p / s - 0.5) - 0.5) / fwidth(p / s); return 1.0 - min(min(g.x, g.y), 1.0); }
void main() {
  float d = distance(vW.xz, uCenter.xz);
  // a dark veil over the mirror: clearest under the engine, opaque far away
  float veil = mix(0.80, 1.0, smoothstep(0.3, 3.5, d));
  float g = max(gridLine(vW.xz, 0.1) * 0.25, gridLine(vW.xz, 1.0) * 0.6) * (1.0 - smoothstep(1.0, 6.0, d));
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
    renderer.setPixelRatio(Math.min(opts.maxPixelRatio || 2, window.devicePixelRatio || 1));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
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
    controls.addEventListener('start', () => { this.lastInput = performance.now(); controls.autoRotate = false; this.fly = null; });
    this.controls = controls;
    this.lastInput = performance.now();
    this.idleOrbit = opts.idleOrbit !== false;

    // floor: a mirror with a dark veil and grid on top (the veil lives on layer 1, which the
    // mirror's own camera does not see)
    const refl = new Reflector(new THREE.CircleGeometry(9, 48), { textureWidth: 1024, textureHeight: 1024, color: 0x8a8f9a, clipBias: 0.002 });
    refl.rotation.x = -Math.PI / 2;
    this.reflector = refl;
    scene.add(refl);
    this.floorMat = new THREE.ShaderMaterial({ vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG, transparent: true, depthWrite: false, uniforms: { uCenter: { value: new V3() } } });
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
    composer.addPass(new RenderPass(scene, this.camera));
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
    this.camera.updateProjectionMatrix();
    if (this.model) this.computeViews();
  }

  /** Replace the engine. Disposes the old model's GPU resources. */
  setHeader(header) {
    const first = !this.model;
    if (this.model) this.model.dispose();
    config.pFull = 0.7;
    this.model = new EngineModel(header, { heat: true, lightGain: 0.22, lightRange: 0.9 });
    this.scene.add(this.model.root);
    const y = this.model.boxAll.min.y - 0.07;
    this.reflector.position.y = y;
    this.veil.position.y = y + 0.002;
    this.controls.minDistance = 0.35;
    this.controls.maxDistance = 9;
    this.emitAcc = this.model.outlets.map(() => 0);
    this.pAge.fill(1e9);
    this.computeViews();
    if (first) this.setView(this.opts.view || 'engine', true);
    else this.setView(this.viewName || 'engine', false);
  }

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
      front: { pts: m.ptsEng, target: boxC, az: -90, el: 5, bx: 0.72, by: [-0.4, 0.45], lift: 0.22 },
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
    if (instant) {
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
    const m = this.model;
    if (!m) return;
    if (frame) {
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
      this.shakeAmp = amp;
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
    if (this.idleOrbit && !this.fly && now - this.lastInput > 7000) this.controls.autoRotate = true;
    this.controls.update(dt);
    const a = this.shakeAmp || 0;
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

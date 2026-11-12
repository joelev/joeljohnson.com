// Shared engine scene: layout, meshes and per-frame update for one engine, built from a
// telemetry header (telemetry.json schema). Used by the video renderer (viz/main.js) and the
// live app (live/scene.js).

import * as THREE from 'three';

const V3 = THREE.Vector3;
const RAD = Math.PI / 180;

// ---------------------------------------------------------------- colour maps
/** Colour-scale settings; a page may change them before building a model. */
export const config = { pFull: 0.7, pExp: 1.6, gain: 4.0, negGain: 0.28 };
const HUE_POS = [[0, [0.9, 0.09, 0.02]], [0.35, [1.0, 0.28, 0.04]], [0.7, [1.0, 0.6, 0.17]], [1, [1.0, 0.9, 0.72]]];
const HUE_NEG = [[0, [0.10, 0.12, 0.9]], [0.35, [0.07, 0.33, 1.0]], [0.7, [0.16, 0.55, 1.0]], [1, [0.32, 0.72, 1.0]]];
export function ramp(stops, s, out, o) {
  for (let k = 1; k < stops.length; k++) {
    if (s <= stops[k][0] || k === stops.length - 1) {
      const a = stops[k - 1], b = stops[k];
      const f = Math.min(1, Math.max(0, (s - a[0]) / (b[0] - a[0])));
      out[o] = a[1][0] + f * (b[1][0] - a[1][0]);
      out[o + 1] = a[1][1] + f * (b[1][1] - a[1][1]);
      out[o + 2] = a[1][2] + f * (b[1][2] - a[1][2]);
      return;
    }
  }
}
/** Gas glow for a pressure difference (bar): hue by sign and size, brightness rising with |dp|.
 *  Ambient pressure is dark; the returned colour is HDR (values above 1 bloom). */
export function pressureColor(dpBar, out, o) {
  const s = Math.min(1, Math.abs(dpBar) / config.pFull);
  ramp(dpBar >= 0 ? HUE_POS : HUE_NEG, s, out, o);
  // suction is drawn dimmer than pressure, so a plenum under idle vacuum does not outshine a
  // combustion pulse; the legend is built from this same function
  const k = config.gain * (dpBar >= 0 ? 1 : config.negGain) * Math.pow(s, config.pExp);
  out[o] *= k; out[o + 1] *= k; out[o + 2] *= k;
}
export const GLOW = [[0, [0, 0, 0]], [0.2, [0.5, 0.04, 0.0]], [0.45, [1.0, 0.24, 0.03]], [0.7, [1.0, 0.56, 0.16]], [1, [1.0, 0.9, 0.7]]];

// ---------------------------------------------------------------- layout (pure geometry, metres)
function angDiff(a, b) {
  const d = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return d;
}
function fitCurve(make, len) {
  const c0 = make(0);
  if (c0.getLength() >= len) return c0;
  let hi = 0.05;
  while (make(hi).getLength() < len && hi < 4) hi *= 2;
  let lo = 0;
  for (let k = 0; k < 22; k++) {
    const mid = 0.5 * (lo + hi);
    if (make(mid).getLength() < len) lo = mid; else hi = mid;
  }
  return make(0.5 * (lo + hi));
}
const crv = (pts) => new THREE.CatmullRomCurve3(pts, false, 'centripetal');

export function buildLayout(H) {
  const sp = H.spec, n = sp.firing.length, B = sp.bore, r = sp.stroke / 2, l = sp.rod;
  const ch = 0.32 * B, skirt = 0.30 * B;
  // The simulation fixes only the clearance volume, not its shape. It is drawn as a flat disc
  // of height hc; if true-scale valve lift would meet the piston in a flat chamber (short-stroke,
  // long-overlap engines), part of that same volume is drawn as valve pockets recessed into the head.
  const hcFull = sp.stroke / (sp.cr - 1);
  const liftAt = (c, open, close, max) => (c <= open || c >= close ? 0 : max * Math.pow(Math.sin(Math.PI * (c - open) / (close - open)), 1.4));
  const valveGap = (c) => {
    const drop = r + l - (r * Math.cos(c) + Math.sqrt(l * l - r * r * Math.sin(c) * Math.sin(c)));
    return drop - Math.max(liftAt(c, 2 * Math.PI - sp.ivo * RAD, 3 * Math.PI + sp.ivc * RAD, sp.in_lift), liftAt(c, Math.PI - sp.evo * RAD, 2 * Math.PI + sp.evc * RAD, sp.ex_lift));
  };
  let minGap = Infinity;
  for (let c = 0; c < 4 * Math.PI; c += Math.PI / 720) minGap = Math.min(minGap, valveGap(c));
  const margin = 0.0008;
  const phi = 2 * (sp.in_valve_d * sp.in_valve_d + sp.ex_valve_d * sp.ex_valve_d) / (B * B);
  let recess = 0, hc = hcFull;
  if (hcFull + minGap < margin) {
    recess = Math.min((margin - minGap - hcFull) / (1 - phi), 0.92 * hcFull / phi);
    hc = hcFull - recess * phi;
  }
  const deck = r + l + ch + hc;
  const pitch = 1.22 * B, nslots = Math.max(...sp.slot) + 1;
  const slots = [...Array(nslots)].map(() => []);
  for (let i = 0; i < n; i++) slots[sp.slot[i]].push(i);
  const xoff = new Array(n).fill(0);
  const slotInfo = slots.map((list, s) => {
    const xc = (s - (nslots - 1) / 2) * pitch;
    let type = 'single';
    list.sort((p, q) => sp.bank[p] - sp.bank[q]);
    if (list.length >= 2) {
      type = angDiff(H.pin_angle[list[0]], H.pin_angle[list[1]]) < 1 ? 'shared' : 'split';
      const o = type === 'shared' ? 0.105 * B : 0.20 * B;
      xoff[list[0]] = -o;
      xoff[list[1]] = o;
    }
    return { xc, list, type };
  });
  const inline = sp.layout === 'inline', flat = sp.layout === 'flat';
  const cyl = [];
  for (let i = 0; i < n; i++) {
    const dir = H.bank_dir[i] * RAD;
    const a = new V3(0, Math.cos(dir), Math.sin(dir));
    const s = inline ? 1 : (Math.sign(dir) || 1);
    const b = new V3(0, -Math.sin(dir) * s, Math.cos(dir) * s);
    const x = slotInfo[sp.slot[i]].xc + xoff[i];
    const base = new V3(x, 0, 0);
    const port = (sgn) => base.clone().addScaledVector(a, deck + 0.12 * B).addScaledVector(b, sgn * 0.2 * B);
    const kaEx = inline ? 0.8 : flat ? 0.2 : 0.4;
    const tEx = a.clone().multiplyScalar(kaEx).add(b).normalize();
    const uIn = (inline ? a.clone().multiplyScalar(0.6).addScaledVector(b, -0.8)
      : flat ? a.clone().multiplyScalar(0.25).addScaledVector(b, -1)
        : a.clone().addScaledVector(b, -0.35)).normalize();
    cyl.push({ i, dir, a, b, s, x, exPort: port(1), inPort: port(-1), tEx, uIn });
  }
  const xMin = Math.min(...cyl.map((c) => c.x)), xMax = Math.max(...cyl.map((c) => c.x));
  const down = new V3(0, -1, 0), ex = new V3(1, 0, 0);
  const volPos = {}, volShape = {};
  const volRadius = (v) => Math.cbrt(3 * v / (4 * Math.PI));
  const volByName = {};
  H.volumes.forEach((v, k) => { volByName[v.name] = k; });
  const pipesOf = (kind) => H.pipes.map((p, k) => ({ p, k })).filter((e) => e.p.kind === kind);

  const COLL_LEN = 0.11;
  // Primaries fan in to their collector like the fingers of a hand. The collector sits out
  // from the ports (outboard and down) with its axis pointing away from the engine, and its
  // inlets form a row parallel to the crank in the same order as the cylinders. Each pipe
  // therefore keeps its place in that order all the way, at least a pipe diameter from its
  // neighbours, and none can pass through another. Spare length is taken up by bowing a pipe
  // out of the fan (along nhat, the same way for all of them).
  const primaryCurve = (c, end, axis, nhat, len, beta) => {
    const start = c.exPort;
    const p1 = start.clone().addScaledVector(c.tEx, Math.min(0.45 * B, 0.15 * len));
    const E0 = end.clone().addScaledVector(axis, -Math.min(0.06, 0.15 * len));
    return crv([start, p1, p1.clone().lerp(E0, 0.5).addScaledVector(nhat, beta), E0, end]);
  };
  const primEnd = {}, volOut = {}, collAxis = {}, collN = {};
  const rp = 0.5 * sp.primary_d;
  sp.groups.forEach((grp, g) => {
    const vi = volByName[`collector${g + 1}`];
    if (vi === undefined || !grp.length) return;
    const mean = new V3(), bm = new V3(), am = new V3();
    // weight toward the cylinders with the shortest pipes, so unequal headers stay drawable
    let wsum = 0;
    grp.forEach((i) => { const w = Math.pow(sp.primary_len[i], -3); wsum += w; mean.addScaledVector(cyl[i].exPort, w); bm.add(cyl[i].b); am.add(cyl[i].a); });
    mean.multiplyScalar(1 / wsum);
    bm.normalize();
    // swept back about 30 degrees so the gas leaves heading rearward
    const axis = bm.clone().addScaledVector(down, 0.8 * (1 - Math.max(0, bm.dot(down)))).normalize().addScaledVector(ex, 0.6).normalize();
    const row = ex.clone().addScaledVector(axis, -ex.dot(axis)).normalize();
    const nhat = new V3().crossVectors(row, axis).normalize();
    if (nhat.dot(bm.clone().add(am.normalize())) < 0) nhat.negate();
    const m = grp.length, pitchL = 2.9 * rp, ring = 0.5 * (m - 1) * pitchL;
    const clen = Math.max(0.10, 1.2 * ring);
    const order = grp.slice().sort((p, q) => cyl[p].exPort.x - cyl[q].exPort.x);
    const laneOf = {};
    order.forEach((i, j) => { laneOf[i] = row.clone().multiplyScalar(j * pitchL - ring); });
    // as far out as the shortest pipe allows
    let c = mean.clone();
    for (let D = 0.27; D >= 0.05; D -= 0.01) {
      c = mean.clone().addScaledVector(axis, D);
      if (grp.every((i) => primaryCurve(cyl[i], c.clone().add(laneOf[i]), axis, nhat, sp.primary_len[i], 0).getLength() <= sp.primary_len[i])) break;
    }
    volPos[vi] = c;
    collAxis[vi] = axis;
    collN[vi] = nhat;
    grp.forEach((i) => { primEnd[i] = c.clone().add(laneOf[i]); });
    volOut[vi] = c.clone().addScaledVector(axis, clen);
    volShape[vi] = { type: 'fan', a: ring + rp * 1.12, b: rp * 1.2, len: clen, ring, axis, d: row, n: nhat };
  });
  const collPts = Object.values(volPos);

  // ---- intake: plenum + airbox, or one throttle volume per cylinder
  const plenumIdx = volByName.plenum;
  if (plenumIdx !== undefined) {
    const meanPort = new V3(), target = new V3();
    cyl.forEach((c) => { meanPort.add(c.inPort); target.add(c.inPort.clone().addScaledVector(c.uIn, 0.8 * sp.runner_len)); });
    meanPort.multiplyScalar(1 / n);
    target.multiplyScalar(1 / n);
    const len = Math.max(xMax - xMin + 0.6 * B, 0.12);
    const R = Math.min(0.09, Math.max(0.03, Math.sqrt(H.volumes[plenumIdx].vol / (Math.PI * len))));
    let cy = target.y, cz = target.z;
    // as far from the ports as the runners' physical length allows, so they run nearly straight
    for (let f = 2.2; f >= 0.3; f -= 0.05) {
      cy = meanPort.y + (target.y - meanPort.y) * f;
      cz = meanPort.z + (target.z - meanPort.z) * f;
      if (cyl.every((c) => Math.hypot(c.inPort.y - cy, c.inPort.z - cz) - R * 0.9 <= 0.88 * sp.runner_len)) break;
    }
    const pc = new V3(0.5 * (xMin + xMax), cy, cz);
    volPos[plenumIdx] = pc;
    volShape[plenumIdx] = { type: 'capsule', r: R, len };
    const ai = volByName.airbox;
    if (ai !== undefined) {
      const side = Math.cbrt(H.volumes[ai].vol);
      volPos[ai] = new V3(pc.x - len / 2 - R - 0.10 - side / 2, cy, cz);
      volShape[ai] = { type: 'box', side, neck: { x0: pc.x - len / 2 - R - 0.10, x1: pc.x - len / 2 - R * 0.5, r: sp.throttle_d / 2 } };
    }
  }

  // ---- pipe paths
  const paths = H.pipes.map(() => null);
  const startPts = {}, endPts = {};
  pipesOf('runner').forEach(({ p, k }) => {
    const c = cyl[p.cyl];
    const end = c.inPort;
    if (p.left.type === 'volume' && p.left.index === plenumIdx) {
      const pc = new V3(c.x, volPos[plenumIdx].y, volPos[plenumIdx].z);
      const start = pc.clone().addScaledVector(end.clone().sub(pc).normalize(), volShape[plenumIdx].r * 0.9);
      const p1 = end.clone().addScaledVector(c.uIn, 0.55 * B);
      const w = c.a.clone().multiplyScalar(0.8).addScaledVector(c.b, -0.6).normalize();
      paths[k] = fitCurve((beta) => crv([start, start.clone().lerp(p1, 0.5).addScaledVector(w, beta), p1, end]), p.len);
    } else {
      // individual throttle: a straight trumpet
      const start = end.clone().addScaledVector(c.uIn, p.len);
      paths[k] = new THREE.LineCurve3(start, end);
      if (p.left.type === 'volume') {
        volPos[p.left.index] = start.clone().addScaledVector(c.uIn, 0.015);
        volShape[p.left.index] = { type: 'bell', r: 0.5 * p.dia[0], axis: c.uIn.clone() };
      }
    }
    startPts[k] = paths[k].getPointAt(0);
    endPts[k] = end;
  });
  pipesOf('snorkel').forEach(({ p, k }) => {
    const ab = volPos[p.right.index], side = volShape[p.right.index].side;
    const end = new V3(ab.x - side / 2, ab.y, ab.z);
    paths[k] = new THREE.LineCurve3(end.clone().addScaledVector(ex, -p.len), end);
  });
  pipesOf('primary').forEach(({ p, k }) => {
    const c = cyl[p.cyl], start = c.exPort, end = primEnd[p.cyl];
    paths[k] = fitCurve((beta) => primaryCurve(c, end, collAxis[p.right.index], collN[p.right.index], p.len, beta), p.len);
    startPts[k] = start;
    endPts[k] = end;
  });
  // merge volume sits behind the collectors, on the centre line between them
  const mergeIdx = volByName.merge;
  const secs = pipesOf('secondary');
  const outPts = Object.values(volOut);
  if (mergeIdx !== undefined && outPts.length) {
    const m = new V3();
    outPts.forEach((c) => m.add(c));
    m.multiplyScalar(1 / outPts.length);
    const cxMax = Math.max(...outPts.map((c) => c.x));
    const secLen = secs.length ? Math.min(...secs.map((e) => e.p.len)) : 0.4;
    // a single smooth bend from the collector outlet to the merge; extra length hangs as sag
    const one = (p, dx, beta) => {
      const s = volOut[p.left.index], e = new V3(cxMax + dx, m.y - 0.02, m.z);
      const d = s.distanceTo(e);
      const a1 = s.clone().addScaledVector(collAxis[p.left.index], Math.min(0.07, 0.2 * d)), a2 = e.clone().addScaledVector(ex, -Math.min(0.08, 0.2 * d));
      return crv([s, a1, a1.clone().lerp(a2, 0.5).addScaledVector(down, beta), a2, e]);
    };
    const longest = (dx) => Math.max(...secs.map(({ p }) => one(p, dx, 0).getLength()));
    let lo = 0.22, hi = 3;
    if (longest(lo) < secLen) {
      for (let it = 0; it < 22; it++) {
        const mid = 0.5 * (lo + hi);
        if (longest(mid) < secLen) lo = mid; else hi = mid;
      }
    }
    volPos[mergeIdx] = new V3(cxMax + lo, m.y - 0.02, m.z);
    volOut[mergeIdx] = volPos[mergeIdx];
    volShape[mergeIdx] = { type: 'sphere', r: Math.max(0.7 * sp.secondary_d, 0.6 * sp.mid_d) };
    secs.forEach(({ p, k }) => { paths[k] = fitCurve((beta) => one(p, lo, beta), p.len); });
  }
  const outs = pipesOf('outlet');
  outs.forEach(({ p, k }, j) => {
    const s = volOut[p.left.index];
    const fromMerge = p.left.index === mergeIdx;
    const zoff = fromMerge && outs.length > 1 ? (j - (outs.length - 1) / 2) * 0.32 : 0;
    const ax = fromMerge ? null : collAxis[p.left.index];
    paths[k] = fitCurve((beta) => {
      const L = 0.4 * p.len + beta;
      if (ax) {
        const k1 = s.clone().addScaledVector(ax, 0.07), k2 = s.clone().addScaledVector(ax, 0.13).addScaledVector(ex, 0.12);
        return crv([s, k1, k2, k2.clone().addScaledVector(ex, 0.3 * L), k2.clone().addScaledVector(ex, L)]);
      }
      return crv([s, s.clone().add(new V3(0.12 * L, 0, 0.1 * zoff)), s.clone().add(new V3(0.32 * L, 0, zoff)), s.clone().add(new V3(L, 0, zoff))]);
    }, p.len);
  });

  return { primEnd, volOut, sp, n, B, r, l, ch, skirt, hc, hcFull, recess, minGap, deck, pitch, slotInfo, cyl, volPos, volShape, paths, startPts, endPts, plenumIdx, xMin, xMax };
}

// ---------------------------------------------------------------- meshes
export const steel = new THREE.MeshStandardMaterial({ color: 0xb4bac3, metalness: 1.0, roughness: 0.26 });
export const darkSteel = new THREE.MeshStandardMaterial({ color: 0x767d88, metalness: 1.0, roughness: 0.3 });
export const alu = new THREE.MeshStandardMaterial({ color: 0xbfc5cd, metalness: 1.0, roughness: 0.36 });
export const glass = new THREE.MeshStandardMaterial({ color: 0xb9d4ff, metalness: 0.0, roughness: 0.05, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide });

// Gas-carrying parts: a dark glass shell (fresnel rim and a highlight give the shape) around
// glowing gas. The gas colour comes per vertex (pipes) or as one colour (volumes); it is
// brightest where the view passes through the middle of the tube. The ghost variant is
// additive and shell-only, for the big intake volumes that should recede.
const DATA_VERT = `
attribute vec3 pcol; attribute float pheat;
uniform vec3 uCol; uniform float uUseAttr;
varying vec3 vC; varying vec3 vN; varying vec3 vV; varying float vH;
void main() {
  vC = mix(uCol, pcol, uUseAttr);
  vH = pheat * uUseAttr;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalMatrix * normal; vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;
const DATA_FRAG = `
uniform float uGhost;
varying vec3 vC; varying vec3 vN; varying vec3 vV; varying float vH;
void main() {
  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
  vec3 v = normalize(vV);
  float ndv = abs(dot(n, v));
  float rim = pow(1.0 - ndv, 3.0);
  float core = 0.22 + 0.78 * pow(ndv, 1.7);
  vec3 ld = normalize(vec3(0.3, 0.8, 0.5));
  float spec = pow(max(dot(n, normalize(ld + v)), 0.0), 90.0);
  if (uGhost > 0.5) {
    gl_FragColor = vec4(vec3(0.10, 0.13, 0.18) * (0.05 + rim) * 0.55 + vC * (0.10 + 0.9 * rim) * 0.45, 1.0);
  } else {
    // hot gas makes the shell itself glow, dull red to orange, strongest toward the silhouette
    vec3 hot = mix(vec3(0.55, 0.03, 0.0), vec3(1.5, 0.42, 0.05), vH) * vH * vH * (0.3 + 0.7 * pow(1.0 - ndv, 1.2));
    gl_FragColor = vec4(vec3(0.010, 0.012, 0.016) + vec3(0.20, 0.25, 0.33) * rim + vec3(0.35) * spec + vC * core + hot, 1.0);
  }
}`;
function dataMaterial(useAttr, ghost = false) {
  return new THREE.ShaderMaterial({
    vertexShader: DATA_VERT, fragmentShader: DATA_FRAG, side: THREE.DoubleSide,
    transparent: ghost, depthWrite: !ghost, blending: ghost ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { uCol: { value: new THREE.Vector3(0, 0, 0) }, uUseAttr: { value: useAttr ? 1 : 0 }, uGhost: { value: ghost ? 1 : 0 } },
  });
}

function xCyl(radius, x0, x1, mat, seg = 32) {
  const g = new THREE.CylinderGeometry(radius, radius, x1 - x0, seg);
  g.rotateZ(Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.x = 0.5 * (x0 + x1);
  return m;
}
function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.slice().reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
const circlePts = (cx, cy, rad, a0 = 0, a1 = 2 * Math.PI, k = 28) => [...Array(k + 1)].map((_, j) => { const a = a0 + (a1 - a0) * j / k; return [cx + rad * Math.cos(a), cy + rad * Math.sin(a)]; });
/** A crank web: plate normal to X between x0 and x0+t, outline given in the (Y,Z) plane. */
function webMesh(outline, x0, t, mat) {
  const shape = new THREE.Shape(hull(outline).map((p) => new THREE.Vector2(p[0], p[1])));
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 4 });
  // (x, y, z) of the extrusion -> (z, x, y): depth runs along the crank axis
  g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  m.position.x = x0;
  return m;
}

function buildCrank(L, H) {
  const { B, r, l, skirt } = L;
  const g = new THREE.Group();
  const Rm = 0.30 * B, Rp = 0.24 * B, Rw = 0.34 * B, wt = 0.15 * B;
  const Rcw = Math.max(Rm * 1.05, Math.min(0.85 * ((l - r) - skirt), r + 0.35 * B));
  const pinMarkers = new Array(L.n);
  const polar = (pa, rad) => [rad * Math.cos(pa), rad * Math.sin(pa)];
  const webOutline = (pa, cw) => {
    const [py, pz] = polar(pa, r);
    let pts = circlePts(0, 0, Rm).concat(circlePts(py, pz, Rw));
    if (cw) pts = pts.concat(circlePts(0, 0, Rcw, pa + Math.PI - 1.08, pa + Math.PI + 1.08, 24));
    return pts;
  };
  const addPin = (x0, x1, pa, list) => {
    const m = xCyl(Rp, x0, x1, steel);
    const [py, pz] = polar(pa, r);
    m.position.y = py; m.position.z = pz;
    g.add(m);
    for (const i of list) {
      const mk = new THREE.Object3D();
      mk.position.set(L.cyl[i].x, py, pz);
      g.add(mk);
      pinMarkers[i] = mk;
    }
  };
  const extents = [];
  for (const s of L.slotInfo) {
    const pa0 = H.pin_angle[s.list[0]] * RAD;
    if (s.type === 'split') {
      const pa1 = H.pin_angle[s.list[1]] * RAD;
      addPin(s.xc - 0.33 * B, s.xc - 0.07 * B, pa0, [s.list[0]]);
      addPin(s.xc + 0.07 * B, s.xc + 0.33 * B, pa1, [s.list[1]]);
      const [y0, z0] = polar(pa0, r), [y1, z1] = polar(pa1, r);
      g.add(webMesh(circlePts(0, 0, Rm).concat(circlePts(y0, z0, Rw), circlePts(y1, z1, Rw)), s.xc - 0.07 * B, 0.14 * B, darkSteel));
      g.add(webMesh(webOutline(pa0, true), s.xc - 0.33 * B - wt, wt, darkSteel));
      g.add(webMesh(webOutline(pa1, true), s.xc + 0.33 * B, wt, darkSteel));
      extents.push([s.xc - 0.33 * B - wt, s.xc + 0.33 * B + wt]);
    } else {
      const hw = s.type === 'shared' ? 0.22 * B : 0.15 * B;
      addPin(s.xc - hw, s.xc + hw, pa0, s.list);
      g.add(webMesh(webOutline(pa0, true), s.xc - hw - wt, wt, darkSteel));
      g.add(webMesh(webOutline(pa0, true), s.xc + hw, wt, darkSteel));
      extents.push([s.xc - hw - wt, s.xc + hw + wt]);
    }
  }
  for (let k = 0; k + 1 < extents.length; k++) g.add(xCyl(Rm, extents[k][1], extents[k + 1][0], steel));
  const xf = extents[0][0], xr = extents[extents.length - 1][1];
  g.add(xCyl(Rm, xf - 0.40 * B, xf, steel));
  g.add(xCyl(0.5 * B, xf - 0.40 * B, xf - 0.26 * B, darkSteel, 48));
  g.add(xCyl(Rm, xr, xr + 0.42 * B, steel));
  g.add(xCyl(Math.max(1.05 * B, Rcw * 1.15), xr + 0.30 * B, xr + 0.42 * B, darkSteel, 64));
  return { group: g, pinMarkers, x0: xf - 0.40 * B, x1: xr + 0.42 * B };
}

function buildCylinder(L, c) {
  const { B, r, l, ch, skirt, deck, sp } = L;
  const seat = deck + L.recess;
  const g = new THREE.Group();
  g.position.set(c.x, 0, 0);
  g.rotation.x = c.dir;
  // liner (glass) from the lowest skirt position to the deck
  const y0 = (l - r) - skirt;
  const liner = new THREE.Mesh(new THREE.CylinderGeometry(0.505 * B, 0.505 * B, deck - y0, 48, 1, true), glass);
  liner.position.y = 0.5 * (deck + y0);
  liner.renderOrder = 2;
  g.add(liner);
  for (const y of [deck, y0]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.505 * B, 0.012 * B, 8, 64), alu);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = y;
    g.add(ring);
  }
  // piston: origin at the wrist pin
  const piston = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.485 * B, 0.485 * B, ch + skirt, 48), alu);
  body.position.y = 0.5 * (ch - skirt);
  piston.add(body);
  for (const yy of [ch - 0.07 * B, ch - 0.13 * B]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.487 * B, 0.008 * B, 6, 64), darkSteel);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = yy;
    piston.add(ring);
  }
  piston.add(xCyl(0.08 * B, -0.40 * B, 0.40 * B, steel, 20));
  g.add(piston);
  // combustion glow between crown and head
  const glowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.47 * B, 0.47 * B, 1, 40), glowMat);
  glow.renderOrder = 1;
  g.add(glow);
  // poppet valves, two intake and two exhaust, moving along the cylinder axis at true lift
  const mkValve = (d, x, z) => {
    const v = new THREE.Group();
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.28 * d, 0.5 * d, 0.035 * B, 32), steel);
    head.position.y = 0.0175 * B;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03 * B, 0.03 * B, 0.13 * B, 10), steel);
    stem.position.y = 0.035 * B + 0.065 * B;
    v.add(head, stem);
    v.position.set(x, seat, z);
    g.add(v);
    return v;
  };
  const zEx = c.s * 0.2 * B;
  const vin = [mkValve(sp.in_valve_d, -0.21 * B, -zEx), mkValve(sp.in_valve_d, 0.21 * B, -zEx)];
  const vex = [mkValve(sp.ex_valve_d, -0.21 * B, zEx), mkValve(sp.ex_valve_d, 0.21 * B, zEx)];
  // markers used by the consistency checks
  const exMark = new THREE.Object3D(); exMark.position.set(0, deck + 0.12 * B, zEx); g.add(exMark);
  const inMark = new THREE.Object3D(); inMark.position.set(0, deck + 0.12 * B, -zEx); g.add(inMark);
  return { group: g, piston, glow, glowMat, vin, vex, exMark, inMark };
}

function buildRod(L) {
  const { B, l } = L;
  const g = new THREE.Group();
  g.add(xCyl(0.33 * B, -0.095 * B, 0.095 * B, steel, 36));
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.10 * B, l, 0.17 * B), steel);
  beam.position.y = l / 2;
  g.add(beam);
  const small = xCyl(0.15 * B, -0.095 * B, 0.095 * B, steel, 24);
  small.position.y = l;
  g.add(small);
  const tip = new THREE.Object3D();
  tip.position.y = l;
  g.add(tip);
  return { group: g, tip };
}

function buildTube(curve, pipe) {
  const S = pipe.samples, rings = Math.max(2 * S + 1, 9), RS = 14;
  const pos = new Float32Array(rings * (RS + 1) * 3), nor = new Float32Array(rings * (RS + 1) * 3), col = new Float32Array(rings * (RS + 1) * 3);
  const frac = new Float32Array(rings);
  const idx = [];
  let N = null;
  const T = new V3(), Tp = new V3(), Bn = new V3(), P = new V3(), axis = new V3();
  for (let j = 0; j < rings; j++) {
    const u = j / (rings - 1);
    curve.getPointAt(u, P);
    curve.getTangentAt(u, T).normalize();
    if (!N) {
      N = new V3(0, 1, 0);
      if (Math.abs(T.y) > 0.9) N.set(0, 0, 1);
      N.addScaledVector(T, -N.dot(T)).normalize();
    } else {
      axis.crossVectors(Tp, T);
      const sl = axis.length();
      if (sl > 1e-9) N.applyAxisAngle(axis.multiplyScalar(1 / sl), Math.asin(Math.min(1, sl)));
      N.addScaledVector(T, -N.dot(T)).normalize();
    }
    Tp.copy(T);
    Bn.crossVectors(T, N);
    const f = Math.min(S - 1, Math.max(0, u * S - 0.5));
    frac[j] = f;
    const i0 = Math.floor(f), i1 = Math.min(S - 1, i0 + 1);
    const rad = 0.5 * (pipe.dia[i0] + (pipe.dia[i1] - pipe.dia[i0]) * (f - i0));
    for (let k = 0; k <= RS; k++) {
      const a = 2 * Math.PI * k / RS, cs = Math.cos(a), sn = Math.sin(a);
      const o = (j * (RS + 1) + k) * 3;
      const nx = N.x * cs + Bn.x * sn, ny = N.y * cs + Bn.y * sn, nz = N.z * cs + Bn.z * sn;
      pos[o] = P.x + rad * nx; pos[o + 1] = P.y + rad * ny; pos[o + 2] = P.z + rad * nz;
      nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
    }
    if (j > 0) for (let k = 0; k < RS; k++) {
      const a = (j - 1) * (RS + 1) + k, b = j * (RS + 1) + k;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  const ca = new THREE.BufferAttribute(col, 3);
  ca.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('pcol', ca);
  const ha = new THREE.BufferAttribute(new Float32Array(rings * (RS + 1)), 1);
  ha.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('pheat', ha);
  g.setIndex(idx);
  return { geometry: g, frac, rings, RS, col: ca, heat: ha };
}


// ---------------------------------------------------------------- the model
const EXHAUST_KINDS = { primary: 1, secondary: 1, outlet: 1 };

/** Everything drawn for one engine, built from a telemetry header and updated from frames.
 *  `root` holds all meshes. Options: heat (shell glow from gas temperature in exhaust pipes). */
export class EngineModel {
  constructor(H, opts = {}) {
    this.H = H;
    this.opts = opts;
    const sp = H.spec;
    const L = buildLayout(H);
    const { B, deck } = L;
    const root = new THREE.Group();
    const engine = new THREE.Group();
    root.add(engine);
    const crank = buildCrank(L, H);
    engine.add(crank.group);
    const cyls = L.cyl.map((c) => {
      const o = buildCylinder(L, c);
      engine.add(o.group);
      // a light in the chamber, so a firing cylinder lights the parts around it
      o.light = new THREE.PointLight(0xffb070, 0, opts.lightRange || 0.7, 2);
      o.light.position.y = deck - 0.01;
      o.group.add(o.light);
      return o;
    });
    const rods = L.cyl.map(() => { const o = buildRod(L); engine.add(o.group); return o; });

    // pipes: glass tubes of glowing gas; the intake snorkel is ghosted so it recedes
    const pipeMat = dataMaterial(true), ghostPipeMat = dataMaterial(true, true);
    const tubes = H.pipes.map((p, k) => {
      if (!L.paths[k]) return null;
      const t = buildTube(L.paths[k], p);
      const m = new THREE.Mesh(t.geometry, p.kind === 'snorkel' ? ghostPipeMat : pipeMat);
      m.frustumCulled = false;
      if (p.kind === 'snorkel') m.renderOrder = 3;
      root.add(m);
      return { ...t, mesh: m, pipe: p, shown: L.paths[k].getLength() };
    });
    // volumes: airbox and plenum as ghosts, collectors as merge cones, the rest as small glass bodies
    const vols = H.volumes.map((v, k) => {
      const s = L.volShape[k], p = L.volPos[k];
      if (!s || !p) return null;
      let g, ghost = false;
      if (s.type === 'sphere') g = new THREE.SphereGeometry(s.r, 28, 18);
      else if (s.type === 'box') { g = new THREE.BoxGeometry(s.side, s.side, s.side, 1, 1, 1); ghost = true; }
      else if (s.type === 'fan') {
        // merge collector: a flat fan of inlets (one per primary) lofted down to the round outlet
        const dn = H.pipes.find((q) => q.left.type === 'volume' && q.left.index === k);
        const rOut = dn ? 0.5 * dn.dia[0] : s.b;
        const NU = 10, NP = 36, pos = [], idx = [];
        for (let j = -1; j <= NU; j++) {
          const u = Math.max(0, j) / NU, e = u * u * (3 - 2 * u), sc = j < 0 ? 0.02 : 1;
          const A = (s.a + (rOut - s.a) * e) * sc, Bq = (s.b + (rOut - s.b) * e) * sc, x = j < 0 ? -0.012 : s.len * u;
          for (let q = 0; q <= NP; q++) {
            const ph = 2 * Math.PI * q / NP;
            const v = s.axis.clone().multiplyScalar(x).addScaledVector(s.d, A * Math.cos(ph)).addScaledVector(s.n, Bq * Math.sin(ph));
            pos.push(v.x, v.y, v.z);
          }
        }
        for (let j = 0; j <= NU; j++) for (let q = 0; q < NP; q++) { const a0 = j * (NP + 1) + q, b0 = a0 + NP + 1; idx.push(a0, b0, a0 + 1, b0, b0 + 1, a0 + 1); }
        g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
      } else if (s.type === 'bell') {
        // bellmouth at the open end of an individual-throttle runner; the lathe axis is the runner axis
        const pts = [];
        for (let j = 0; j <= 10; j++) { const u = j / 10; pts.push(new THREE.Vector2(s.r * (1.0 + 0.75 * u * u * u), -0.015 + 0.04 * u)); }
        g = new THREE.LatheGeometry(pts, 32);
        g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), s.axis));
      } else { g = new THREE.CapsuleGeometry(s.r, s.len, 10, 28); g.rotateZ(Math.PI / 2); ghost = true; }
      const mat = dataMaterial(false, ghost);
      const m = new THREE.Mesh(g, mat);
      m.position.copy(p);
      if (ghost) m.renderOrder = 3;
      root.add(m);
      return { mesh: m, mat, offset: v.offset };
    });
    // throttle body between airbox and plenum
    let plate = null;
    for (const k in L.volShape) {
      const nk = L.volShape[k].neck;
      if (!nk) continue;
      const p = L.volPos[k];
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(nk.r, nk.r, nk.x1 - nk.x0, 28, 1, true), glass);
      neck.rotation.z = Math.PI / 2;
      neck.position.set(0.5 * (nk.x0 + nk.x1), p.y, p.z);
      root.add(neck);
      plate = new THREE.Mesh(new THREE.CylinderGeometry(nk.r * 0.97, nk.r * 0.97, 0.004, 28), alu);
      plate.position.copy(neck.position);
      root.add(plate);
    }

    // framing
    const boxAll = new THREE.Box3(), boxEng = new THREE.Box3();
    for (const c of L.cyl) {
      const top = new V3(c.x, 0, 0).addScaledVector(c.a, deck + 0.3 * B);
      for (const pt of [top.clone().addScaledVector(c.b, 0.5 * B), top.clone().addScaledVector(c.b, -0.5 * B)]) boxEng.expandByPoint(pt);
    }
    boxEng.expandByPoint(new V3(crank.x0, -1.1 * B, -1.1 * B)).expandByPoint(new V3(crank.x1, 1.1 * B, 1.1 * B));
    boxAll.copy(boxEng);
    const ptsEng = [], ptsAll = [];
    for (const x of [boxEng.min.x, boxEng.max.x]) for (const y of [boxEng.min.y, boxEng.max.y]) for (const z of [boxEng.min.z, boxEng.max.z]) ptsEng.push(new V3(x, y, z));
    tubes.forEach((t, k) => {
      if (!t) return;
      const kind = t.pipe.kind, rad = 0.5 * Math.max(...t.pipe.dia);
      for (let u = 0; u <= 1.0001; u += 0.1) {
        const pt = L.paths[k].getPointAt(Math.min(1, u));
        boxAll.expandByPoint(pt);
        for (const dy of [-rad, rad]) {
          const q = pt.clone(); q.y += dy;
          ptsAll.push(q);
          if (kind === 'runner' || kind === 'primary') { boxEng.expandByPoint(pt); ptsEng.push(q); }
        }
      }
    });
    vols.forEach((v) => { if (v) { ptsAll.push(v.mesh.position.clone().add(new V3(0, 0.1, 0)), v.mesh.position.clone().add(new V3(-0.12, -0.1, 0))); ptsEng.push(v.mesh.position.clone()); } });
    ptsAll.push(...ptsEng);
    const ptsCore = ptsEng.slice(0, 8);
    Object.assign(this, { root, L, sp, crank, cyls, rods, tubes, vols, plate, boxEng, boxAll, ptsCore, ptsEng, ptsAll, pipeMat, ghostPipeMat });
    this.state = { clear: Infinity, valveClear: Infinity };
    // open exhaust ends: where the gas leaves, and which way
    this.outlets = [];
    tubes.forEach((t, k) => {
      if (!t || t.pipe.right.type !== 'ambient' || !EXHAUST_KINDS[t.pipe.kind]) return;
      const c = L.paths[k];
      this.outlets.push({ pos: c.getPointAt(1), dir: c.getTangentAt(1).normalize(), radius: 0.5 * t.pipe.dia[t.pipe.samples - 1], offset: t.pipe.offset + 3 * (t.pipe.samples - 1) });
    });
    this._tmp = [0, 0, 0];
    this._P = new V3();
    this._W = new V3();
  }

  /** Draw one frame. `bin` is a Float32Array holding the frame at offset `o`.
   *  `refP(o, column)` may supply a reference pressure other than ambient. */
  update(bin, o = 0, refP = null) {
    const { H, L, sp, crank, cyls, rods, tubes, vols, plate, state } = this;
    const { r, l, ch, deck } = L;
    const seat = deck + L.recess, n = sp.firing.length, tmpCol = this._tmp, P = this._P, W = this._W;
    const pa = H.p_atm, heat = !!this.opts.heat;
    const thr = bin[o + 3];
    const co = o + H.cyl_offset;
    const theta = bin[co + 5] + sp.firing[0] * RAD;
    crank.group.rotation.x = -theta;
    for (let k = 0; k < n; k++) {
      const q = co + 6 * k, c = L.cyl[k], cy = cyls[k];
      const p = bin[q], T = bin[q + 1], li = bin[q + 2], le = bin[q + 3], burn = bin[q + 4], ca = bin[q + 5];
      const dist = r * Math.cos(ca) + Math.sqrt(l * l - r * r * Math.sin(ca) * Math.sin(ca));
      cy.piston.position.y = dist;
      const crown = dist + ch;
      cy.glow.position.y = 0.5 * (crown + deck);
      cy.glow.scale.y = Math.max(1e-5, deck - crown);
      const tt = Math.min(1, Math.max(0, (T - 500) / 2200));
      ramp(GLOW, tt, tmpCol, 0);
      // brightness belongs to combustion and expansion: pressure and the burn rate drive it,
      // temperature only picks the colour, so the exhaust stroke fades to an ember
      const gain = 0.02 + 1.5 * Math.pow(Math.min(1, p / 5.0e6), 0.8) + 1.1 * Math.min(1, burn / 2.0);
      cy.glowMat.color.setRGB(tmpCol[0] * gain, tmpCol[1] * gain, tmpCol[2] * gain);
      cy.light.intensity = (this.opts.lightGain || 0.10) * Math.max(0, gain - 0.15);
      for (const v of cy.vin) v.position.y = seat - li;
      for (const v of cy.vex) v.position.y = seat - le;
      state.clear = Math.min(state.clear, deck - crown);
      state.valveClear = Math.min(state.valveClear, seat - Math.max(li, le) - crown);
      const phi = c.dir - ca;
      P.set(c.x, r * Math.cos(phi), r * Math.sin(phi));
      W.set(c.x, dist * Math.cos(c.dir), dist * Math.sin(c.dir));
      rods[k].group.position.copy(P);
      rods[k].group.rotation.x = Math.atan2(W.z - P.z, W.y - P.y);
    }
    for (const tb of tubes) {
      if (!tb) continue;
      const off = tb.pipe.offset, po = o + off, S = tb.pipe.samples, arr = tb.col.array, per = tb.RS + 1;
      const hot = heat && EXHAUST_KINDS[tb.pipe.kind] ? tb.heat.array : null;
      for (let j = 0; j < tb.rings; j++) {
        const f = tb.frac[j], i0 = Math.floor(f), i1 = Math.min(S - 1, i0 + 1);
        const p0 = bin[po + 3 * i0] - (refP ? refP(o, off + 3 * i0) : pa), p1 = bin[po + 3 * i1] - (refP ? refP(o, off + 3 * i1) : pa);
        pressureColor((p0 + (p1 - p0) * (f - i0)) * 1e-5, tmpCol, 0);
        let q = j * per * 3;
        for (let k = 0; k < per; k++) { arr[q++] = tmpCol[0]; arr[q++] = tmpCol[1]; arr[q++] = tmpCol[2]; }
        if (hot) {
          const t0 = bin[po + 3 * i0 + 1], t1 = bin[po + 3 * i1 + 1];
          const h = Math.min(1, Math.max(0, (t0 + (t1 - t0) * (f - i0) - 800) / 550));
          hot.fill(h, j * per, (j + 1) * per);
        }
      }
      tb.col.needsUpdate = true;
      if (hot) tb.heat.needsUpdate = true;
    }
    for (const v of vols) {
      if (!v) continue;
      pressureColor((bin[o + v.offset] - (refP ? refP(o, v.offset) : pa)) * 1e-5, tmpCol, 0);
      v.mat.uniforms.uCol.value.set(tmpCol[0], tmpCol[1], tmpCol[2]);
    }
    if (plate) plate.rotation.z = Math.acos(Math.max(0, 1 - Math.min(1, thr)));
  }

  /** Free GPU resources owned by this model (shared metal and glass materials are kept). */
  dispose() {
    const shared = new Set([steel, darkSteel, alu, glass]);
    this.root.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material && !shared.has(obj.material)) obj.material.dispose();
      if (obj.isLight && obj.dispose) obj.dispose();
    });
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}

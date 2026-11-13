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
  const nIn = sp.in_valves === 1 ? 1 : 2, nEx = sp.ex_valves === 1 ? 1 : 2;
  const phi = (nIn * sp.in_valve_d * sp.in_valve_d + nEx * sp.ex_valve_d * sp.ex_valve_d) / (B * B);
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
    if (list.length === 2) {
      type = angDiff(H.pin_angle[list[0]], H.pin_angle[list[1]]) < 1 ? 'shared' : 'split';
      const o = type === 'shared' ? 0.105 * B : 0.20 * B;
      xoff[list[0]] = -o;
      xoff[list[1]] = o;
    } else if (list.length > 2) {
      // three or more cylinders on one crank position: a radial row. They all sit in one plane
      // and their rods meet on the one pin (drawn as a hub).
      type = 'hub';
    }
    return { xc, list, type };
  });
  const inline = sp.layout === 'inline', flat = sp.layout === 'flat';
  const radial = sp.layout === 'radial' || slotInfo.some((q) => q.type === 'hub');
  const exX = new V3(1, 0, 0);
  const cyl = [];
  for (let i = 0; i < n; i++) {
    // cylinder-axis angle from vertical, brought into -180..180 so its sign says which side it leans to
    const dir = (((H.bank_dir[i] + 180) % 360 + 360) % 360 - 180) * RAD;
    const a = new V3(0, Math.cos(dir), Math.sin(dir));
    const s = inline || radial ? 1 : (Math.sign(dir) || 1);
    const b = new V3(0, -Math.sin(dir) * s, Math.cos(dir) * s);
    const x = slotInfo[sp.slot[i]].xc + xoff[i];
    const base = new V3(x, 0, 0);
    const port = (sgn) => base.clone().addScaledVector(a, deck + 0.12 * B).addScaledVector(b, sgn * 0.2 * B);
    const kaEx = inline ? 0.8 : flat ? 0.2 : 0.4;
    const tEx = a.clone().multiplyScalar(kaEx).add(b).normalize();
    const uIn = (inline ? a.clone().multiplyScalar(0.6).addScaledVector(b, -0.8)
      : flat ? a.clone().multiplyScalar(0.25).addScaledVector(b, -1)
        : a.clone().addScaledVector(b, -0.35)).normalize();
    if (radial) {
      // exhaust leaves on one side of each head and sweeps back; intake comes from a hub behind the crankcase
      tEx.copy(a).multiplyScalar(0.3).addScaledVector(b, 0.5).addScaledVector(exX, 0.8).normalize();
      uIn.copy(exX).multiplyScalar(0.75).addScaledVector(a, -0.65).normalize();
    }
    cyl.push({ i, dir, a, b, s, x, exPort: port(1), inPort: port(-1), tEx, uIn });
  }
  const route = routePipes(H, cyl, B, { radial });
  return { ...route, sp, n, B, r, l, ch, skirt, hc, hcFull, recess, minGap, deck, pitch, slotInfo, cyl, radial, nIn, nEx };
}

/** Where every pipe and volume goes, given the engine's ports. `cyl` has one entry per
 *  cylinder (or rotor): x, a (up along the unit), b (exhaust side), exPort, inPort, tEx, uIn.
 *  `B` is a reference size (the bore) for stub lengths. */
function routePipes(H, cyl, B, opt = {}) {
  const sp = H.spec, n = cyl.length;
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
    const axis = opt.radial
      ? am.clone().normalize().multiplyScalar(0.45).addScaledVector(bm, 0.25).addScaledVector(ex, 1).normalize()   // radial: stacks point back and a little outward
      : bm.clone().addScaledVector(down, 0.8 * (1 - Math.max(0, bm.dot(down)))).normalize().addScaledVector(ex, 0.6).normalize();
    const row = ex.clone().addScaledVector(axis, -ex.dot(axis)).normalize();
    const nhat = new V3().crossVectors(row, axis).normalize();
    if (nhat.dot(bm.clone().add(am.normalize())) < 0) nhat.negate();
    const m = grp.length, pitchL = 2.9 * rp, ring = 0.5 * (m - 1) * pitchL;
    const clen = m === 1 ? 0.05 : Math.max(0.10, 1.2 * ring);
    const order = grp.slice().sort((p, q) => cyl[p].exPort.x - cyl[q].exPort.x);
    const laneOf = {};
    order.forEach((i, j) => { laneOf[i] = row.clone().multiplyScalar(j * pitchL - ring); });
    // as far out as the shortest pipe allows
    let c = mean.clone();
    for (let D = opt.radial ? 0.6 : 0.27; D >= 0.05; D -= 0.01) {
      c = mean.clone().addScaledVector(axis, D);
      if (grp.every((i) => primaryCurve(cyl[i], c.clone().add(laneOf[i]), axis, nhat, sp.primary_len[i], 0).getLength() <= sp.primary_len[i])) break;
    }
    volPos[vi] = c;
    collAxis[vi] = axis;
    collN[vi] = nhat;
    grp.forEach((i) => { primEnd[i] = c.clone().add(laneOf[i]); });
    volOut[vi] = c.clone().addScaledVector(axis, clen);
    volShape[vi] = { type: 'fan', a: ring + rp * (m === 1 ? 1.04 : 1.12), b: rp * (m === 1 ? 1.04 : 1.2), len: clen, ring, axis, d: row, n: nhat };
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
    let plenLen = len, plenR = R;
    if (opt.radial) {
      // an induction hub on the crank axis behind the cylinders, as far back as the runners reach
      plenLen = 0.14;
      plenR = Math.min(0.12, Math.max(0.04, Math.sqrt(H.volumes[plenumIdx].vol / (Math.PI * plenLen))));
      pc.set(xMax + 0.8 * sp.runner_len, 0, 0);
      for (let k = 0; k < 60 && !cyl.every((c) => c.inPort.distanceTo(pc) - plenR * 0.9 <= 0.88 * sp.runner_len); k++) pc.x -= 0.01;
    }
    volPos[plenumIdx] = pc;
    volShape[plenumIdx] = { type: 'capsule', r: plenR, len: plenLen, hub: !!opt.radial };
    const ai = volByName.airbox;
    if (ai !== undefined) {
      const side = Math.cbrt(H.volumes[ai].vol);
      if (opt.radial) {
        // air comes in from behind
        volPos[ai] = new V3(pc.x + plenLen / 2 + plenR + 0.10 + side / 2, pc.y, pc.z);
        volShape[ai] = { type: 'box', side, rear: true, neck: { x0: pc.x + plenLen / 2 + plenR * 0.5, x1: pc.x + plenLen / 2 + plenR + 0.10, r: sp.throttle_d / 2 } };
      } else {
        volPos[ai] = new V3(pc.x - len / 2 - R - 0.10 - side / 2, cy, cz);
        volShape[ai] = { type: 'box', side, neck: { x0: pc.x - len / 2 - R - 0.10, x1: pc.x - len / 2 - R * 0.5, r: sp.throttle_d / 2 } };
      }
    }
  }

  // ---- pipe paths
  const paths = H.pipes.map(() => null);
  const startPts = {}, endPts = {};
  pipesOf('runner').forEach(({ p, k }) => {
    const c = cyl[p.cyl];
    const end = c.inPort;
    if (p.left.type === 'volume' && p.left.index === plenumIdx) {
      const pc = volShape[plenumIdx].hub ? volPos[plenumIdx].clone() : new V3(c.x, volPos[plenumIdx].y, volPos[plenumIdx].z);
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
    const sgn = volShape[p.right.index].rear ? 1 : -1;
    const end = new V3(ab.x + sgn * side / 2, ab.y, ab.z);
    paths[k] = new THREE.LineCurve3(end.clone().addScaledVector(ex, sgn * p.len), end);
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
        const k1 = s.clone().addScaledVector(ax, Math.min(0.07, 0.2 * p.len)), k2 = s.clone().addScaledVector(ax, Math.min(0.13, 0.35 * p.len)).addScaledVector(ex, Math.min(0.12, 0.3 * p.len));
        return crv([s, k1, k2, k2.clone().addScaledVector(ex, 0.3 * L), k2.clone().addScaledVector(ex, L)]);
      }
      return crv([s, s.clone().add(new V3(0.12 * L, 0, 0.1 * zoff)), s.clone().add(new V3(0.32 * L, 0, zoff)), s.clone().add(new V3(L, 0, zoff))]);
    }, p.len);
  });

  return { primEnd, volOut, volPos, volShape, paths, startPts, endPts, plenumIdx, xMin, xMax };
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
  if (L.radial) {
    g.add(xCyl(Rm, xf - 0.75 * B, xf, steel));
    g.add(xCyl(0.42 * B, xf - 0.75 * B, xf - 0.62 * B, darkSteel, 48));
    g.add(xCyl(Rm, xr, xr + 0.22 * B, steel));
    return { group: g, pinMarkers, x0: xf - 0.75 * B, x1: xr + 0.22 * B };
  }
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
  // two valves per port side by side, or one larger valve on the centre line
  const one = (d) => c.s * Math.max(0.2 * B, 0.49 * B - 0.5 * d);
  const vin = L.nIn === 1 ? [mkValve(sp.in_valve_d, 0, -one(sp.in_valve_d))] : [mkValve(sp.in_valve_d, -0.21 * B, -zEx), mkValve(sp.in_valve_d, 0.21 * B, -zEx)];
  const vex = L.nEx === 1 ? [mkValve(sp.ex_valve_d, 0, one(sp.ex_valve_d))] : [mkValve(sp.ex_valve_d, -0.21 * B, zEx), mkValve(sp.ex_valve_d, 0.21 * B, zEx)];
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


// ---------------------------------------------------------------- Wankel rotary
// Plane normal to the shaft, coordinates (f, s): the housing bore is the two-lobe epitrochoid
// P(v) = (e cos 3v + R cos v, e sin 3v + R sin v), major axis along f. With shaft angle a the
// rotor centre is e (cos a, sin a) and its apexes are at centre + R (cos(a/3 + 2 pi m/3), ...),
// which puts each apex exactly on the bore at v = a/3 + 2 pi m/3. A chamber fires at v = 90 deg.
// Drawn with the major axis upright and the spark-plug side toward -Z: world = (x, f, -s), so
// a turn by phi in the (f, s) plane is rotation.x = -phi.
const trochoid = (e, R, v) => [e * Math.cos(3 * v) + R * Math.cos(v), e * Math.sin(3 * v) + R * Math.sin(v)];
/** Bore radius along the polar direction phi (the bore is star-shaped about the shaft). */
function boreRadius(e, R, phi) {
  let v = phi;
  for (let k = 0; k < 40; k++) {
    const p = trochoid(e, R, v);
    let d = Math.atan2(p[1], p[0]) - phi;
    d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    if (Math.abs(d) < 1e-13) break;
    v -= 0.9 * d;
  }
  const p = trochoid(e, R, v);
  return Math.hypot(p[0], p[1]);
}
/** One rotor flank in the rotor's own frame, from the apex at angle 0 to the apex at 120 deg:
 *  a circular arc through both apexes whose middle sits `mid` from the rotor centre. */
function flankArc(R, mid, N) {
  const h = R * Math.sin(Math.PI / 3), sag = mid - R / 2, ra = (h * h + sag * sag) / (2 * sag), cc = mid - ra, half = Math.asin(h / ra);
  const md = Math.PI / 3, out = [];
  for (let i = 0; i <= N; i++) {
    const t = md - half + 2 * half * i / N;
    out.push([cc * Math.cos(md) + ra * Math.cos(t), cc * Math.sin(md) + ra * Math.sin(t)]);
  }
  out[0] = [R, 0];
  out[N] = [R * Math.cos(2 * md), R * Math.sin(2 * md)];
  return out;
}
const CH_N = 28;   // segments along a chamber

export function buildWankelLayout(H) {
  const sp = H.spec, e = sp.ecc, R = sp.rotor_r, w = sp.rotor_w, nr = H.units || sp.rotor_phase.length;
  const plateT = 0.030, pitch = w + plateT, wall = 0.004;
  // The flank arc bulges to 1 mm short of the bore's waist; over a whole turn it then stays
  // at least 0.4 mm clear of the bore everywhere between the apexes.
  const flankMid = R - 2 * e - 0.001;
  // a port's two edges on the bore, degrees of v: [closing edge, opening edge]
  const edges = (p) => [(30 + p[1] / 3) % 360, (150 + p[0] / 3) % 360];
  const signed = (a, b) => ((b - a) % 360 + 540) % 360 - 180;
  const exE = edges(sp.port_ex), inE = edges(sp.port_in);
  const vEx = (exE[0] + 0.5 * signed(exE[0], exE[1])) * RAD, vIn = (inE[0] + 0.5 * signed(inE[0], inE[1])) * RAD;
  const sidePort = /side/i.test(sp.label) || (sp.port_in[1] - sp.port_in[0]) < 330;
  const world = (x, f, s) => new V3(x, f, -s);
  const cyl = [];
  for (let j = 0; j < nr; j++) {
    const x = (j - (nr - 1) / 2) * pitch;
    const pe = trochoid(e, R, vEx), le = Math.hypot(pe[0], pe[1]), re = [pe[0] / le, pe[1] / le];
    const b = world(0, re[0], re[1]);
    const exPort = world(x, pe[0] + re[0] * wall, pe[1] + re[1] * wall);
    let inPort, uIn;
    if (sidePort) {
      // a window in the side housing; the runner comes in from that side
      // (always the rear face, so no runner crosses the front of the engine)
      const side = 1, rp = 0.70 * R;
      inPort = world(x + side * (w / 2 + 0.008), rp * Math.cos(vIn), rp * Math.sin(vIn));
      uIn = new V3(side * 0.75, 0.6, 0.3).normalize();
    } else {
      const pi = trochoid(e, R, vIn), li = Math.hypot(pi[0], pi[1]), ri = [pi[0] / li, pi[1] / li];
      inPort = world(x, pi[0] + ri[0] * wall, pi[1] + ri[1] * wall);
      uIn = world(0, ri[0], ri[1]);
    }
    cyl.push({ i: j, x, dir: 0, s: 1, a: new V3(0, 1, 0), b, exPort, inPort, tEx: b.clone(), uIn });
  }
  const route = routePipes(H, cyl, 0.09);
  return { ...route, kind: 'wankel', sp, n: nr, nr, e, R, w, pitch, plateT, flankMid, exE, inE, vEx, vIn, sidePort, cyl };
}

function buildWankel(L, opts) {
  const { e, R, w, nr } = L;
  const g = new THREE.Group();
  const NB = 180, wr = 0.93 * w, bev = 0.0016;
  const world = (x, f, s) => new V3(x, f, -s);
  const bore = [...Array(NB)].map((_, i) => trochoid(e, R, 2 * Math.PI * i / NB));
  const outer = bore.map((p, i) => {
    // push outward along the curve normal for the housing's outside line
    const q = bore[(i + 1) % NB], o = bore[(i + NB - 1) % NB];
    const tx = q[0] - o[0], ty = q[1] - o[1], tl = Math.hypot(tx, ty);
    return [p[0] + 0.020 * ty / tl, p[1] - 0.020 * tx / tl];
  });
  const loop = (pts, x, rad, mat) => {
    const c = new THREE.CatmullRomCurve3(pts.map((p) => world(x, p[0], p[1])), true, 'centripetal');
    return new THREE.Mesh(new THREE.TubeGeometry(c, NB, rad, 6, true), mat);
  };
  const flank0 = flankArc(R, L.flankMid, CH_N);
  const seal = new THREE.MeshStandardMaterial({ color: 0xe6e9ee, metalness: 1.0, roughness: 0.16 });
  const rotorMat = new THREE.MeshStandardMaterial({ color: 0xaeb4bd, metalness: 1.0, roughness: 0.34 });
  const faceMat = new THREE.MeshBasicMaterial({ color: 0x4a6590, transparent: true, opacity: 0.10, depthWrite: false, side: THREE.DoubleSide });
  const housingGlass = new THREE.MeshStandardMaterial({ color: 0xb9d4ff, metalness: 0.0, roughness: 0.25, envMapIntensity: 0.3, transparent: true, opacity: 0.045, depthWrite: false, side: THREE.DoubleSide });
  // rotor outline: three flanks, with the bearing bore cut out
  const shape = new THREE.Shape();
  for (let m = 0; m < 3; m++) {
    const cs = Math.cos(2 * Math.PI * m / 3), sn = Math.sin(2 * Math.PI * m / 3);
    flank0.forEach((p, i) => {
      if (i === CH_N) return;
      const f = p[0] * cs - p[1] * sn, s = p[0] * sn + p[1] * cs;
      if (m === 0 && i === 0) shape.moveTo(f, s); else shape.lineTo(f, s);
    });
  }
  shape.closePath();
  const rb = 0.052;
  const hole = new THREE.Path();
  hole.absarc(0, 0, rb, 0, 2 * Math.PI, true);
  shape.holes.push(hole);
  const rotorGeo = new THREE.ExtrudeGeometry(shape, { depth: wr - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 2, curveSegments: 48 });
  // extrusion (f, s, depth) -> world (x = -depth, y = f, z = -s), centred on the rotor's plane
  rotorGeo.applyMatrix4(new THREE.Matrix4().set(0, 0, -1, 0.5 * wr - bev, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 1));
  rotorGeo.computeVertexNormals();
  const sealPts = [];
  for (let m = 0; m < 3; m++) {
    const cs = Math.cos(2 * Math.PI * m / 3), sn = Math.sin(2 * Math.PI * m / 3);
    for (let i = 0; i < CH_N; i += 2) { const p = flank0[i], k = 1 - 0.007 / Math.hypot(p[0], p[1]); sealPts.push([(p[0] * cs - p[1] * sn) * k, (p[0] * sn + p[1] * cs) * k]); }
  }
  const rotors = [];
  const xs = L.cyl.map((c) => c.x);
  const x0 = xs[0] - w / 2 - 0.085, x1 = xs[nr - 1] + w / 2 + 0.10;
  for (let j = 0; j < nr; j++) {
    const x = xs[j];
    // housing: glass bore wall, bright bore edges, a fainter outside line
    const pos = [], idx = [];
    for (let i = 0; i <= NB; i++) {
      const p = bore[i % NB];
      pos.push(x - w / 2, p[0], -p[1], x + w / 2, p[0], -p[1]);
      if (i < NB) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    wg.setIndex(idx);
    wg.computeVertexNormals();
    const wallMesh = new THREE.Mesh(wg, housingGlass);
    wallMesh.renderOrder = 2;
    g.add(wallMesh);
    // outside wall (glass) and the cut faces of the housing between bore and outside line
    const og = new THREE.BufferGeometry(), opos = [], fpos = [], fidx = [];
    for (let i = 0; i <= NB; i++) {
      const p = outer[i % NB], q = bore[i % NB];
      opos.push(x - w / 2, p[0], -p[1], x + w / 2, p[0], -p[1]);
      for (const sx of [-1, 1]) fpos.push(x + sx * w / 2, q[0], -q[1], x + sx * w / 2, p[0], -p[1]);
      if (i < NB) { const a4 = 4 * i; fidx.push(a4, a4 + 1, a4 + 4, a4 + 1, a4 + 5, a4 + 4, a4 + 2, a4 + 6, a4 + 3, a4 + 3, a4 + 6, a4 + 7); }
    }
    og.setAttribute('position', new THREE.Float32BufferAttribute(opos, 3));
    og.setIndex(idx);
    og.computeVertexNormals();
    const outerMesh = new THREE.Mesh(og, housingGlass);
    outerMesh.renderOrder = 2;
    g.add(outerMesh);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
    fg.setIndex(fidx);
    fg.computeVertexNormals();
    const faceMesh = new THREE.Mesh(fg, faceMat);
    faceMesh.renderOrder = 2;
    g.add(faceMesh);
    for (const sx of [-1, 1]) {
      g.add(loop(bore, x + sx * w / 2, 0.0026, alu));
      g.add(loop(outer, x + sx * w / 2, 0.0016, darkSteel));
    }
    // spark plugs, leading and trailing, either side of the firing position
    for (const dv of [-14, 14]) {
      const v = (90 + dv) * RAD, p = trochoid(e, R, v), pl = Math.hypot(p[0], p[1]);
      const plug = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.05, 12), steel);
      const dirw = world(0, p[0] / pl, p[1] / pl);
      plug.quaternion.setFromUnitVectors(new V3(0, 1, 0), dirw);
      plug.position.copy(world(x, p[0], p[1])).addScaledVector(dirw, 0.03);
      g.add(plug);
    }
    // side intake port: its window in the side housing
    if (L.sidePort) {
      const side = 1, a0 = Math.min(L.inE[0], L.inE[1]) * RAD, a1 = Math.max(L.inE[0], L.inE[1]) * RAD;
      const pts = [];
      for (let i = 0; i <= 10; i++) { const v = a0 + (a1 - a0) * i / 10; pts.push([0.84 * R * Math.cos(v), 0.84 * R * Math.sin(v)]); }
      for (let i = 10; i >= 0; i--) { const v = a0 + (a1 - a0) * i / 10; pts.push([0.56 * R * Math.cos(v), 0.56 * R * Math.sin(v)]); }
      const c = new THREE.CatmullRomCurve3(pts.map((p) => world(x + side * w / 2, p[0], p[1])), true, 'catmullrom', 0.1);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(c, 80, 0.0018, 6, true), alu));
    }
    // rotor
    const rot = new THREE.Group();
    rot.add(new THREE.Mesh(rotorGeo, rotorMat));
    const apex = [], mid = [];
    for (let m = 0; m < 3; m++) {
      const th = 2 * Math.PI * m / 3;
      const strip = new THREE.Mesh(new THREE.BoxGeometry(wr * 1.02, 0.007, 0.0032), seal);
      strip.position.copy(world(0, (R - 0.0035) * Math.cos(th), (R - 0.0035) * Math.sin(th)));
      strip.rotation.x = -th;
      rot.add(strip);
      const am = new THREE.Object3D(); am.position.copy(world(0, R * Math.cos(th), R * Math.sin(th))); rot.add(am); apex.push(am);
      const mm = new THREE.Object3D(); mm.position.copy(world(0, L.flankMid * Math.cos(th + Math.PI / 3), L.flankMid * Math.sin(th + Math.PI / 3))); rot.add(mm); mid.push(mm);
    }
    for (const sx of [-1, 1]) {
      // side-seal groove following the flanks, a little way in from the edge
      const sealLoop = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(sealPts.map((p) => world(sx * 0.5 * wr, p[0], p[1])), true, 'centripetal'), 150, 0.0011, 5, true), darkSteel);
      rot.add(sealLoop);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(rb + 0.006, 0.003, 8, 48), darkSteel);
      ring.rotation.y = Math.PI / 2;
      ring.position.x = sx * 0.5 * wr;
      rot.add(ring);
    }
    g.add(rot);
    // eccentric journal on the shaft
    const ecc = new THREE.Group();
    ecc.position.x = x;
    const jr = xCyl(rb - 0.002, -0.47 * w, 0.47 * w, steel, 40);
    jr.position.y = e;
    ecc.add(jr);
    g.add(ecc);
    // three working chambers: the space between a flank and the bore, rebuilt every frame
    const chambers = [];
    for (let k = 0; k < 3; k++) {
      const cg = new THREE.BufferGeometry();
      const cp = new THREE.BufferAttribute(new Float32Array((CH_N + 1) * 4 * 3), 3);
      cp.setUsage(THREE.DynamicDrawUsage);
      cg.setAttribute('position', cp);
      const ci = [];
      for (let i = 0; i < CH_N; i++) {
        const a = 4 * i, b = 4 * (i + 1);
        ci.push(a, a + 1, b, a + 1, b + 1, b, a + 2, b + 2, a + 3, a + 3, b + 2, b + 3, a, b, a + 2, a + 2, b, b + 2, a + 1, a + 3, b + 1, a + 3, b + 3, b + 1);
      }
      cg.setIndex(ci);
      const mat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(cg, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      g.add(mesh);
      chambers.push({ mesh, mat, pos: cp });
    }
    const light = new THREE.PointLight(0xffb070, 0, opts.lightRange || 0.7, 2);
    g.add(light);
    rotors.push({ x, rot, ecc, chambers, light, apex, mid });
  }
  // shaft, front pulley, flywheel
  g.add(xCyl(0.021, x0, x1, steel));
  g.add(xCyl(0.030, x0, x0 + 0.018, darkSteel, 40));
  g.add(xCyl(0.118, x1 - 0.024, x1, darkSteel, 64));
  return { group: g, rotors, x0, x1, flank0 };
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
    const wankel = H.kind === 'wankel';
    this.kind = wankel ? 'wankel' : 'piston';
    const L = wankel ? buildWankelLayout(H) : buildLayout(H);
    const { B, deck } = L;
    const root = new THREE.Group();
    const engine = new THREE.Group();
    root.add(engine);
    const rotary = wankel ? buildWankel(L, opts) : null;
    if (rotary) engine.add(rotary.group);
    const crank = wankel ? { x0: rotary.x0, x1: rotary.x1, pinMarkers: [] } : buildCrank(L, H);
    if (!wankel) engine.add(crank.group);
    const cyls = wankel ? [] : L.cyl.map((c) => {
      const o = buildCylinder(L, c);
      engine.add(o.group);
      // a light in the chamber, so a firing cylinder lights the parts around it
      o.light = new THREE.PointLight(0xffb070, 0, opts.lightRange || 0.7, 2);
      o.light.position.y = deck - 0.01;
      o.group.add(o.light);
      return o;
    });
    const rods = wankel ? [] : L.cyl.map(() => { const o = buildRod(L); engine.add(o.group); return o; });

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
    if (wankel) {
      const hr = L.R + L.e + 0.03;
      boxEng.expandByPoint(new V3(crank.x0, -hr, -(L.R - L.e) - 0.06)).expandByPoint(new V3(crank.x1, hr, (L.R - L.e) + 0.03));
    } else {
      for (const c of L.cyl) {
        const top = new V3(c.x, 0, 0).addScaledVector(c.a, deck + 0.3 * B);
        for (const pt of [top.clone().addScaledVector(c.b, 0.5 * B), top.clone().addScaledVector(c.b, -0.5 * B)]) boxEng.expandByPoint(pt);
      }
      boxEng.expandByPoint(new V3(crank.x0, -1.1 * B, -1.1 * B)).expandByPoint(new V3(crank.x1, 1.1 * B, 1.1 * B));
    }
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
    Object.assign(this, { rotary, root, L, sp, crank, cyls, rods, tubes, vols, plate, boxEng, boxAll, ptsCore, ptsEng, ptsAll, pipeMat, ghostPipeMat });
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
    if (this.rotary) this.updateRotary(bin, co);
    else crank.group.rotation.x = -(bin[co + 5] + sp.firing[0] * RAD);
    for (let k = 0; k < (this.rotary ? 0 : n); k++) {
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

  /** Shaft angle of rotor j for the frame at cylinder-block offset `co`: chamber 0's angle since
   *  firing, plus the 90 degrees that centres a firing chamber on the plug side (v = 90 deg). */
  rotorAngle(bin, co, j) {
    return bin[co + 6 * 3 * j + 5] + 0.5 * Math.PI;
  }
  /** Which pair of apexes (m, m+1) bounds chamber k of rotor j in this frame. */
  chamberApex(bin, co, j, k) {
    const d = (bin[co + 6 * (3 * j + k) + 5] - bin[co + 6 * 3 * j + 5]) / (2 * Math.PI);
    return ((Math.round(d) % 3) + 3) % 3;
  }
  updateRotary(bin, co) {
    const { L, rotary } = this, { e, R, w } = L, tmpCol = this._tmp, F = rotary.flank0, wg = 0.90 * w;
    for (let j = 0; j < L.nr; j++) {
      const ro = rotary.rotors[j], a = this.rotorAngle(bin, co, j);
      const cf = e * Math.cos(a), cs = e * Math.sin(a);
      ro.ecc.rotation.x = -a;
      ro.rot.position.set(ro.x, cf, -cs);
      ro.rot.rotation.x = -a / 3;
      let best = 0, bv = 0;
      for (let k = 0; k < 3; k++) {
        const q = co + 6 * (3 * j + k), ch = ro.chambers[k];
        const p = bin[q], T = bin[q + 1], burn = bin[q + 4];
        const v0 = a / 3 + 2 * Math.PI * this.chamberApex(bin, co, j, k) / 3, c0 = Math.cos(v0), s0 = Math.sin(v0);
        const arr = ch.pos.array;
        for (let i = 0; i <= CH_N; i++) {
          const v = v0 + (2 * Math.PI / 3) * i / CH_N;
          // bore side, pulled in a hair so the glow sits inside the glass
          const hf = (e * Math.cos(3 * v) + R * Math.cos(v)) * 0.992, hs = (e * Math.sin(3 * v) + R * Math.sin(v)) * 0.992;
          const ff = cf + F[i][0] * c0 - F[i][1] * s0, fs = cs + F[i][0] * s0 + F[i][1] * c0;
          const t = 12 * i;
          arr[t] = ro.x - wg / 2; arr[t + 1] = hf; arr[t + 2] = -hs;
          arr[t + 3] = ro.x - wg / 2; arr[t + 4] = ff; arr[t + 5] = -fs;
          arr[t + 6] = ro.x + wg / 2; arr[t + 7] = hf; arr[t + 8] = -hs;
          arr[t + 9] = ro.x + wg / 2; arr[t + 10] = ff; arr[t + 11] = -fs;
        }
        ch.pos.needsUpdate = true;
        const tt = Math.min(1, Math.max(0, (T - 500) / 2200));
        ramp(GLOW, tt, tmpCol, 0);
        // same recipe as a cylinder, lifted a little so compression and expansion read around the housing
        const gain = 0.03 + 2.2 * Math.pow(Math.min(1, p / 5.0e6), 0.65) + 1.3 * Math.min(1, burn / 2.0);
        ch.mat.color.setRGB(tmpCol[0] * gain, tmpCol[1] * gain, tmpCol[2] * gain);
        if (gain > best) { best = gain; bv = v0 + Math.PI / 3; }
      }
      // one light per rotor, in its brightest chamber
      ro.light.intensity = (this.opts.lightGain || 0.10) * Math.max(0, best - 0.15);
      ro.light.position.set(ro.x, 0.8 * (e * Math.cos(3 * bv) + R * Math.cos(bv)), -0.8 * (e * Math.sin(3 * bv) + R * Math.sin(bv)));
    }
  }
  /** Geometry checks for one rotary frame (call after update and updateMatrixWorld). Tracks the
   *  worst apex-to-bore distance, chamber-centre error and flank-to-bore clearance in `out`. */
  checkRotary(bin, co, out) {
    const { L, rotary } = this, { e, R } = L, p = this._P;
    for (let j = 0; j < L.nr; j++) {
      const ro = rotary.rotors[j], a = this.rotorAngle(bin, co, j);
      for (let m = 0; m < 3; m++) {
        ro.apex[m].getWorldPosition(p);
        const h = trochoid(e, R, a / 3 + 2 * Math.PI * m / 3);
        out.apexToBore = Math.max(out.apexToBore, Math.hypot(p.y - h[0], -p.z - h[1]), Math.abs(p.x - ro.x));
        ro.mid[m].getWorldPosition(p);
        out.minFlankClearance = Math.min(out.minFlankClearance, boreRadius(e, R, Math.atan2(-p.z, p.y)) - Math.hypot(p.y, p.z));
      }
      for (let k = 0; k < 3; k++) {
        // centre of the chamber as drawn: midway (in v) between its two apex markers
        const m = this.chamberApex(bin, co, j, k);
        ro.apex[m].getWorldPosition(p);
        const va = Math.atan2(-p.z - e * Math.sin(a), p.y - e * Math.cos(a));   // direction from the rotor centre = the apex's v
        const want = 90 + bin[co + 6 * (3 * j + k) + 5] / RAD / 3;
        const d = ((va / RAD + 60 - want) % 360 + 540) % 360 - 180;
        out.chamberCentreDeg = Math.max(out.chamberCentreDeg, Math.abs(d));
      }
      for (const ch of ro.chambers) for (const v of ch.pos.array) if (!Number.isFinite(v)) out.nan++;
    }
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

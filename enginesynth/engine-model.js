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
  // A two-stroke has no poppet valves: its ports are holes in the liner that the piston uncovers.
  const two = H.kind === 'two_stroke';
  let minGap = Infinity;
  if (!two) for (let c = 0; c < 4 * Math.PI; c += Math.PI / 720) minGap = Math.min(minGap, valveGap(c));
  const margin = 0.0008;
  const nIn = two ? 0 : sp.in_valves === 1 ? 1 : 2, nEx = two ? 0 : sp.ex_valves === 1 ? 1 : 2;
  const phi = (nIn * sp.in_valve_d * sp.in_valve_d + nEx * sp.ex_valve_d * sp.ex_valve_d) / (B * B);
  let recess = 0, hc = hcFull;
  if (hcFull + minGap < margin) {
    recess = Math.min((margin - minGap - hcFull) / (1 - phi), 0.92 * hcFull / phi);
    hc = hcFull - recess * phi;
  }
  const deck = r + l + ch + hc;
  // two-stroke ports, as heights along the cylinder axis from the crank: each port's top edge is
  // where the piston crown is at the crank angle the port opens (degrees after TDC), so the
  // drawn piston uncovers it exactly when the simulator opens it; the bottom edge is the crown at BDC
  const crownAt = (deg) => { const c = deg * RAD; return r * Math.cos(c) + Math.sqrt(l * l - r * r * Math.sin(c) * Math.sin(c)) + ch; };
  const ports = two ? {
    exTop: crownAt(sp.ex_port_open), trTop: crownAt(sp.tr_port_open), bottom: crownAt(180),
    inY: (l - r) - 0.25 * B, wall: 0.505 * B,
  } : null;
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
    let exPort = port(1), inPort = port(-1);
    if (two) {
      // exhaust leaves the side of the barrel at the middle of its port; air enters the crankcase
      // behind the cylinder (reed or piston port)
      exPort = base.clone().addScaledVector(a, 0.5 * (ports.exTop + ports.bottom)).addScaledVector(b, ports.wall + 0.012);
      inPort = base.clone().addScaledVector(a, ports.inY).addScaledVector(b, -(0.62 * B));
      tEx.copy(b);
      uIn.copy(b).multiplyScalar(-1).addScaledVector(a, 0.35).normalize();
    }
    cyl.push({ i, dir, a, b, s, x, exPort, inPort, tEx, uIn });
  }
  const route = routePipes(H, cyl, B, { radial });
  return { ...route, sp, n, B, r, l, ch, skirt, hc, hcFull, recess, minGap, deck, pitch, slotInfo, cyl, radial, nIn, nEx, two, ports };
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
  // On a turbo engine whose collectors are the turbine scrolls (no merged turbine inlet), each
  // collector points straight down and out from its bank, with no rearward sweep: the turbine
  // housing hangs off its end with the shaft along the crank (see the turbocharger section below).
  const scrollColl = volByName.turbine_out !== undefined && volByName.turbine_in === undefined;
  sp.groups.forEach((grp, g) => {
    const vi = volByName[`collector${g + 1}`];
    if (vi === undefined || !grp.length) return;
    // a collector no pipe enters (an engine whose every primary ends in open air) is not drawn
    if (!H.pipes.some((q) => q.kind === 'primary' && q.right.type === 'volume' && q.right.index === vi)) return;
    const mean = new V3(), bm = new V3(), am = new V3();
    // weight toward the cylinders with the shortest pipes, so unequal headers stay drawable
    let wsum = 0;
    grp.forEach((i) => { const w = Math.pow(sp.primary_len[i], -3); wsum += w; mean.addScaledVector(cyl[i].exPort, w); bm.add(cyl[i].b); am.add(cyl[i].a); });
    mean.multiplyScalar(1 / wsum);
    bm.normalize();
    // swept back about 30 degrees so the gas leaves heading rearward
    const axis = opt.radial
      ? am.clone().normalize().multiplyScalar(0.45).addScaledVector(bm, 0.25).addScaledVector(ex, 1).normalize()   // radial: stacks point back and a little outward
      : scrollColl ? bm.clone().addScaledVector(down, (bm.dot(down) > 0.3 ? 0.5 : 1.0) * (1 - Math.max(0, bm.dot(down)))).normalize()   // an inline's collector points well down, so its turbo hangs below the header
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
    for (let D = opt.radial ? 0.6 : scrollColl ? 0.16 : 0.27; D >= 0.05; D -= 0.01) {
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
      // a second turbo's own air filter box, beside the first (drawn, not measured)
      const a2 = volByName.airbox_t2;
      if (a2 !== undefined) {
        volPos[a2] = volPos[ai].clone().add(new V3(-0.15 * side, -0.1, 1.3 * side));
        volShape[a2] = { type: 'box', side, rear: volShape[ai].rear };
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
  // Primaries that end in open air (two-stroke expansion chambers): each drops from its port to its
  // own lane below and beside the crank, then runs straight back. The pipe from the front cylinder
  // takes the outermost lane, so no pipe has to cross another; lanes are spaced by the pipes' widest
  // sections. The straight run is as long as the pipe's physical length requires.
  const open = pipesOf('primary').filter(({ p }) => p.right.type !== 'volume');
  if (open.length) {
    const rmax = (p) => 0.5 * Math.max(...p.dia);
    const order = open.slice().sort((e1, e2) => cyl[e2.p.cyl].x - cyl[e1.p.cyl].x);   // rear first = innermost
    const rAll = Math.max(...open.map(({ p }) => rmax(p)));
    let D = 0;
    order.forEach(({ p, k }, j) => {
      const c = cyl[p.cyl], rm = rmax(p);
      D = j === 0 ? 0.55 * B + rm : D + rm + rmax(order[j - 1].p) + 0.012;
      const yLane = -(sp.stroke / 2 + 0.3 * B) - 0.5 * rAll;
      const lane = (X) => new V3(X, 0, 0).addScaledVector(c.b, D).addScaledVector(c.a, yLane);
      const start = c.exPort, p1 = start.clone().addScaledVector(c.b, 0.05);
      const x0 = c.x + 0.05;
      const make = (X) => {
        const pts = [start, p1, lane(x0), lane(x0 + 0.12)];
        if (X > x0 + 0.24) pts.push(lane(X));
        return crv(pts);
      };
      let lo = x0 + 0.25, hi = x0 + 0.25 + 2 * p.len;
      for (let it = 0; it < 40; it++) { const m = 0.5 * (lo + hi); if (make(m).getLength() < p.len) lo = m; else hi = m; }
      paths[k] = make(0.5 * (lo + hi));
      startPts[k] = start;
      endPts[k] = paths[k].getPointAt(1);
    });
  }
  pipesOf('primary').forEach(({ p, k }) => {
    if (p.right.type !== 'volume') return;
    const c = cyl[p.cyl], start = c.exPort, end = primEnd[p.cyl];
    paths[k] = fitCurve((beta) => primaryCurve(c, end, collAxis[p.right.index], collN[p.right.index], p.len, beta), p.len);
    startPts[k] = start;
    endPts[k] = end;
  });
  // merge volume sits behind the collectors, on the centre line between them (a turbo's merged
  // turbine inlet is drawn the same way)
  const mergeIdx = volByName.merge ?? volByName.turbine_in;
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
  // ---- forced induction. Every part drawn here is a simulated element (volume, pipe, compressor,
  // turbine, shaft, intercooler, throttle, blower rotors); where it sits is a drawing choice made
  // from the layout of the real engines (viz/README.md says which positions are sourced).
  const boost = { turbos: [], coolers: [], blower: null };
  const xFront = xMin - 0.75 * B;   // about where the crank's front pulley is
  const capsuleR = (V, len) => { let r = Math.sqrt(V / (Math.PI * len)); for (let k = 0; k < 30; k++) r = Math.sqrt(V / (Math.PI * (len + 4 * r / 3))); return r; };
  const plenumFront = () => (plenumIdx !== undefined && volShape[plenumIdx] ? volPos[plenumIdx].x - volShape[plenumIdx].len / 2 - volShape[plenumIdx].r : xFront);
  // Boost pipes are drawn as tubing: straight runs joined by bends of about radius r (each corner
  // replaced by a short fillet), routed low and close to the engine; spare length is taken up by
  // moving a corner along the engine or the bay, never by bowing out into open air.
  const bendPath = (ws, r = 0.05) => {
    const pts = [ws[0]];
    for (let i = 1; i < ws.length - 1; i++) {
      const a = ws[i - 1], q = ws[i], b = ws[i + 1];
      const din = q.clone().sub(a), dout = b.clone().sub(q), li = din.length(), lo = dout.length();
      if (li < 1e-6 || lo < 1e-6) continue;
      const rr = Math.min(r, 0.45 * li, 0.45 * lo);
      din.multiplyScalar(1 / li); dout.multiplyScalar(1 / lo);
      pts.push(q.clone().addScaledVector(din, -rr), q.clone().addScaledVector(din, -0.3 * rr).addScaledVector(dout, 0.3 * rr), q.clone().addScaledVector(dout, rr));
    }
    pts.push(ws[ws.length - 1]);
    return crv(pts);
  };
  const routePipe = (k, len, make) => { paths[k] = fitCurve((beta) => bendPath(make(beta)), len); startPts[k] = paths[k].getPointAt(0); endPts[k] = paths[k].getPointAt(1); };
  const yLow = -(1.1 * B + 0.03);      // just under the crankcase
  const fitPipe = (k, len, a, ta, b, tb, bow) => {
    // a gentle bend from a (leaving along ta) to b (arriving along tb), bowed along `bow` until its
    // drawn length is the pipe's physical length (or as short as the ends allow)
    const d = a.distanceTo(b), s = Math.min(0.09, 0.3 * d);
    const a1 = a.clone().addScaledVector(ta, s), b1 = b.clone().addScaledVector(tb, -s);
    paths[k] = fitCurve((beta) => crv([a, a1, a1.clone().lerp(b1, 0.5).addScaledVector(bow, beta), b1, b]), len);
    startPts[k] = a; endPts[k] = b;
  };
  // ---- turbochargers (engines with `boost.kind == "turbo"`). Each turbo is drawn as it is built:
  // a turbine housing (a snail-shell volute) fed tangentially by its bank's collector, a centre
  // section on the shaft, and a compressor housing on the same shaft, ahead of the turbine, its
  // inlet facing forward to its air filter box and its outlet leaving tangentially to the charge
  // pipe. The turbine volute is part of the collector volume (the simulator adds the volute's
  // volume to the turbine inlet) and is coloured by it; the turbine outlet volume is the short can
  // behind the turbine; the compressor outlet volume is the compressor volute. Parallel twin
  // turbos: the second turbo's parts carry the tag "_t2" and take the second bank's collector.
  const tTags = ['', '_t2'].filter((tg) => volByName[`turbine_out${tg}`] !== undefined);
  if (tTags.length) {
    const twin = tTags.length > 1;
    const T = H.turbo || {};
    const rw = 0.5 * (T.d2 || 0.05);           // compressor wheel radius (header: d2)
    const tsp = (sp.boost && sp.boost.turbo) || {};
    const rwT = 0.5 * (tsp.turbine_d || 0.9 * 2 * rw);   // turbine wheel radius (the definition's derived size)
    const chargeR = 0.5 * Math.max(0.03, ...pipesOf('charge').map(({ p }) => p.dia[0]));
    const ax = new V3(-1, 0, 0);               // shaft axis, from the turbine toward the compressor (forward)
    const e1 = new V3(0, 1, 0), e2 = new V3(0, 0, 1);   // the volutes' plane (normal to the shaft)
    // throttle: the charge pipes meet in the throttle inlet volume at the front of the plenum; the
    // throttle body (its plate turns with the throttle) joins it to the plenum
    const ti = volByName.throttle_in;
    const ai = volByName.airbox;
    if (ai !== undefined && volShape[ai]) delete volShape[ai].neck;   // the air filter feeds the compressor, not the plenum
    let tiPos = null, tiR = 0;
    if (ti !== undefined && plenumIdx !== undefined) {
      const pc = volPos[plenumIdx], ps = volShape[plenumIdx];
      tiR = Math.cbrt(3 * H.volumes[ti].vol / (4 * Math.PI));
      const x1 = pc.x - ps.len / 2 - ps.r * 0.5, x0 = x1 - 0.07;
      tiPos = new V3(x0 - 0.8 * tiR, pc.y, pc.z);
      volPos[ti] = tiPos;
      volShape[ti] = { type: 'sphere', r: tiR, neck: { x0: x0 - 0.2 * tiR, x1, r: sp.throttle_d / 2 } };
    }
    // a housing's spiral: given the open end X of its tangential port and the direction T pointing
    // out of that port, and which way the spiral turns (h), where its centre goes
    const voluteAt = (X, Tout, h, Rh, r1, exitLen) => {
      const t1 = Tout.dot(e1), t2 = Tout.dot(e2);
      const n = e1.clone().multiplyScalar(h * t2).addScaledVector(e2, -h * t1).normalize();
      const C = X.clone().addScaledVector(Tout, -exitLen).addScaledVector(n, -(Rh + r1));
      return { C, phiEnd: Math.atan2(n.dot(e2), n.dot(e1)) };
    };
    tTags.forEach((tg, j) => {
      const yIdx = volByName[`turbine_out${tg}`];
      const xIn = volByName[`turbine_in${tg}`] ?? volByName[`collector${j + 1}`];
      const E = (volOut[xIn] || volPos[xIn] || new V3(xMax + 0.2, -0.1, 0.2)).clone();
      // flow direction into the turbine, in the volute's plane
      const d = (collAxis[xIn] || new V3(0, -1, 0)).clone().addScaledVector(ax, -(collAxis[xIn] || new V3(0, -1, 0)).dot(ax));
      if (d.lengthSq() < 0.05) d.set(0, -1, 0);
      d.normalize();
      const side = Math.sign(E.z) || (j ? -1 : 1);
      // turbine housing: its inlet is the collector's outlet; of the two ways the spiral can turn,
      // the one that tucks the housing lower
      const turb = { Rh: 1.2 * rwT, r0: 0.28 * rwT, r1: 0.68 * rwT, rPort: volShape[xIn] && volShape[xIn].b ? volShape[xIn].b : 0.7 * rwT, exitLen: 0.035, sweep: 5.6 };
      const cand = [1, -1].map((h) => ({ h, ...voluteAt(E, d.clone().negate(), h, turb.Rh, turb.r1, turb.exitLen) }));
      const score = (q) => Math.abs(q.C.y) + Math.abs(q.C.z) + (Math.abs(q.C.z) - (turb.Rh + 2 * turb.r1) < 1.1 * B ? 10 : 0);   // never into the crankcase
      const tv = score(cand[0]) <= score(cand[1]) ? cand[0] : cand[1];
      Object.assign(turb, tv, { e1, e2, ax, X: E });
      // centre section, then the compressor housing ahead on the same shaft; its spiral turns the
      // other way (the wheels share one rotation; flow spirals outward in the compressor and
      // inward in the turbine), and its outlet leaves outboard and up
      const comp = { Rh: 1.25 * rw, r0: 0.25 * rw, r1: 0.7 * rw, rPort: chargeR, exitLen: 0.04, sweep: 5.6 };
      const Lc = 1.7 * rw;
      const Cc = tv.C.clone().addScaledVector(ax, turb.r1 + Lc + comp.r1);
      // outlet: outboard and down, so its charge pipe drops and runs forward low along the bay
      const u = new V3(0, -0.5, side).normalize();
      const hC = -tv.h;
      const nC = e1.clone().multiplyScalar(hC * u.dot(e2)).addScaledVector(e2, -hC * u.dot(e1)).normalize();
      const Xc = Cc.clone().addScaledVector(nC, comp.Rh + comp.r1).addScaledVector(u, comp.exitLen);
      Object.assign(comp, { C: Cc, h: hC, phiEnd: Math.atan2(nC.dot(e2), nC.dot(e1)), e1, e2, ax, X: Xc, u });
      // the turbine housing belongs to the collector volume (drawn with it); the compressor housing is comp_out
      if (volShape[xIn]) volShape[xIn].volute = { ...turb, C: tv.C.clone().sub(volPos[xIn]) };
      const ci = volByName[`comp_out${tg}`];
      if (ci !== undefined) {
        volPos[ci] = Cc.clone();
        volShape[ci] = { type: 'volute', ...comp, C: new V3() };
      }
      // turbine outlet: a can behind the turbine, along the shaft; the downpipe leaves its end
      const rCan = Math.max(0.028, 1.05 * rwT), lenCan = Math.min(0.14, Math.max(0.06, H.volumes[yIdx].vol / (Math.PI * rCan * rCan)));
      const back = ax.clone().negate();
      const c0 = tv.C.clone().addScaledVector(back, turb.r1 * 0.8);
      volPos[yIdx] = c0.clone().addScaledVector(back, lenCan / 2);
      volOut[yIdx] = c0.clone().addScaledVector(back, lenCan);
      collAxis[yIdx] = back.clone();
      volShape[yIdx] = { type: 'can', r: rCan, len: lenCan, axis: back.clone() };
      // air filter box: ahead of the compressor, raised and toward the outside, flat; its clean-air
      // duct (part of the same volume) runs back to the compressor inlet
      const aIdx = volByName[`airbox${tg}`];
      const inlet = Cc.clone().addScaledVector(ax, comp.r1 * 0.9);
      if (aIdx !== undefined) {
        const V = H.volumes[aIdx].vol, sy = Math.cbrt(V / (2.0 * 1.4)), sx = 2.0 * sy, sz = 1.4 * sy;
        const pos = new V3(inlet.x - 0.07 - sx / 2, inlet.y + 0.07 + sy / 2, inlet.z + side * 0.02);
        volPos[aIdx] = pos;
        const ductFrom = pos.clone().add(new V3(sx / 2, -sy * 0.15, 0));
        volShape[aIdx] = { type: 'airbox', side: sx, size: [sx, sy, sz], duct: { from: ductFrom, to: inlet.clone(), r: Math.min(0.9 * comp.Rh, 0.04) } };
      }
      const turbo = { tag: tg, turb: { ...turb, C: tv.C.clone() }, comp: { ...comp, C: Cc.clone() }, ax, rw, rwT, Lc, inlet, side };
      boost.turbos.push(turbo);
      // intercooler: two tanks (the inlet volume and the intercooler volume) either end of a core.
      // One per turbo: low and wide at the front corners, beside the radiator, on a twin; one front
      // mount across the nose on a single turbo
      const ii = volByName[`ic_in${tg}`], io = volByName[`intercooler${tg}`];
      if (io !== undefined && ii !== undefined) {
        const W = twin ? 0.17 : 0.34, Hc = twin ? 0.11 : 0.14, Tk = 0.045;
        // twin: 0.55 m ahead of the engine's front face and wide, as the definition's packaging
        // estimate has them (the charge pipes' lengths come from the same estimate)
        // single: in the lower front valance, 0.35 m ahead of the front face (the Audi's definition)
        const cx = twin ? xFront - 0.5 : xFront - 0.33, cy = twin ? -0.1 : -0.1, cz = twin ? side * 0.42 : 0;
        const rin = capsuleR(H.volumes[ii].vol, Hc), rout = capsuleR(H.volumes[io].vol, Hc);
        const sIn = twin ? side : side;     // the inlet tank sits on the turbo's side
        const pin = new V3(cx, cy, cz + sIn * (W / 2 + 0.6 * rin)), pout = new V3(cx, cy, cz - sIn * (W / 2 + 0.6 * rout));
        volPos[ii] = pin; volShape[ii] = { type: 'tank', r: rin, len: Hc, axis: new V3(0, 1, 0) };
        volPos[io] = pout; volShape[io] = { type: 'tank', r: rout, len: Hc, axis: new V3(0, 1, 0) };
        boost.coolers.push({ tag: tg, c: new V3(cx, cy, cz), W, H: Hc, T: Tk });
      }
    });
    // charge pipes. Compressor to intercooler: down out of the outlet, forward low along the side of
    // the bay, into the inlet tank from behind; spare length moves the low run outboard. Intercooler
    // to throttle: back from the outlet tank, then up to the throttle inlet, entering it from the
    // front (a twin's two pipes side by side); spare length moves the corner from the straight
    // diagonal toward "low back to the engine's front face, then up it", so the pipe hugs the engine.
    pipesOf('charge').forEach(({ p, k }) => {
      const L = p.left.index, R = p.right.index, ln = H.volumes[L].name, tg = ln.endsWith('_t2') ? '_t2' : '';
      const tb = boost.turbos.find((q) => q.tag === tg) || boost.turbos[0];
      const back = new V3(1, 0, 0);
      const tankPort = (i) => (volShape[i] && volShape[i].type === 'tank' ? volPos[i].clone().addScaledVector(back, volShape[i].r) : volPos[i].clone());
      if (/^comp_out/.test(ln) && volPos[R]) {
        const X = tb.comp.X, end = tankPort(R), run = end.y;
        const x1 = X.clone().addScaledVector(tb.comp.u, 0.04), q = new V3(end.x + 0.09, run, end.z);
        const m = x1.clone().lerp(q, 0.5); m.y = run;
        routePipe(k, p.len, (beta) => [X, x1, m.clone().add(new V3(0, 0, tb.side * beta)), q, end]);
      } else if (volPos[L] && volPos[R]) {
        const a = tankPort(L), sd = Math.sign(volPos[L].z - volPos[R].z) || tb.side;
        const into = R === ti ? new V3(1, 0.2, 0).normalize() : new V3(0, 0, -sd);
        const b = R === ti ? volPos[R].clone().addScaledVector(into, -0.75 * tiR).add(new V3(0, 0, twin ? sd * 0.8 * tiR : 0)) : volPos[R].clone();
        const a1 = a.clone().addScaledVector(back, 0.06), b1 = b.clone().addScaledVector(into, -0.07);
        const corner = new V3(b1.x - 0.02, a1.y, b1.z);       // low, right under the throttle, at the engine's front
        const mid = a1.clone().lerp(b1, 0.5);
        routePipe(k, p.len, (beta) => [a, a1, mid.clone().lerp(corner, Math.min(1, beta)).add(new V3(-Math.max(0, beta - 1), 0, 0)), b1, b]);
      }
    });
    // blow-off valves: on the throttle inlet, one each side of it, venting up through their short pipes
    pipesOf('bov').forEach(({ p, k }, j) => {
      if (!tiPos) return;
      const s = twin ? (j ? -1 : 1) : 1;
      const a = tiPos.clone().add(new V3(-0.15 * tiR, 0.85 * tiR, twin ? s * 0.62 * tiR : 0));
      const bi = p.left.type === 'volume' ? p.left.index : undefined;
      if (bi !== undefined) { volPos[bi] = a; volShape[bi] = { type: 'sphere', r: Math.max(0.012, Math.cbrt(3 * H.volumes[bi].vol / (4 * Math.PI))) }; }
      paths[k] = new THREE.LineCurve3(a, a.clone().add(new V3(0, p.len, 0)));
      startPts[k] = a; endPts[k] = paths[k].getPointAt(1);
    });
  }
  // ---- positive-displacement supercharger (`boost.kind` "roots" or "twin_screw", throttle before
  // the blower, GM's layout): the blower sits on top of the plenum (its outlet), rotors along the
  // crank; the drive pulley is at the front, belted to the crank; the inlet volume and throttle
  // body are at its other end, then the air filter box. The rotors turn with the crank at the
  // drive ratio, as the simulator has them.
  const biIdx = volByName.blower_in;
  if (H.boost && biIdx !== undefined && plenumIdx !== undefined && volShape[plenumIdx]) {
    const bs = H.boost, pc = volPos[plenumIdx], ps = volShape[plenumIdx];
    const lobes = bs.lobes || (bs.kind === 'roots' ? 3 : 4), rotors = bs.rotors || 2;
    const Lr = 0.19;                                           // rotor length: estimate
    const Rt = Math.sqrt((bs.displacement || 0.0015) / (0.9 * Math.PI * Lr));   // tip radius from displacement per revolution
    const Rm = 0.75 * Rt, A = 0.25 * Rt, a = 2 * Rm * 1.035, wall = 0.007;
    const cy = pc.y + ps.r + 0.012 + Rt + wall;
    const cx = pc.x, x0 = cx - Lr / 2 - 0.015, x1 = cx + Lr / 2 + 0.015;
    // inlet volume at the rear end (a box of the simulated volume), throttle body behind it, then the air filter box
    const Vi = H.volumes[biIdx].vol, ih = 2 * (Rt + wall) * 0.9, iw = 2 * (a / 2 + Rt + wall) * 0.8, il = Vi / (ih * iw);
    volPos[biIdx] = new V3(x1 + il / 2, cy, 0);
    volShape[biIdx] = { type: 'block', size: [il, ih, iw] };
    const ai = volByName.airbox;
    if (ai !== undefined) {
      const side = Math.cbrt(H.volumes[ai].vol);
      const nx0 = x1 + il, nx1 = nx0 + 0.08;
      volPos[ai] = new V3(nx1 + side / 2, cy, 0);
      volShape[ai] = { type: 'box', side, rear: true, neck: { x0: nx0, x1: nx1, r: sp.throttle_d / 2 } };
    }
    boost.blower = { kind: bs.kind, lobes, rotors, Lr, Rt, Rm, A, a, wall, cy, cx, x0, x1, helix: (bs.helix ?? 60) * RAD, ratio: bs.drive_ratio || 2,
      outletTop: pc.y + ps.r, plenumR: ps.r, plenumLen: ps.len };
  }
  // the air filter boxes moved above: their snorkels leave the end of the box that faces the open
  // air, turn down and run on low, so the fresh-air duct follows the bay instead of standing out
  if (tTags.length || boost.blower) pipesOf('snorkel').forEach(({ p, k }) => {
    const ab = volPos[p.right.index], sh = volShape[p.right.index];
    const sgn = sh.rear ? 1 : -1, sy = sh.size ? sh.size[1] : sh.side;
    const end = new V3(ab.x + sgn * sh.side / 2, ab.y - 0.25 * sy, ab.z);
    // a turbo's box folds its duct outboard (toward the wing), a blower's down
    const fold = sh.rear ? new V3(0, -1, 0) : new V3(0, 0, Math.sign(ab.z) || 1);
    const drop = Math.min(0.16, 0.3 * p.len), f = end.clone().add(new V3(sgn * 0.07, 0, 0)).addScaledVector(fold, drop);
    routePipe(k, p.len, (beta) => [f.clone().add(new V3(sgn * (0.05 + beta), 0, 0)), f, end.clone().add(new V3(sgn * 0.07, 0, 0)), end]);
  });
  const outs = pipesOf('outlet');
  outs.forEach(({ p, k }, j) => {
    const s = volOut[p.left.index];
    const fromMerge = p.left.index === mergeIdx;
    const zoff = fromMerge && outs.length > 1 ? (j - (outs.length - 1) / 2) * 0.32 : 0;
    const ax = fromMerge ? null : collAxis[p.left.index];
    if (ax && tTags.length) {
      // a turbo's downpipe: out of the turbine outlet, down under the sump, then straight back
      const y = Math.min(s.y - 0.05, yLow);
      paths[k] = fitCurve((beta) => bendPath([s, s.clone().addScaledVector(ax, 0.05), new V3(s.x + 0.12, y, s.z), new V3(s.x + 0.12 + 0.3 * p.len + beta, y, s.z)], 0.06), p.len);
      return;
    }
    paths[k] = fitCurve((beta) => {
      const L = 0.4 * p.len + beta;
      if (ax) {
        const k1 = s.clone().addScaledVector(ax, Math.min(0.07, 0.2 * p.len)), k2 = s.clone().addScaledVector(ax, Math.min(0.13, 0.35 * p.len)).addScaledVector(ex, Math.min(0.12, 0.3 * p.len));
        return crv([s, k1, k2, k2.clone().addScaledVector(ex, 0.3 * L), k2.clone().addScaledVector(ex, L)]);
      }
      return crv([s, s.clone().add(new V3(0.12 * L, 0, 0.1 * zoff)), s.clone().add(new V3(0.32 * L, 0, zoff)), s.clone().add(new V3(L, 0, zoff))]);
    }, p.len);
  });

  return { primEnd, volOut, volPos, volShape, paths, startPts, endPts, plenumIdx, xMin, xMax, boost };
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
uniform vec3 uCol; uniform float uUseAttr; uniform float uHeat;
varying vec3 vC; varying vec3 vN; varying vec3 vV; varying float vH;
void main() {
  vC = mix(uCol, pcol, uUseAttr);
  vH = pheat * uUseAttr + uHeat;
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
    uniforms: { uCol: { value: new THREE.Vector3(0, 0, 0) }, uUseAttr: { value: useAttr ? 1 : 0 }, uGhost: { value: ghost ? 1 : 0 }, uHeat: { value: 0 } },
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
  let portMats = null;
  if (L.two) {
    for (const v of vin.concat(vex)) g.remove(v);
    vin.length = 0; vex.length = 0;
    const P = L.ports;
    exMark.position.set(0, 0.5 * (P.exTop + P.bottom), c.s * (P.wall + 0.012));
    inMark.position.set(0, P.inY, -c.s * 0.62 * B);
    // a port is a window in the liner: a glowing frame and a faint fill, brightened by how far open it is
    const win = (centre, width, y0, y1, colour) => {
      const R = P.wall + 0.0015, N = 14, pts = [];
      const at = (ang, y) => new V3(R * Math.sin(ang), y, R * Math.cos(ang) * c.s);
      for (let i = 0; i <= N; i++) pts.push(at(centre - width / 2 + width * i / N, y1));
      for (let i = N; i >= 0; i--) pts.push(at(centre - width / 2 + width * i / N, y0));
      const frameMat = new THREE.MeshBasicMaterial({ color: colour.clone().multiplyScalar(0.15), toneMapped: true });
      const frame = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.02), 60, 0.0013, 5, true), frameMat);
      const fillGeo = new THREE.CylinderGeometry(R, R, y1 - y0, 12, 1, true, centre - width / 2 + (c.s < 0 ? Math.PI : 0), width);
      const fillMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const fill = new THREE.Mesh(fillGeo, fillMat);
      fill.position.y = 0.5 * (y0 + y1);
      g.add(frame, fill);
      return { frameMat, fillMat, colour };
    };
    const amber = new THREE.Color(1.0, 0.55, 0.15), cyan = new THREE.Color(0.25, 0.75, 1.0);
    portMats = {
      ex: [win(0, 1.1, P.bottom, P.exTop, amber)],
      tr: [win(1.9, 0.75, P.bottom, P.trTop, cyan), win(-1.9, 0.75, P.bottom, P.trTop, cyan)],
    };
  }
  return { group: g, piston, glow, glowMat, vin, vex, exMark, inMark, portMats };
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

// ---------------------------------------------------------------- forced-induction parts
/** A tube along the points `pts` with a radius per point (parallel-transport frames), closed
 *  with flat caps at both ends. */
function sweepTube(pts, radii, RS = 18) {
  const n = pts.length, pos = [], nor = [], idx = [];
  const T = new V3(), Tp = new V3(), N = new V3(), Bn = new V3(), axis = new V3();
  const tan = (j) => pts[Math.min(n - 1, j + 1)].clone().sub(pts[Math.max(0, j - 1)]).normalize();
  for (let j = 0; j < n; j++) {
    T.copy(tan(j));
    if (j === 0) {
      N.set(0, 1, 0); if (Math.abs(T.y) > 0.9) N.set(1, 0, 0);
      N.addScaledVector(T, -N.dot(T)).normalize();
    } else {
      axis.crossVectors(Tp, T);
      const sl = axis.length();
      if (sl > 1e-9) N.applyAxisAngle(axis.multiplyScalar(1 / sl), Math.asin(Math.min(1, sl)));
      N.addScaledVector(T, -N.dot(T)).normalize();
    }
    Tp.copy(T);
    Bn.crossVectors(T, N);
    for (let k = 0; k <= RS; k++) {
      const a = 2 * Math.PI * k / RS, cs = Math.cos(a), sn = Math.sin(a);
      const nx = N.x * cs + Bn.x * sn, ny = N.y * cs + Bn.y * sn, nz = N.z * cs + Bn.z * sn;
      pos.push(pts[j].x + radii[j] * nx, pts[j].y + radii[j] * ny, pts[j].z + radii[j] * nz);
      nor.push(nx, ny, nz);
    }
    if (j > 0) for (let k = 0; k < RS; k++) { const a0 = (j - 1) * (RS + 1) + k, b0 = j * (RS + 1) + k; idx.push(a0, b0, a0 + 1, b0, b0 + 1, a0 + 1); }
  }
  // end caps
  for (const [j, sgn] of [[0, -1], [n - 1, 1]]) {
    const c = pos.length / 3, t = tan(j).multiplyScalar(sgn);
    pos.push(pts[j].x, pts[j].y, pts[j].z); nor.push(t.x, t.y, t.z);
    for (let k = 0; k < RS; k++) { const r0 = j * (RS + 1) + k; idx.push(c, r0, r0 + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/** A turbo housing's snail shell, relative to its centre: a spiral tube round the wheel whose
 *  section grows from r0 to r1 over `sweep` radians, ending in a straight tangential port, and the
 *  disc it wraps round (the wheel's shroud and back plate). `s` holds e1, e2 (the plane), ax (the
 *  shaft), Rh (hub radius), r0, r1, sweep, h (turning sense), phiEnd and exitLen. */
function voluteGeometries(s) {
  const pts = [], radii = [], N = 48;
  const at = (phi, rho) => s.e1.clone().multiplyScalar(rho * Math.cos(phi)).addScaledVector(s.e2, rho * Math.sin(phi));
  for (let i = 0; i <= N; i++) {
    const t = i / N, r = s.r0 + (s.r1 - s.r0) * Math.pow(t, 0.8);
    pts.push(at(s.phiEnd - s.h * s.sweep * (1 - t), s.Rh + r));
    radii.push(r);
  }
  const end = pts[N], tdir = s.e1.clone().multiplyScalar(-Math.sin(s.phiEnd)).addScaledVector(s.e2, Math.cos(s.phiEnd)).multiplyScalar(s.h);
  const rp = s.rPort || s.r1;
  for (let i = 1; i <= 6; i++) { const u = i / 6; pts.push(end.clone().addScaledVector(tdir, s.exitLen * u)); radii.push(s.r1 + (rp - s.r1) * u * u * (3 - 2 * u)); }
  const spiral = sweepTube(pts, radii, 18);
  const hubR = s.Rh + 0.35 * s.r0, hubT = 1.5 * s.r1;
  const hub = new THREE.CylinderGeometry(hubR, hubR * 0.92, hubT, 40, 1);
  hub.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), s.ax));
  return [spiral, hub];
}

/** One rotor of a Roots blower: `lobes` rounded lobes (radius Rm + A cos(lobes th)) twisted by
 *  `helix` radians over its length, along X, centred on the origin. */
function rotorGeometry(Rm, A, lobes, len, helix, NA = 72, NL = 14) {
  const pos = [], idx = [];
  for (let j = 0; j <= NL; j++) {
    const u = j / NL, x = -len / 2 + len * u, tw = helix * (u - 0.5);
    for (let i = 0; i < NA; i++) {
      const th = 2 * Math.PI * i / NA, r = Rm + A * Math.cos(lobes * th);
      pos.push(x, r * Math.cos(th + tw), r * Math.sin(th + tw));
    }
    if (j > 0) for (let i = 0; i < NA; i++) { const a0 = (j - 1) * NA + i, a1 = (j - 1) * NA + (i + 1) % NA, b0 = j * NA + i, b1 = j * NA + (i + 1) % NA; idx.push(a0, a1, b0, a1, b1, b0); }
  }
  for (const [j, sgn] of [[0, -1], [NL, 1]]) {
    const c = pos.length / 3;
    pos.push(-len / 2 + len * j / NL, 0, 0);
    for (let i = 0; i < NA; i++) { const a0 = j * NA + i, a1 = j * NA + (i + 1) % NA; if (sgn > 0) idx.push(c, a0, a1); else idx.push(c, a1, a0); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Geometries for one of the forced-induction volume shapes, relative to the volume's position
 *  p, and whether it is drawn as a ghost (the big intake volumes that should recede). */
function boostVolumeGeometries(s, p) {
  if (s.type === 'volute') return { geos: voluteGeometries(s), ghost: false };
  if (s.type === 'can' || s.type === 'tank') {
    const g = new THREE.CapsuleGeometry(s.r, Math.max(0.001, s.len - (s.type === 'tank' ? 0 : 1.2 * s.r)), 8, 28);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), s.axis));
    return { geos: [g], ghost: s.type === 'tank' };
  }
  if (s.type === 'block') return { geos: [new THREE.BoxGeometry(...s.size)], ghost: false };
  if (s.type === 'airbox') {
    const geos = [new THREE.BoxGeometry(...s.size)];
    if (s.duct) {
      const a = s.duct.from.clone().sub(p), b = s.duct.to.clone().sub(p), d = Math.min(0.07, 0.3 * a.distanceTo(b));
      geos.push(new THREE.TubeGeometry(crv([a, a.clone().add(new V3(d, 0, 0)), b.clone().add(new V3(-d, 0, 0)), b]), 24, s.duct.r, 16, false));
    }
    return { geos, ghost: true };
  }
  return null;
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

// ---------------------------------------------------------------- forced induction: colour and parts
/** The charge side of a boosted engine (compressor or blower outlet through to the intake
 *  valves) sits at boost pressure for as long as the throttle is open. On the exhaust's scale it
 *  would be a steady white glow over the whole engine, so it has its own: the same hues (warm
 *  above ambient), full colour at `pFull` (a little above the engine's boost target) and a peak
 *  brightness below the bloom threshold. Suction is drawn exactly as everywhere else. */
const HUE_CHARGE = [[0, [0.04, 0.30, 0.30]], [0.5, [0.10, 0.62, 0.56]], [1, [0.50, 0.95, 0.85]]];
export const chargeConfig = { margin: 1.25, gain: 0.7 };
export function chargeLookFor(H) {
  const b = (H.spec && H.spec.boost) || {};
  const target = b.boost_bar || (H.turbo ? 0.8 : 0.5);
  return { pFull: Math.max(config.pFull, chargeConfig.margin * target), gain: chargeConfig.gain };
}
export function chargeColor(dpBar, out, o, look) {
  if (dpBar < 0 || !look) { pressureColor(dpBar, out, o); return; }
  const s = Math.min(1, dpBar / look.pFull);
  ramp(HUE_CHARGE, s, out, o);
  const k = look.gain * Math.pow(s, config.pExp);
  out[o] *= k; out[o + 1] *= k; out[o + 2] *= k;
}

/** The parts of a supercharger or turbocharger that carry no gas of their own: a turbo's centre
 *  section, compressor wheel, clamps and wastegate actuator; an intercooler's core; a Roots
 *  blower's case, rotors, drive pulley and belt. Returns the group, points for framing and an
 *  update that turns the blower's rotors with the crank at the drive ratio. */
function buildBoostParts(L, H, crank, root) {
  const bo = L.boost || { turbos: [], coolers: [] }, g = new THREE.Group(), engPts = [];
  root.add(g);
  const Y = new V3(0, 1, 0), Z = new V3(0, 0, 1);
  const rubber = new THREE.MeshStandardMaterial({ color: 0x15171b, metalness: 0.1, roughness: 0.8 });
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, metalness: 0.9, roughness: 0.55 });
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xbfc5cd, metalness: 1.0, roughness: 0.36, side: THREE.DoubleSide });
  const cylAt = (r, len, axis, centre, mat, seg = 32, r2 = r) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, seg), mat);
    m.quaternion.setFromUnitVectors(Y, axis.clone().normalize());
    m.position.copy(centre);
    g.add(m);
    return m;
  };
  const ringAt = (R, tube, axis, centre, mat) => {
    const m = new THREE.Mesh(new THREE.TorusGeometry(R, tube, 8, 48), mat);
    m.quaternion.setFromUnitVectors(Z, axis.clone().normalize());
    m.position.copy(centre);
    g.add(m);
    return m;
  };
  for (const t of bo.turbos) {
    const { turb, comp, ax, rw } = t;
    const a = turb.C.clone().addScaledVector(ax, 0.75 * turb.r1), b = comp.C.clone().addScaledVector(ax, -0.75 * comp.r1);
    // centre section (bearing housing) on the shaft, with its oil and water flange
    cylAt(0.55 * rw, a.distanceTo(b), ax, a.clone().lerp(b, 0.5), darkSteel, 28);
    cylAt(0.8 * rw, 0.22 * rw, ax, a.clone().lerp(b, 0.45), darkSteel, 28);
    // V-band clamps where each housing meets it
    ringAt(turb.Rh + 0.3 * turb.r0, 0.0035, ax, a, alu);
    ringAt(comp.Rh + 0.3 * comp.r0, 0.0035, ax, b, alu);
    // compressor wheel in the inlet: hub and six blades, still (it turns at up to some 200,000 rpm)
    const wheel = new THREE.Group();
    wheel.add(new THREE.Mesh(new THREE.CylinderGeometry(0.16 * rw, 0.42 * rw, 0.9 * comp.r1, 20), alu));
    for (let i = 0; i < 6; i++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.0016, 0.9 * comp.r1, 0.62 * rw), alu);
      const q = 2 * Math.PI * i / 6;
      blade.position.set(0.5 * rw * Math.sin(q), 0, 0.5 * rw * Math.cos(q));
      blade.rotation.set(0, q, 0.35);
      wheel.add(blade);
    }
    wheel.quaternion.setFromUnitVectors(Y, ax);
    wheel.position.copy(comp.C).addScaledVector(ax, 0.5 * comp.r1);
    g.add(wheel);
    ringAt(Math.min(0.9 * comp.Rh, 0.04), 0.004, ax, t.inlet, alu);
    // wastegate actuator: a can below the compressor, its rod reaching back to the turbine housing
    const w = new V3(0, -1, 0);
    const canC = comp.C.clone().addScaledVector(w, comp.Rh + comp.r1 + 0.02);
    cylAt(0.017, 0.032, ax, canC, alu, 24);
    const rodEnd = turb.C.clone().addScaledVector(w, turb.Rh + 0.4 * turb.r1);
    cylAt(0.0025, canC.distanceTo(rodEnd), rodEnd.clone().sub(canC), canC.clone().lerp(rodEnd, 0.5), steel, 8);
    for (const c of [turb, comp]) {
      const R = c.Rh + 2 * c.r1;
      engPts.push(c.C.clone().add(new V3(0, R, R)), c.C.clone().add(new V3(0, -R, -R)));
    }
  }
  // intercooler core between its two tanks: a finned block facing forward
  for (const c of bo.coolers) {
    const core = new THREE.Mesh(new THREE.BoxGeometry(c.T, c.H, c.W), coreMat);
    core.position.copy(c.c);
    g.add(core);
    const nf = Math.max(6, Math.round(c.H / 0.014));
    for (let i = 0; i < nf; i++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.0025, c.W * 0.98), alu);
      fin.position.set(c.c.x - c.T / 2 - 0.0015, c.c.y - c.H / 2 + c.H * (i + 0.5) / nf, c.c.z);
      g.add(fin);
    }
  }
  // Roots blower
  const bl = bo.blower;
  let rotorA = null, rotorB = null, pulley = null;
  if (bl) {
    const hw = bl.a / 2 + bl.Rt + bl.wall, hh = bl.Rt + bl.wall, len = bl.x1 - bl.x0;
    const shape = new THREE.Shape();
    shape.absarc(hw - hh, 0, hh, -Math.PI / 2, Math.PI / 2, false);
    shape.absarc(-(hw - hh), 0, hh, Math.PI / 2, 3 * Math.PI / 2, false);
    // extruded along +Z, turned so the extrusion runs along +X (shape x -> world -z)
    const caseG = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false, curveSegments: 24 });
    caseG.rotateY(Math.PI / 2);
    const shell = new THREE.Mesh(caseG, glass);
    shell.position.set(bl.x0, bl.cy, 0);
    shell.renderOrder = 2;
    g.add(shell);
    const outline = shape.getPoints(24).map((p) => new V3(0, p.y, -p.x));
    for (const x of [bl.x0, bl.x1]) {
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(outline.map((p) => p.clone().add(new V3(x, bl.cy, 0))), true, 'centripetal'), 96, 0.003, 6, true), alu));
    }
    // front plate (the gear case behind the snout)
    const plateG = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: false, curveSegments: 24 });
    plateG.rotateY(Math.PI / 2);
    const front = new THREE.Mesh(plateG, plateMat);
    front.position.set(bl.x0 - 0.012, bl.cy, 0);
    g.add(front);
    // outlet: an open throat from the bottom of the case down into the plenum
    const th = bl.cy - hh - bl.outletTop + 0.012;
    const throat = new THREE.Mesh(new THREE.BoxGeometry(0.8 * bl.Lr, th, 0.9 * bl.a), glass);
    throat.position.set(bl.cx, bl.outletTop - 0.006 + th / 2, 0);
    throat.renderOrder = 2;
    g.add(throat);
    // rotors: two lobed, twisted rotors, mirror images of each other, meshing
    rotorA = new THREE.Mesh(rotorGeometry(bl.Rm, bl.A, bl.lobes, bl.Lr, bl.helix), alu);
    rotorB = new THREE.Mesh(rotorGeometry(bl.Rm, bl.A, bl.lobes, bl.Lr, -bl.helix), alu);
    rotorA.position.set(bl.cx, bl.cy, -bl.a / 2);
    rotorB.position.set(bl.cx, bl.cy, bl.a / 2);
    g.add(rotorA, rotorB);
    for (const z of [-bl.a / 2, bl.a / 2]) { const sh = xCyl(0.011, bl.x0 - 0.004, bl.x1 + 0.004, steel, 16); sh.position.y = bl.cy; sh.position.z = z; g.add(sh); }
    // drive: a snout from the front of the case on the drive rotor's shaft, its pulley belted to a
    // pulley on the crank; the pulleys' diameters are in the drive ratio
    const xb = crank.x0 - 0.03, rCr = 0.0915, rBl = rCr / bl.ratio, zB = -bl.a / 2;
    const snout = xCyl(0.024, xb + 0.012, bl.x0 - 0.012, darkSteel, 24);
    snout.position.y = bl.cy; snout.position.z = zB;
    g.add(snout);
    pulley = new THREE.Group();
    pulley.add(xCyl(rBl, -0.012, 0.012, darkSteel, 40));
    for (const dx of [-0.011, 0.011]) pulley.add(xCyl(rBl * 1.06, dx - 0.0015, dx + 0.0015, alu, 40));
    const mark = xCyl(0.006, -0.0135, 0.0135, steel, 12);
    mark.position.y = 0.6 * rBl;
    pulley.add(mark);
    pulley.position.set(xb, bl.cy, zB);
    g.add(pulley);
    g.add(xCyl(rCr, xb - 0.012, xb + 0.012, darkSteel, 56));
    for (const dx of [-0.011, 0.011]) g.add(xCyl(rCr * 1.03, xb + dx - 0.0015, xb + dx + 0.0015, alu, 56));
    g.add(xCyl(0.02, xb + 0.012, crank.x0 + 0.01, steel, 16));
    // belt: round both pulleys and along their outer tangents
    const c1 = [0, 0], c2 = [bl.cy, zB], D = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]);
    const base = Math.atan2(c2[1] - c1[1], c2[0] - c1[0]), off = Math.acos((rCr - rBl) / D);
    const pts = [];
    const arc = (c, r, a0, a1, k) => { for (let i = 0; i < k; i++) { const q = a0 + (a1 - a0) * i / k; pts.push(new V3(xb, c[0] + r * Math.cos(q), c[1] + r * Math.sin(q))); } };
    arc(c2, rBl + 0.004, base - off, base + off, 24);
    arc(c1, rCr + 0.004, base + off, base + 2 * Math.PI - off, 48);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true, 'centripetal'), 160, 0.004, 6, true), rubber));
    // bypass valve actuator on the inlet volume
    const bi = H.volumes.findIndex((v) => v.name === 'blower_in');
    if (bi >= 0 && L.volPos[bi]) cylAt(0.016, 0.03, Y, L.volPos[bi].clone().add(new V3(0, L.volShape[bi].size[1] / 2 + 0.015, 0)), alu, 24);
    engPts.push(new V3(bl.x0, bl.cy + hh, hw), new V3(bl.x1, bl.cy + hh, -hw), new V3(xb, bl.cy + rBl, zB), new V3(xb, -rCr, 0));
  }
  const st = { theta: null, ca: 0, t: 0 };
  return {
    group: g, engPts,
    /** Turn the blower's rotors: crank angle (unwrapped from the cycle angle with the engine speed)
     *  times the drive ratio, as the simulator has them. */
    update(bin, o, co) {
      if (!bl) return;
      const t = bin[o], rpm = bin[o + 2], ca = bin[co + 5];
      const dt = t - st.t;
      if (st.theta === null || !(dt > 0 && dt < 0.5)) st.theta = ca;
      else {
        const dca = ca - st.ca, want = rpm / 60 * 2 * Math.PI * dt;
        st.theta += dca + 4 * Math.PI * Math.round((want - dca) / (4 * Math.PI));
      }
      st.t = t; st.ca = ca;
      const psi = bl.ratio * st.theta;
      rotorA.rotation.x = Math.PI / 2 - psi;
      rotorB.rotation.x = -Math.PI / 6 + psi;
      pulley.rotation.x = -psi;
    },
  };
}

// ---------------------------------------------------------------- sound sources
/** Where each radiating opening of `H.sound.sources` is in the drawing, in model coordinates
 *  (the model's root is never moved): `pos` the centre of the opening, `dir` the outward unit
 *  direction, `radius` the opening's radius. A pipe's open end is the end of its drawn path; an
 *  open throttle is the lip of the bellmouth on the runner whose left end is that volume.
 *  Returns [] when the telemetry has no sound block. Entries keep the header's order, so entry
 *  j is row j of the sound block. */
export function soundSources(H, L) {
  const S = H.sound;
  if (!S || !Array.isArray(S.sources)) return [];
  return S.sources.map((src, j) => {
    const base = { index: j, name: src.name || `source${j}`, stem: src.stem, pos: null, dir: null, radius: 0 };
    if (src.pipe >= 0) {
      const c = L.paths[src.pipe], p = H.pipes[src.pipe];
      if (!c || !p) return { ...base, kind: 'pipe', pipe: src.pipe, end: src.end };
      const right = src.end === 'right';
      const pos = c.getPointAt(right ? 1 : 0), dir = c.getTangentAt(right ? 1 : 0).normalize();
      if (!right) dir.negate();
      return { ...base, kind: 'pipe', pipe: src.pipe, end: src.end, pos, dir, radius: 0.5 * p.dia[right ? p.samples - 1 : 0] };
    }
    // open throttle: the bellmouth sits on the runner's left end, drawn from -0.015 to +0.025 m
    // along its axis about volPos (see the 'bell' volume shape)
    const v = src.volume, s = L.volShape[v], vp = L.volPos[v];
    if (!s || !vp || s.type !== 'bell') return { ...base, kind: 'throttle', volume: v };
    return { ...base, kind: 'throttle', volume: v, pos: vp.clone().addScaledVector(s.axis, 0.025), dir: s.axis.clone().normalize(), radius: 1.75 * s.r };
  });
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

    // On a boosted engine the charge side (compressor or blower outlet to the intake valves) is
    // coloured on its own, dimmer scale (chargeColor), and the turbine housings glow with heat.
    const boosted = !!(H.turbo || H.boost);
    const chargeVol = (name) => boosted && /^(comp_out|ic_in|intercooler|throttle_in|blower_out|plenum)/.test(name);
    const hotVol = (name) => !!H.turbo && /^(collector|turbine_in|turbine_out)/.test(name);
    // pipes: glass tubes of glowing gas; the intake snorkel is ghosted so it recedes
    const pipeMat = dataMaterial(true), ghostPipeMat = dataMaterial(true, true);
    const tubes = H.pipes.map((p, k) => {
      if (!L.paths[k]) return null;
      const t = buildTube(L.paths[k], p);
      const m = new THREE.Mesh(t.geometry, p.kind === 'snorkel' ? ghostPipeMat : pipeMat);
      m.frustumCulled = false;
      if (p.kind === 'snorkel') m.renderOrder = 3;
      root.add(m);
      return { ...t, mesh: m, pipe: p, shown: L.paths[k].getLength(), charge: boosted && (p.kind === 'charge' || p.kind === 'runner') };
    });
    // volumes: airbox and plenum as ghosts, collectors as merge cones, the rest as small glass bodies
    const vols = H.volumes.map((v, k) => {
      const s = L.volShape[k], p = L.volPos[k];
      if (!s || !p) return null;
      let g, ghost = false, extra = [];
      const bg = boostVolumeGeometries(s, p);
      if (bg) { [g, ...extra] = bg.geos; ghost = bg.ghost; }
      else if (s.type === 'sphere') g = new THREE.SphereGeometry(s.r, 28, 18);
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
      // further pieces of the same volume (an air filter's duct; a turbine housing on its collector)
      for (const eg of extra) { const c = new THREE.Mesh(eg, mat); if (ghost) c.renderOrder = 3; m.add(c); }
      if (s.volute) for (const eg of voluteGeometries(s.volute)) { const c = new THREE.Mesh(eg, mat); c.position.copy(s.volute.C); m.add(c); }
      root.add(m);
      return { mesh: m, mat, offset: v.offset, charge: chargeVol(v.name), hot: hotVol(v.name) };
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

    // turbo centre sections and wheels, intercooler cores, the blower's case, rotors and drive
    const boostParts = boosted ? buildBoostParts(L, H, crank, root) : null;

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
    if (boostParts) for (const q of boostParts.engPts) boxEng.expandByPoint(q);
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
    this.boostParts = boostParts;
    this.chargeLook = boosted ? chargeLookFor(H) : null;
    this.state = { clear: Infinity, valveClear: Infinity };
    // open exhaust ends: where the gas leaves, and which way
    this.outlets = [];
    tubes.forEach((t, k) => {
      if (!t || t.pipe.right.type !== 'ambient' || !EXHAUST_KINDS[t.pipe.kind]) return;
      const c = L.paths[k];
      this.outlets.push({ pos: c.getPointAt(1), dir: c.getTangentAt(1).normalize(), radius: 0.5 * t.pipe.dia[t.pipe.samples - 1], offset: t.pipe.offset + 3 * (t.pipe.samples - 1) });
    });
    this.soundSources = soundSources(H, L);
    this._tmp = [0, 0, 0];
    this._P = new V3();
    this._W = new V3();
  }

  /** Check that every sound source sits on the opening it names, measured against the meshes
   *  as drawn: a pipe end against the centre of the tube's last ring of vertices, a throttle
   *  mouth against the centre of its bellmouth's lip. Returns the worst position error (m), the
   *  worst direction error (degrees) and one line per source. */
  checkSoundSources() {
    const out = { count: this.soundSources.length, maxPosErr: 0, maxDirErrDeg: 0, missing: 0, sources: [] };
    const ctr = new V3(), nrm = new V3(), q = new V3();
    for (const s of this.soundSources) {
      const row = { name: s.name, kind: s.kind, stem: s.stem };
      if (!s.pos) { out.missing++; row.missing = true; out.sources.push(row); continue; }
      ctr.set(0, 0, 0);
      if (s.kind === 'pipe') {
        // the ring of vertices at that end of the tube, and the plane it lies in
        const t = this.tubes[s.pipe], pa = t.geometry.attributes.position.array, per = t.RS + 1;
        const j = s.end === 'right' ? t.rings - 1 : 0, jIn = s.end === 'right' ? t.rings - 2 : 1;
        for (let k = 0; k < t.RS; k++) ctr.add(q.fromArray(pa, 3 * (j * per + k)));
        ctr.multiplyScalar(1 / t.RS);
        const inner = new V3();
        for (let k = 0; k < t.RS; k++) inner.add(q.fromArray(pa, 3 * (jIn * per + k)));
        inner.multiplyScalar(1 / t.RS);
        nrm.subVectors(ctr, inner).normalize();   // from the pipe's inside toward its open end
        row.open = this.H.pipes[s.pipe][s.end].type === 'ambient';
        if (!row.open) out.missing++;
      } else {
        // the bellmouth's lip: its vertices furthest out along the bell's axis
        const v = this.vols[s.volume], ax = this.L.volShape[s.volume].axis, pa = v.mesh.geometry.attributes.position.array;
        let best = -Infinity;
        for (let i = 0; i < pa.length; i += 3) best = Math.max(best, q.fromArray(pa, i).dot(ax));
        let m = 0;
        const seen = new Set();   // the lathe repeats its seam vertex; count each point once
        for (let i = 0; i < pa.length; i += 3) {
          if (q.fromArray(pa, i).dot(ax) < best - 1e-6) continue;
          const key = `${Math.round(q.x * 1e6)},${Math.round(q.y * 1e6)},${Math.round(q.z * 1e6)}`;   // (-0 prints as 0)
          if (seen.has(key)) continue;
          seen.add(key);
          ctr.add(q); m++;
        }
        ctr.multiplyScalar(1 / m).add(v.mesh.position);
        nrm.copy(ax);
      }
      row.posErr = +ctr.distanceTo(s.pos).toExponential(2);
      row.dirErrDeg = +(Math.acos(Math.min(1, nrm.dot(s.dir))) / RAD).toFixed(3);
      out.maxPosErr = Math.max(out.maxPosErr, row.posErr);
      out.maxDirErrDeg = Math.max(out.maxDirErrDeg, row.dirErrDeg);
      out.sources.push(row);
    }
    return out;
  }

  /** Draw one frame. `bin` is a Float32Array holding the frame at offset `o`.
   *  `refP(o, column)` may supply a reference pressure other than ambient. */
  update(bin, o = 0, refP = null) {
    const { H, L, sp, crank, cyls, rods, tubes, vols, plate, state } = this;
    const { r, l, ch, deck } = L;
    const seat = deck + L.recess, n = sp.firing.length, tmpCol = this._tmp, P = this._P, W = this._W;
    const pa = H.p_atm, heat = !!this.opts.heat;
    // glowScale: one overall factor on every glow drawn here (1 = as the data says; the live page's
    // warm-up lowers it for an engine that has not been worked)
    const gs = this.glowScale ?? 1;
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
      const gain = gs * (0.02 + 1.5 * Math.pow(Math.min(1, p / 5.0e6), 0.8) + 1.1 * Math.min(1, burn / 2.0));
      cy.glowMat.color.setRGB(tmpCol[0] * gain, tmpCol[1] * gain, tmpCol[2] * gain);
      cy.light.intensity = (this.opts.lightGain || 0.10) * Math.max(0, gain - 0.15);
      for (const v of cy.vin) v.position.y = seat - li;
      for (const v of cy.vex) v.position.y = seat - le;
      state.clear = Math.min(state.clear, deck - crown);
      if (cy.portMats) {
        // on a two-stroke lift_ex / lift_in are the exhaust and transfer ports' open fractions
        for (const [list, f] of [[cy.portMats.ex, le], [cy.portMats.tr, li]]) for (const pm of list) {
          pm.frameMat.color.copy(pm.colour).multiplyScalar(0.15 + 1.6 * f);
          pm.fillMat.color.copy(pm.colour).multiplyScalar(0.35 * f);
        }
      } else state.valveClear = Math.min(state.valveClear, seat - Math.max(li, le) - crown);
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
        if (tb.charge) chargeColor((p0 + (p1 - p0) * (f - i0)) * 1e-5, tmpCol, 0, this.chargeLook);
        else pressureColor((p0 + (p1 - p0) * (f - i0)) * 1e-5, tmpCol, 0);
        let q = j * per * 3;
        for (let k = 0; k < per; k++) { arr[q++] = tmpCol[0] * gs; arr[q++] = tmpCol[1] * gs; arr[q++] = tmpCol[2] * gs; }
        if (hot) {
          const t0 = bin[po + 3 * i0 + 1], t1 = bin[po + 3 * i1 + 1];
          const h = gs * Math.min(1, Math.max(0, (t0 + (t1 - t0) * (f - i0) - 800) / 550));
          hot.fill(h, j * per, (j + 1) * per);
        }
      }
      tb.col.needsUpdate = true;
      if (hot) tb.heat.needsUpdate = true;
    }
    for (const v of vols) {
      if (!v) continue;
      if (v.charge) chargeColor((bin[o + v.offset] - (refP ? refP(o, v.offset) : pa)) * 1e-5, tmpCol, 0, this.chargeLook);
      else pressureColor((bin[o + v.offset] - (refP ? refP(o, v.offset) : pa)) * 1e-5, tmpCol, 0);
      v.mat.uniforms.uCol.value.set(tmpCol[0] * gs, tmpCol[1] * gs, tmpCol[2] * gs);
      // a turbine housing glows with the heat of its gas, as the exhaust pipes do
      if (v.hot && heat) v.mat.uniforms.uHeat.value = gs * Math.min(1, Math.max(0, (bin[o + v.offset + 1] - 800) / 550));
    }
    // The bore runs along x. rotation.z = 0 leaves the disc lying along the bore (wide open) and pi/2
    // turns it across the bore (shut); the plate's angle from shut is acos(1 - thr), so that the
    // opening it uncovers (1 - cos) follows the throttle. (Until 2026-11-17 this was inverted: the
    // plate drew shut at full throttle and open at idle.)
    if (plate) plate.rotation.z = Math.PI / 2 - Math.acos(Math.max(0, 1 - Math.min(1, thr)));
    if (this.boostParts) this.boostParts.update(bin, o, co);
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

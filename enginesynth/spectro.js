// The spectrum of the sound the page plays, and the dashboard's spectrogram drawn from it
// (see viz/README.md, "The sound picture on the live app's floor").
//
// SpectroSource reads the simulator's output through two analysers: a long transform for the low
// notes, where firing orders sit a few hertz apart, and a short one for the top, where speed
// matters more than pitch. column() gives one spectrum on a log frequency axis, 0..1 over 70 dB.
// The widget (LiveSpectro) and the disc on the floor (viz/wave-studies.js) both draw from it.

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export const spectroConfig = {
  fLo: 30, fHi: 12000,   // frequency span of the widget (as the original)
  dbFloor: -100, dbSpan: 70,  // as the original's analyser range
  cross: [300, 1200],    // below: the long transform; above: the short one; blended between
  seconds: 5,            // time across the widget (as the original)
  gutter: 0.075,         // share of the width given to the live spectrum at the right edge
  edge: 0.45,            // brightness of the glow just behind the newest column
  bloom: 0.8,            // brightness of the soft glow on loud ridges
  bloomFrom: 0.55,       // ridges louder than this (0..1) glow
  bloomBlur: 4,          // its blur, pixels at a 160-line canvas
  peakFall: 0.30,        // peak-hold line falls this much (0..1) per second
  orders: [0.5, 1, 2, 3, 4],  // marks at these multiples of the firing frequency
};

export class SpectroSource {
  constructor(ctx, node) {
    this.rate = ctx.sampleRate;
    this.lo = ctx.createAnalyser(); this.lo.fftSize = 8192; this.lo.smoothingTimeConstant = 0.5;
    this.hi = ctx.createAnalyser(); this.hi.fftSize = 2048; this.hi.smoothingTimeConstant = 0.35;
    node.connect(this.lo); node.connect(this.hi);
    this.bLo = new Float32Array(this.lo.frequencyBinCount);
    this.bHi = new Float32Array(this.hi.frequencyBinCount);
  }
  /** Take this frame's spectra (call once per frame, before column()). */
  read() { this.lo.getFloatFrequencyData(this.bLo); this.hi.getFloatFrequencyData(this.bHi); }
  /** Fill `out` with the spectrum from fLo (index 0) to fHi on a log axis, 0..1. */
  column(out, fLo, fHi, cfg = spectroConfig) {
    const n = out.length, ratio = Math.pow(fHi / fLo, 1 / (n - 1));
    const at = (buf, binHz, f) => {
      // the loudest of the bins this row covers, so a narrow ridge is never skipped
      const b0 = f / binHz, span = Math.max(1, f * (ratio - 1) / binHz), i0 = Math.floor(b0);
      if (span <= 1.5) { const g = b0 - i0; return (buf[i0] ?? -200) * (1 - g) + (buf[i0 + 1] ?? -200) * g; }
      let m = -200;
      for (let i = i0; i <= Math.min(buf.length - 1, Math.ceil(b0 + span)); i++) if (buf[i] > m) m = buf[i];
      return m;
    };
    const l0 = Math.log(cfg.cross[0]), l1 = Math.log(cfg.cross[1]);
    let f = fLo;
    for (let i = 0; i < n; i++, f *= ratio) {
      const w = clamp((Math.log(f) - l0) / (l1 - l0), 0, 1);
      let db = 0;
      if (w < 1) db += (1 - w) * at(this.bLo, this.rate / this.lo.fftSize, f);
      if (w > 0) db += w * at(this.bHi, this.rate / this.hi.fftSize, f);
      const v = (db - cfg.dbFloor) / cfg.dbSpan;
      out[i] = v > 0 ? (v < 1 ? v : 1) : 0;      // also turns -Infinity and NaN into 0
    }
  }
}

/** The livelier widget. `lut` is the page's palette (256 x RGB bytes). */
export class LiveSpectro {
  constructor(canvas, source, lut, cfg = spectroConfig) {
    this.canvas = canvas; this.src = source; this.lut = lut; this.cfg = cfg;
    this.ctx = canvas.getContext('2d');
    this.W = 0;
  }
  resize() {
    const c = this.canvas, dpr = Math.min(3, window.devicePixelRatio || 1);
    const W = Math.max(600, Math.round((c.clientWidth || 300) * dpr)), H = Math.max(160, Math.round((c.clientHeight || 76) * dpr));
    if (W === this.W && H === this.H) return;
    c.width = W; c.height = H;
    this.W = W; this.H = H;
    this.G = Math.round(W * this.cfg.gutter);
    this.HW = W - this.G;
    const mk = (w, h) => { const k = document.createElement('canvas'); k.width = w; k.height = h; return k; };
    this.hist = mk(this.HW, H); this.hot = mk(this.HW, H); this.one = mk(1, H);
    this.hctx = this.hist.getContext('2d'); this.tctx = this.hot.getContext('2d'); this.octx = this.one.getContext('2d');
    this.hctx.fillStyle = '#04050a'; this.hctx.fillRect(0, 0, this.HW, H);
    this.tctx.fillStyle = '#000'; this.tctx.fillRect(0, 0, this.HW, H);
    this.col = new Float32Array(H); this.prev = new Float32Array(H); this.peak = new Float32Array(H);
    this.img = this.hctx.createImageData(1, H); this.himg = this.tctx.createImageData(1, H);
    this.acc = 0;
  }
  /** `dt` seconds since the last call, `fireHz` the firing frequency now (0 for none). */
  draw(dt, fireHz) {
    this.resize();
    const { W, H, G, HW, cfg, lut, ctx, col, prev, peak } = this;
    prev.set(col);
    this.src.column(col, cfg.fLo, cfg.fHi);
    // history: scrolls at a steady speed whatever the frame rate; whole pixels are written,
    // the fraction left over is carried to the next frame
    this.acc += Math.min(0.1, dt) * HW / cfg.seconds;
    const n = Math.min(HW, Math.floor(this.acc));
    this.acc -= n;
    if (n > 0) {
      for (const c of [this.hctx, this.tctx]) { c.globalCompositeOperation = 'copy'; c.drawImage(c.canvas, -n, 0); c.globalCompositeOperation = 'source-over'; }
      const d = this.img.data, h = this.himg.data;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        for (let y = 0; y < H; y++) {
          const f = prev[H - 1 - y] + (col[H - 1 - y] - prev[H - 1 - y]) * t, v = Math.round(255 * f), q = 4 * y;
          d[q] = lut[3 * v]; d[q + 1] = lut[3 * v + 1]; d[q + 2] = lut[3 * v + 2]; d[q + 3] = 255;
          const g = Math.round(255 * clamp((f - cfg.bloomFrom) / (1 - cfg.bloomFrom), 0, 1)), e = g / 255;
          h[q] = lut[3 * g] * e; h[q + 1] = lut[3 * g + 1] * e; h[q + 2] = lut[3 * g + 2] * e; h[q + 3] = 255;
        }
        this.hctx.putImageData(this.img, HW - n + k - 1, 0);
        this.tctx.putImageData(this.himg, HW - n + k - 1, 0);
      }
      this.octx.putImageData(this.img, 0, 0);
    }
    const s = H / 160;
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.fillStyle = '#04050a'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(this.hist, 0, 0);
    // soft glow on the loud ridges
    ctx.globalCompositeOperation = 'lighter';
    if ('filter' in ctx) {
      ctx.filter = `blur(${cfg.bloomBlur * s}px)`; ctx.globalAlpha = cfg.bloom;
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, HW, H); ctx.clip();
      ctx.drawImage(this.hot, 0, 0);
      ctx.restore();
      ctx.filter = 'none';
    }
    // the newest column glows back along the history
    for (let k = 0; k < 6; k++) { ctx.globalAlpha = cfg.edge * (1 - k / 6); ctx.drawImage(this.one, HW - (k + 1) * 3 * s, 0, 3 * s, H); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    // gutter: the spectrum now, as a curve growing leftward from the right edge, and its held peaks
    const fall = cfg.peakFall * Math.min(0.1, dt), x0 = W - 2 * s, span = G - 5 * s;
    ctx.fillStyle = 'rgba(4,5,10,.9)'; ctx.fillRect(HW, 0, G, H);
    ctx.beginPath(); ctx.moveTo(x0, 0);
    for (let y = 0; y < H; y++) { const v = col[H - 1 - y]; peak[H - 1 - y] = Math.max(v, peak[H - 1 - y] - fall); ctx.lineTo(x0 - v * v * span, y); }
    ctx.lineTo(x0, H); ctx.closePath();
    const gr = ctx.createLinearGradient(HW, 0, W, 0);
    gr.addColorStop(0, 'rgba(255,214,130,.55)'); gr.addColorStop(0.5, 'rgba(255,122,40,.38)'); gr.addColorStop(1, 'rgba(168,40,96,.20)');
    ctx.fillStyle = gr; ctx.fill();
    ctx.beginPath();
    for (let y = 0; y < H; y++) { const v = col[H - 1 - y], x = x0 - v * v * span; if (y) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.strokeStyle = '#ffd9a8'; ctx.lineWidth = 1.4 * s; ctx.shadowColor = 'rgba(255,150,60,.8)'; ctx.shadowBlur = 6 * s; ctx.stroke(); ctx.shadowBlur = 0;
    ctx.beginPath();
    for (let y = 0; y < H; y += 2) { const v = peak[H - 1 - y], x = x0 - v * v * span; if (y) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.strokeStyle = 'rgba(214,170,255,.55)'; ctx.lineWidth = 1 * s; ctx.stroke();
    // firing-order marks: where the firing frequency and its multiples are right now
    if (fireHz > 0) {
      const L = Math.log(cfg.fHi / cfg.fLo);
      for (const o of cfg.orders) {
        const f = fireHz * o;
        if (f <= cfg.fLo || f >= cfg.fHi) continue;
        const y = (1 - Math.log(f / cfg.fLo) / L) * (H - 1), main = o === 1;
        ctx.fillStyle = main ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)';
        ctx.fillRect(HW - (main ? 9 : 5) * s, y - 0.5 * s, (main ? 9 : 5) * s, 1 * s);
      }
    }
  }
}

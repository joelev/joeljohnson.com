// Page-side handle on the live engine simulator. See README in this folder for the contract.
const WASM_URL = new URL('./engsim.wasm?v=7a5737f0f1', import.meta.url);
const WORKLET_URL = new URL('./worklet.js?v=7a5737f0f1', import.meta.url);
const QUALITY = ['live48+W', 'live96+W', 'live48', 'live96'];
let modulePromise = null, mainInstance = null;

async function wasmModule() {
  if (!modulePromise) modulePromise = fetch(WASM_URL).then(r => { if (!r.ok) throw new Error('cannot load engsim.wasm'); return r.arrayBuffer(); }).then(b => WebAssembly.compile(b));
  return modulePromise;
}
async function mainExports() {
  if (!mainInstance) mainInstance = (await WebAssembly.instantiate(await wasmModule(), {})).exports;
  return mainInstance;
}
const text = (x, p, n) => new TextDecoder().decode(new Uint8Array(x.memory.buffer, p, n));
const request = (engine, overrides) => new TextEncoder().encode(JSON.stringify({ engine, overrides: overrides || {} }));

export class LiveEngine extends EventTarget {
  /** All built-in engines: [{name, label, cylinders, layout, redline, idle, itb, litres, spec}] */
  static async presets() {
    const x = await mainExports();
    return JSON.parse(text(x, x.es_presets_ptr(), x.es_presets_len()));
  }

  /** How much of real time one core needs for this engine at a quality level (0 light, 1 heavy). */
  static async measure(engine, overrides, quality) {
    const x = await mainExports();
    const req = request(engine, overrides);
    const p = x.es_alloc(req.length); new Uint8Array(x.memory.buffer, p, req.length).set(req);
    const l = x.es_new(p, req.length, quality, 3000); x.es_free(p, req.length);
    if (!l) throw new Error('unknown engine or bad overrides: ' + engine);
    const out = x.es_alloc(128 * 8);
    x.es_set_throttle(l, 1);
    for (let i = 0; i < 20; i++) x.es_process(l, out, 128);
    const blocks = 60, t0 = performance.now();
    for (let i = 0; i < blocks; i++) x.es_process(l, out, 128);
    const load = LiveEngine.slow * (performance.now() - t0) / (blocks * 128 / 48000 * 1000);
    x.es_drop(l); x.es_free(out, 128 * 8);
    return load;
  }

  /**
   * Build an engine on the page's own WebAssembly instance (no audio context needed) and return
   * its header and the first telemetry frame, so the picture can be drawn before sound starts.
   * @returns {Promise<{header: object, frame: Float32Array}>}
   */
  static async preview(engine, overrides) {
    const x = await mainExports();
    const req = request(engine, overrides);
    const p = x.es_alloc(req.length); new Uint8Array(x.memory.buffer, p, req.length).set(req);
    const l = x.es_new(p, req.length, 0, 0); x.es_free(p, req.length);
    if (!l) throw new Error('unknown engine or bad overrides: ' + engine);
    try {
      const header = JSON.parse(text(x, x.es_header_ptr(l), x.es_header_len(l)));
      const frame = new Float32Array(x.memory.buffer, x.es_frame_ptr(l), x.es_frame_len(l)).slice();
      return { header, frame };
    } finally { x.es_drop(l); }
  }

  /**
   * Test hook: make the simulator k times as costly as it is (k a whole number, default 1), to
   * stand in for a slower device. The audio thread runs k-1 extra copies of the engine and throws
   * their output away; measure() scales its result by k. Set it before create().
   */
  static slow = 1;

  /**
   * @param {AudioContext} audioCtx  must run at 48000 Hz (new AudioContext({sampleRate: 48000}))
   * @param {{engine?: string, overrides?: object, quality?: 'auto'|'light'|'heavy'}} opts
   */
  static async create(audioCtx, opts = {}) {
    if (audioCtx.sampleRate !== 48000) console.warn(`LiveEngine: audio context runs at ${audioCtx.sampleRate} Hz; the simulator outputs 48000 Hz, so pitch will be off`);
    const module = await wasmModule();
    await audioCtx.audioWorklet.addModule(WORKLET_URL);
    const node = new AudioWorkletNode(audioCtx, 'engine-synth', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { module, slow: Math.max(1, Math.round(LiveEngine.slow) || 1) } });
    const e = new LiveEngine(audioCtx, node, opts.quality || 'auto');
    await e._ready;
    await e.setEngine(opts.engine || 'v8_cross', opts.overrides || {});
    return e;
  }

  constructor(audioCtx, node, quality) {
    super();
    this.audioCtx = audioCtx;
    this.output = node;
    this.header = null;
    this.frame = null;
    this.stats = { load: 0, quality: '', dropped: 0 };
    this.engine = ''; this.overrides = {};
    this._qualityPref = quality;
    this._throttle = 0; this._drive = false; this._auto = true;
    this._phi = 1; this._overrunFuel = 0; this._limiter = 'fuel'; this._liftoffPops = 0;
    this._pending = new Map(); this._id = 0;
    this._ready = new Promise(res => { this._resolveReady = res; });
    node.port.onmessage = (ev) => this._message(ev.data);
    node.onprocessorerror = (ev) => console.error('LiveEngine: audio processor error', ev);
  }

  _message(m) {
    if (m.type === 'ready') this._resolveReady();
    else if (m.type === 'frame') {
      if (this.header && m.frame.length === this.header.frame_floats) { this.frame = m.frame; this.dispatchEvent(new Event('frame')); }
    } else if (m.type === 'stats') {
      this.stats.load = m.load;
      if (m.load > 1) this.stats.dropped++;
      this.dispatchEvent(new Event('stats'));
    } else if (m.type === 'header' || m.type === 'error') {
      const p = this._pending.get(m.id); this._pending.delete(m.id);
      if (p) m.type === 'header' ? p.resolve(JSON.parse(new TextDecoder().decode(m.header))) : p.reject(new Error(m.message));
    }
  }

  /** Swap or reshape the engine. Fires 'rebuild' once the new header is in place. */
  async setEngine(name, overrides = {}) {
    let q = this._qualityPref === 'heavy' ? 1 : 0;
    if (this._qualityPref === 'auto') {
      // heavy if it leaves headroom on this machine, else light
      q = (await LiveEngine.measure(name, overrides, 1)) < 0.5 ? 1 : 0;
    }
    const id = ++this._id;
    const startRpm = (this.frame && this.engine === name) ? this.frame[2] : 0;
    const header = await new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.output.port.postMessage({ type: 'new', id, req: request(name, overrides), quality: q, startRpm, drive: this._drive, auto: this._auto, throttle: this._throttle, phi: this._phi, overrunFuel: this._overrunFuel, limiter: this._limiter, liftoffPops: this._liftoffPops });
    });
    this.engine = name; this.overrides = overrides;
    this.header = header; this.frame = null;
    this.stats.quality = header.quality; this.stats.dropped = 0;
    this.dispatchEvent(new Event('rebuild'));
    return header;
  }

  /** 'light' or 'heavy': the quality level the running engine was built at. */
  get level() { return this.header && this.header.quality === QUALITY[1] ? 'heavy' : 'light'; }
  get qualityPref() { return this._qualityPref; }
  /** Change the quality preference ('auto' | 'light' | 'heavy'); by default rebuild the running engine at it. */
  async setQuality(pref, rebuild = true) {
    this._qualityPref = pref === 'heavy' || pref === 'light' ? pref : 'auto';
    if (rebuild && this.engine) return this.setEngine(this.engine, this.overrides);
  }

  setThrottle(x) { this._throttle = Math.min(1, Math.max(0, x)); this.output.port.postMessage({ type: 'throttle', value: this._throttle }); }
  setBrake(x) { this.output.port.postMessage({ type: 'brake', value: Math.min(1, Math.max(0, x)) }); }
  setMode(m) { this._drive = m === 'drive'; this.output.port.postMessage({ type: 'drive', value: this._drive }); if (this._drive && !this._auto) this.setAutoShift(false); }
  setAutoShift(b) { this._auto = !!b; this.output.port.postMessage({ type: 'auto', value: this._auto }); }
  shift(dir) { this.output.port.postMessage({ type: 'shift', value: dir > 0 ? 1 : -1 }); }
  /** Fuel-air equivalence ratio: 1 stoichiometric, below lean, above rich (the simulator clamps it to 0.7..1.7). */
  setMixture(phi) { const v = Number(phi); if (!Number.isFinite(v)) return; this._phi = Math.min(1.7, Math.max(0.7, v)); this.output.port.postMessage({ type: 'phi', value: this._phi }); }
  /** Share of overrun cycles that are fueled (and burn late, so they pop) instead of cut, 0..1. */
  setOverrunFuel(x) { const v = Number(x); if (!Number.isFinite(v)) return; this._overrunFuel = Math.min(1, Math.max(0, v)); this.output.port.postMessage({ type: 'overrunFuel', value: this._overrunFuel }); }
  /** Lift-off pops, 0..1: fuel left on the port walls feeds the first cycles after the throttle shuts and gathers in the exhaust, where it lights as a few bangs that tail off (0 none, about 0.3 a sporty road car, 1 a full "burble tune"). */
  setLiftoffPops(x) { const v = Number(x); if (!Number.isFinite(v)) return; this._liftoffPops = Math.min(1, Math.max(0, v)); this.output.port.postMessage({ type: 'liftoffPops', value: this._liftoffPops }); }
  /** Rev limiter: 'fuel' cuts fuel (cylinders pump air), 'spark' cuts spark (raw mixture goes into the exhaust). */
  setLimiter(kind) { this._limiter = kind === 'spark' ? 'spark' : 'fuel'; this.output.port.postMessage({ type: 'limiter', value: this._limiter }); }
  get mixture() { return this._phi; }
  get overrunFuel() { return this._overrunFuel; }
  get limiter() { return this._limiter; }
  get liftoffPops() { return this._liftoffPops; }
}

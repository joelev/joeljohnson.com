// Audio-thread side of the engine synthesizer: runs the WebAssembly simulator and
// posts stroboscopic telemetry frames to the page.
class EngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.x = new WebAssembly.Instance(options.processorOptions.module, {}).exports;
    this.cap = 1024;
    this.out = this.x.es_alloc(this.cap * 2 * 4);
    this.l = 0;
    this.seq = -1;
    this.busy = 0; this.blocks = 0; this.t0 = this.now();
    this.port.onmessage = (e) => this.message(e.data);
    this.port.postMessage({ type: 'ready' });
  }
  now() { return (globalThis.performance && performance.now) ? performance.now() : Date.now(); }
  bytes(ptr, len) { return new Uint8Array(this.x.memory.buffer, ptr, len).slice(); }
  message(m) {
    const x = this.x;
    switch (m.type) {
      case 'new': {
        const p = x.es_alloc(m.req.length);
        new Uint8Array(x.memory.buffer, p, m.req.length).set(m.req);
        const l = x.es_new(p, m.req.length, m.quality, m.startRpm || 0);
        x.es_free(p, m.req.length);
        if (!l) { this.port.postMessage({ type: 'error', id: m.id, message: 'engine request rejected' }); break; }
        if (this.l) x.es_drop(this.l);
        this.l = l; this.seq = -1;
        if (m.drive) x.es_set_drive(l, 1);
        if (m.auto === false) x.es_set_auto(l, 0);
        x.es_set_throttle(l, m.throttle || 0);
        this.port.postMessage({ type: 'header', id: m.id, header: this.bytes(x.es_header_ptr(l), x.es_header_len(l)) });
        break;
      }
      case 'throttle': if (this.l) x.es_set_throttle(this.l, m.value); break;
      case 'brake': if (this.l) x.es_set_brake(this.l, m.value); break;
      case 'drive': if (this.l) x.es_set_drive(this.l, m.value ? 1 : 0); break;
      case 'auto': if (this.l) x.es_set_auto(this.l, m.value ? 1 : 0); break;
      case 'shift': if (this.l) x.es_shift(this.l, m.value); break;
    }
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!this.l || !out || !out.length) return true;
    const n = out[0].length, x = this.x;
    if (n > this.cap) return true;
    const t = this.now();
    x.es_process(this.l, this.out, n);
    this.busy += this.now() - t;
    const v = new Float32Array(x.memory.buffer, this.out, n * 2);
    const L = out[0], R = out[1] || out[0];
    for (let i = 0; i < n; i++) { L[i] = v[2 * i]; R[i] = v[2 * i + 1]; }
    const seq = x.es_frame_seq(this.l);
    if (seq !== this.seq) {
      this.seq = seq;
      const f = new Float32Array(x.memory.buffer, x.es_frame_ptr(this.l), x.es_frame_len(this.l)).slice();
      this.port.postMessage({ type: 'frame', frame: f }, [f.buffer]);
    }
    if (++this.blocks >= 375) { // about once a second at 128-sample blocks
      const wall = this.now() - this.t0;
      this.port.postMessage({ type: 'stats', load: this.busy / (this.blocks * n / sampleRate * 1000), wall });
      this.busy = 0; this.blocks = 0; this.t0 = this.now();
    }
    return true;
  }
}
registerProcessor('engine-synth', EngineProcessor);

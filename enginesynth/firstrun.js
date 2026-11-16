// First-run teaching: lure, then teach, one thing at a time. The engine starts in Drive with
// automatic shifting, so the first hold of the space bar pulls away and runs up through the gears.
//   1. the space bar: the opening screen teaches it (it starts the engine; it is the throttle);
//   2. shifting: after the second automatic upshift the Q and E keys wake either side of the gear
//      numeral, with the A key, whose legend says which way shifting is now ("auto" or "manual");
//   3. the brake, at the moment it is wanted: after a second and a half on the limiter in top
//      gear, or two seconds of coasting at speed, the S key gives a nudge.
// Neutral is not taught; the lever's gate is marked N and D.
// Teaching only ever adds: the thing being taught carries the accent (class "teach"). Nothing is
// dimmed or hidden once the engine is running; every key is drawn in full and works at every stage.
//
// The sequence runs on a viewer's first visit only: once they have opened the throttle, that is
// remembered in localStorage (the page works without it) and later visits start with everything
// awake and no cues. ?firstrun=1 forces the sequence (and ignores what is stored), ?firstrun=0 skips it.
//
// State for tests and curiosity: window.__app.firstRun = { active, stage, cue, brakeCue, done, upshifts }.
//   stage: loading > ready > started > driving > cue-shift > done   (or "off")

const STORE = 'enginesynth.firstrun.v1';
const UPSHIFTS = 2;        // automatic upshifts before the shift keys wake
const LIMITER_S = 1.5;     // on the limiter in gear with automatic shifting (so: top gear) this long brings the brake cue
const COAST_S = 2;         // or coasting this long...
const COAST_SPEED = 20;    // ...above this road speed (m/s)

/** What is remembered: a plain object of flags. Anything else found there (a value left by some
 *  other version, hand edits, corrupt text) is ignored rather than trusted. */
function load() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}
function save(d) { try { localStorage.setItem(STORE, JSON.stringify(d)); } catch (e) { /* private window, blocked storage: fine */ } }

export class FirstRun {
  /** mode: '1' force, '0' skip, anything else decides from what this viewer has done before. */
  constructor(mode, els) {
    this.forced = mode === '1';
    this.done = this.forced ? {} : load();
    this.active = this.forced || (mode !== '0' && !this.done.space);
    this.stage = this.active ? 'loading' : 'off';
    this.cue = null;
    this.brakeCue = false;
    this.upshifts = 0;
    this.limiter = 0; this.coast = 0; this.lastGear = 0;
    this.el = els;   // { space, down, up, brake }
  }
  mark(what) {
    if (this.done[what]) return;
    this.done[what] = 1;
    save(Object.assign(load(), this.done));
  }
  teach(what) {
    const e = this.el;
    this.cue = what;
    e.space.classList.toggle('teach', what === 'space');
    e.down.classList.toggle('teach', what === 'shift');
    e.up.classList.toggle('teach', what === 'shift');
  }
  /** The simulator is loaded and the space bar can start it. */
  ready() {
    if (!this.active) return;
    this.stage = 'ready';
    this.teach('space');
  }
  /** The engine is running (in Drive, at rest). */
  started() {
    if (!this.active) return;
    this.stage = 'started';
  }
  /** Once per picture frame while the engine runs. s: { thr, mode, gear, cut, auto, speed, brake } */
  tick(dt, s) {
    if (s.mode === 'drive') {
      if (s.auto && s.gear > this.lastGear && this.lastGear >= 1) this.upshifts++;
      this.lastGear = s.gear;
    } else this.lastGear = 0;
    if (!this.active) { if (s.thr > 0.15) this.mark('space'); return; }
    if (this.stage === 'started' && s.thr > 0.15) {
      this.mark('space');
      this.stage = 'driving';
      this.teach(null);
    }
    if (this.stage === 'driving' && this.upshifts >= UPSHIFTS) {
      this.stage = 'cue-shift';
      this.teach('shift');
    }
    // the brake, when it is wanted
    if (this.brakeCue) {
      if (s.brake > 0.5) { this.brakeCue = false; this.mark('brake'); this.el.brake.classList.remove('teach'); }
    } else if (!this.done.brake && this.stage !== 'started') {
      // on the limiter in one gear, with automatic shifting, means there is no higher gear to take;
      // the brief fuel cut of each automatic upshift must not add up to the same thing
      if (s.gear !== this.limGear) { this.limGear = s.gear; this.limiter = 0; }
      if (s.mode === 'drive' && s.auto && s.thr > 0.5 && s.cut) this.limiter += dt;
      this.coast = s.mode === 'drive' && s.thr < 0.05 && s.speed > COAST_SPEED ? this.coast + dt : 0;
      if (s.brake > 0.5) this.mark('brake');      // found it unprompted
      else if (this.limiter >= LIMITER_S || this.coast >= COAST_S) { this.brakeCue = true; this.el.brake.classList.add('teach'); }
    }
  }
  /** The viewer shifted, or switched automatic shifting, themselves. */
  shifted() {
    this.mark('shift');
    if (!this.active) return;
    if (this.cue) this.teach(null);
    this.stage = 'done';
  }
}

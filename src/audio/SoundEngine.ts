import type { CrashEvent, FlightTelemetry } from "../sim/FlightController";

/**
 * Zero-dependency procedural Web Audio synthesizer for Raptor engine roar,
 * cryogenic venting, cold-gas RCS pulses, and RUD explosion sub-bass booms.
 * AudioContext is lazily created strictly on user interaction so headless smoke tests remain silent.
 */
export class SoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private cryoGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private muted = true;
  private lastRcsClickTime = 0;
  private lastExplodedId = -1;

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!muted) {
      this.ensureAudioGraph();
      if (this.ctx && this.ctx.state === "suspended") {
        void this.ctx.resume();
      }
    }
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.45, this.ctx.currentTime, 0.04);
    }
  }

  private ensureAudioGraph(): void {
    if (this.ctx || typeof window === "undefined") {
      return;
    }
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      return;
    }

    const ctx = new AudioCtx();
    this.ctx = ctx;

    // 2-second procedural brown/pink noise loop
    const sampleRate = ctx.sampleRate;
    const len = sampleRate * 2;
    const buf = ctx.createBuffer(1, len, sampleRate);
    const data = buf.getChannelData(0);
    let lastOut = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      lastOut = (lastOut + 0.04 * white) / 1.04;
      data[i] = Math.max(-1, Math.min(1, lastOut * 4.5 + white * 0.14));
    }
    this.noiseBuffer = buf;

    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 0.45;
    master.connect(ctx.destination);
    this.masterGain = master;

    // Continuous Raptor engine roar chain
    const engSrc = ctx.createBufferSource();
    engSrc.buffer = buf;
    engSrc.loop = true;

    const engFilter = ctx.createBiquadFilter();
    engFilter.type = "lowpass";
    engFilter.frequency.value = 180;
    engFilter.Q.value = 1.4;

    const engGain = ctx.createGain();
    engGain.gain.value = 0;

    engSrc.connect(engFilter);
    engFilter.connect(engGain);
    engGain.connect(master);
    engSrc.start();

    this.engineFilter = engFilter;
    this.engineGain = engGain;

    // Continuous cryogenic vent hiss chain
    const cryoSrc = ctx.createBufferSource();
    cryoSrc.buffer = buf;
    cryoSrc.loop = true;

    const cryoFilter = ctx.createBiquadFilter();
    cryoFilter.type = "highpass";
    cryoFilter.frequency.value = 1900;

    const cryoGain = ctx.createGain();
    cryoGain.gain.value = 0;

    cryoSrc.connect(cryoFilter);
    cryoFilter.connect(cryoGain);
    cryoGain.connect(master);
    cryoSrc.start();

    this.cryoGain = cryoGain;
  }

  update(
    tel: FlightTelemetry,
    cameraDistanceM: number,
    pressureBar: number,
    vehicleIntact: boolean
  ): void {
    if (this.muted || !this.ctx || !this.engineGain || !this.engineFilter || !this.cryoGain) {
      return;
    }

    const now = this.ctx.currentTime;
    const activeThr = vehicleIntact ? Math.max(tel.boosterThrottle, tel.shipThrottle) : 0;
    const distAtten = Math.min(1, 95 / Math.max(25, cameraDistanceM));
    // Atmospheric coupling: full exterior crackle on Earth, thinner on Mars, subtle hull rumble in Moon vacuum
    const atmCoupling = 0.22 + 0.78 * Math.min(1, pressureBar * 1.4);
    const targetEngGain =
      activeThr > 0.02 && !tel.paused ? activeThr * distAtten * atmCoupling * 0.78 : 0;
    const targetCutoff = 110 + activeThr * 720 * atmCoupling;

    this.engineGain.gain.setTargetAtTime(targetEngGain, now, 0.05);
    this.engineFilter.frequency.setTargetAtTime(targetCutoff, now, 0.06);

    const venting =
      vehicleIntact &&
      !tel.paused &&
      tel.missionMode === "launch" &&
      (tel.phase === "PRELAUNCH" || tel.phase === "COUNTDOWN") &&
      pressureBar > 0.001;
    this.cryoGain.gain.setTargetAtTime(venting ? 0.07 * distAtten : 0, now, 0.08);

    // Cold-gas RCS transient pulse clicks
    const rcsMag = Math.max(
      Math.abs(tel.rcsThrust.pitch),
      Math.abs(tel.rcsThrust.roll),
      Math.abs(tel.rcsThrust.yaw)
    );
    if (vehicleIntact && !tel.paused && rcsMag > 0.25 && now - this.lastRcsClickTime > 0.14) {
      this.lastRcsClickTime = now;
      this.triggerRcsPulse(rcsMag * distAtten);
    }
  }

  private triggerRcsPulse(intensity: number): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) {
      return;
    }
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const bp = this.ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1350;
    bp.Q.value = 2.0;

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.001, now);
    g.gain.linearRampToValueAtTime(0.11 * Math.min(1, intensity), now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.075);

    src.connect(bp);
    bp.connect(g);
    g.connect(this.masterGain);
    src.start(now);
    src.stop(now + 0.08);
  }

  triggerExplosion(event: CrashEvent, pressureBar: number): void {
    if (event.id === this.lastExplodedId) {
      return;
    }
    this.lastExplodedId = event.id;
    if (this.muted || !this.ctx || !this.masterGain || !this.noiseBuffer) {
      return;
    }

    const now = this.ctx.currentTime;
    // Sub-bass shockwave thump (always audible as structural impact + atmospheric boom)
    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(95, now);
    osc.frequency.exponentialRampToValueAtTime(24, now + 0.85);

    const oscGain = this.ctx.createGain();
    oscGain.gain.setValueAtTime(0.7, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 1.1);

    osc.connect(oscGain);
    oscGain.connect(this.masterGain);
    osc.start(now);
    osc.stop(now + 1.15);

    // Blast debris roar scaled by atmosphere
    const atm = 0.2 + 0.8 * Math.min(1, pressureBar * 1.4);
    const nSrc = this.ctx.createBufferSource();
    nSrc.buffer = this.noiseBuffer;

    const lp = this.ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(950 * atm + 150, now);
    lp.frequency.exponentialRampToValueAtTime(90, now + 1.6);

    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.85 * atm, now);
    nGain.gain.exponentialRampToValueAtTime(0.001, now + 1.65);

    nSrc.connect(lp);
    lp.connect(nGain);
    nGain.connect(this.masterGain);
    nSrc.start(now);
    nSrc.stop(now + 1.7);
  }

  dispose(): void {
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.masterGain = null;
    this.engineFilter = null;
    this.engineGain = null;
    this.cryoGain = null;
    this.noiseBuffer = null;
  }
}

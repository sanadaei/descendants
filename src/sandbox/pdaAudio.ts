/**
 * Descendants PDA terminal sound engine.
 *
 * This intentionally preserves the Web Audio synthesis vocabulary of the
 * user-provided ZONE_PDA reference (click, hover, tab chirp, confirmation,
 * warning buzz, static burst and low-rate sensor ticks) without shipping or
 * reusing any external audio asset.
 */

type StoredAudioSettings = {
  masterVolume: number;
  sensorVolume: number;
  muted: boolean;
  sensorTicks: boolean;
};

const STORAGE_KEY = 'descendants.pda.audio.v1';
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function loadSettings(): StoredAudioSettings {
  const fallback: StoredAudioSettings = { masterVolume: 0.6, sensorVolume: 0.4, muted: false, sensorTicks: true };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredAudioSettings>;
    return {
      masterVolume: typeof parsed.masterVolume === 'number' ? clamp01(parsed.masterVolume) : fallback.masterVolume,
      sensorVolume: typeof parsed.sensorVolume === 'number' ? clamp01(parsed.sensorVolume) : fallback.sensorVolume,
      muted: parsed.muted === true,
      sensorTicks: parsed.sensorTicks !== false,
    };
  } catch {
    return fallback;
  }
}

class PdaSoundEngine {
  #ctx: AudioContext | null = null;
  #masterGain: GainNode | null = null;
  #sensorGain: GainNode | null = null;
  #sensorTimer = 0;
  #unlocked = false;
  #settings = loadSettings();

  get settings(): Readonly<StoredAudioSettings> { return { ...this.#settings }; }
  get initialized(): boolean { return this.#ctx !== null; }

  private persist(): void {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#settings)); } catch { /* non-critical */ }
  }

  private init(): void {
    if (this.#ctx) return;
    this.#ctx = new AudioContext();
    this.#masterGain = this.#ctx.createGain();
    this.#sensorGain = this.#ctx.createGain();
    this.#masterGain.gain.setValueAtTime(this.#settings.muted ? 0 : this.#settings.masterVolume, this.#ctx.currentTime);
    this.#sensorGain.gain.setValueAtTime(this.#settings.sensorVolume, this.#ctx.currentTime);
    this.#sensorGain.connect(this.#masterGain);
    this.#masterGain.connect(this.#ctx.destination);
  }

  unlock(): void {
    this.init();
    this.#unlocked = true;
    if (this.#ctx?.state === 'suspended') void this.#ctx.resume();
    this.scheduleSensorTick();
  }

  private ready(): { ctx: AudioContext; master: GainNode } | null {
    if (!this.#unlocked) return null;
    this.init();
    if (!this.#ctx || !this.#masterGain) return null;
    if (this.#ctx.state === 'suspended') void this.#ctx.resume();
    return { ctx: this.#ctx, master: this.#masterGain };
  }

  setMasterVolume(value: number): void {
    this.#settings.masterVolume = clamp01(value);
    this.persist();
    if (this.#masterGain && this.#ctx) this.#masterGain.gain.setValueAtTime(this.#settings.muted ? 0 : this.#settings.masterVolume, this.#ctx.currentTime);
  }

  setSensorVolume(value: number): void {
    this.#settings.sensorVolume = clamp01(value);
    this.persist();
    if (this.#sensorGain && this.#ctx) this.#sensorGain.gain.setValueAtTime(this.#settings.sensorVolume, this.#ctx.currentTime);
  }

  setSensorTicks(enabled: boolean): void {
    this.#settings.sensorTicks = enabled;
    this.persist();
    if (!enabled && this.#sensorTimer) { window.clearTimeout(this.#sensorTimer); this.#sensorTimer = 0; }
    if (enabled && this.#unlocked) this.scheduleSensorTick(true);
  }

  toggleMute(): boolean {
    this.#settings.muted = !this.#settings.muted;
    this.persist();
    if (this.#masterGain && this.#ctx) this.#masterGain.gain.setValueAtTime(this.#settings.muted ? 0 : this.#settings.masterVolume, this.#ctx.currentTime);
    return this.#settings.muted;
  }

  playClick(): void {
    const ready = this.ready(); if (!ready) return;
    const { ctx, master } = ready; const now = ctx.currentTime;
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = 'triangle'; osc.frequency.setValueAtTime(1400, now); osc.frequency.exponentialRampToValueAtTime(120, now + 0.03);
    gain.gain.setValueAtTime(0.4, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
    osc.connect(gain); gain.connect(master); osc.start(now); osc.stop(now + 0.04);
  }

  playHover(): void {
    const ready = this.ready(); if (!ready) return;
    const { ctx, master } = ready; const now = ctx.currentTime;
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(2400, now); osc.frequency.exponentialRampToValueAtTime(1800, now + 0.015);
    gain.gain.setValueAtTime(0.08, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.015);
    osc.connect(gain); gain.connect(master); osc.start(now); osc.stop(now + 0.02);
  }

  playTabSwitch(): void {
    const ready = this.ready(); if (!ready) return;
    const { ctx, master } = ready; const now = ctx.currentTime;
    const osc1 = ctx.createOscillator(); const osc2 = ctx.createOscillator(); const gain = ctx.createGain();
    osc1.type = 'square'; osc2.type = 'sawtooth';
    osc1.frequency.setValueAtTime(1800, now); osc1.frequency.setValueAtTime(2400, now + 0.02);
    osc2.frequency.setValueAtTime(900, now); osc2.frequency.setValueAtTime(1200, now + 0.02);
    gain.gain.setValueAtTime(0.15, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    osc1.connect(gain); osc2.connect(gain); gain.connect(master); osc1.start(now); osc2.start(now); osc1.stop(now + 0.07); osc2.stop(now + 0.07);
  }

  playConfirm(): void {
    const ready = this.ready(); if (!ready) return;
    const { ctx, master } = ready; const now = ctx.currentTime;
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = 'triangle'; osc.frequency.setValueAtTime(880, now); osc.frequency.setValueAtTime(1320, now + 0.05);
    gain.gain.setValueAtTime(0.25, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    osc.connect(gain); gain.connect(master); osc.start(now); osc.stop(now + 0.16);
  }

  playCommandCommit(): void {
    const ready = this.ready(); if (!ready) return;
    const { ctx, master } = ready; const now = ctx.currentTime;
    const carrier = ctx.createOscillator(); const pulse = ctx.createOscillator(); const gain = ctx.createGain();
    carrier.type = 'square'; pulse.type = 'triangle';
    carrier.frequency.setValueAtTime(420, now); carrier.frequency.setValueAtTime(760, now + 0.055);
    pulse.frequency.setValueAtTime(1180, now + 0.035); pulse.frequency.setValueAtTime(1640, now + 0.09);
    gain.gain.setValueAtTime(0.001, now); gain.gain.exponentialRampToValueAtTime(0.22, now + 0.012); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
    carrier.connect(gain); pulse.connect(gain); gain.connect(master);
    carrier.start(now); pulse.start(now + 0.03); carrier.stop(now + 0.16); pulse.stop(now + 0.16);
  }

  playUncheck(): void {
    const ready = this.ready(); if (!ready) return;
    const { ctx, master } = ready; const now = ctx.currentTime;
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = 'triangle'; osc.frequency.setValueAtTime(1100, now); osc.frequency.setValueAtTime(700, now + 0.05);
    gain.gain.setValueAtTime(0.2, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(gain); gain.connect(master); osc.start(now); osc.stop(now + 0.13);
  }

  playBuzz(): void {
    const ready = this.ready(); if (!ready) return;
    const { ctx, master } = ready; const now = ctx.currentTime;
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = 'sawtooth'; osc.frequency.setValueAtTime(120, now); osc.frequency.setValueAtTime(90, now + 0.1);
    gain.gain.setValueAtTime(0.3, now); gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    osc.connect(gain); gain.connect(master); osc.start(now); osc.stop(now + 0.2);
  }

  playStatic(duration = 0.1, volume = 0.2): void {
    const ready = this.ready(); if (!ready) return;
    const { ctx, master } = ready; const now = ctx.currentTime;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate); const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); const filter = ctx.createBiquadFilter(); const gain = ctx.createGain();
    noise.buffer = buffer; filter.type = 'bandpass'; filter.frequency.setValueAtTime(2500, now); filter.Q.setValueAtTime(1.2, now);
    gain.gain.setValueAtTime(volume, now); gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    noise.connect(filter); filter.connect(gain); gain.connect(master); noise.start(now); noise.stop(now + duration);
  }

  private playSensorClick(): void {
    if (!this.#unlocked || !this.#settings.sensorTicks || this.#settings.muted || this.#settings.sensorVolume <= 0.01 || !this.#ctx || !this.#sensorGain) return;
    const now = this.#ctx.currentTime; const osc = this.#ctx.createOscillator(); const gain = this.#ctx.createGain();
    osc.type = 'square'; osc.frequency.setValueAtTime(3000 + Math.random() * 1500, now);
    gain.gain.setValueAtTime(0.15 + Math.random() * 0.25, now); gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.004);
    osc.connect(gain); gain.connect(this.#sensorGain); osc.start(now); osc.stop(now + 0.005);
  }

  private scheduleSensorTick(force = false): void {
    if (!this.#unlocked || !this.#settings.sensorTicks) return;
    if (this.#sensorTimer && !force) return;
    if (this.#sensorTimer) window.clearTimeout(this.#sensorTimer);
    // Preserve the sparse ZONE_PDA sensor-click character without implying a
    // specific radiation mechanic in Descendants.
    const interval = 2000 * (0.3 + Math.random() * 1.4);
    this.#sensorTimer = window.setTimeout(() => {
      this.#sensorTimer = 0;
      this.playSensorClick();
      this.scheduleSensorTick();
    }, interval);
  }
}

export const pdaAudio = new PdaSoundEngine();

/**
 * audio.js — AudioManager: fully procedural WebAudio soundscape.
 *
 * No audio files are shipped: wind, carving, impacts, UI and the
 * generative music system are all synthesised at runtime, which keeps
 * the game a zero-asset download and lets every sound react to game
 * state (speed, surface, weather) continuously.
 */

export class AudioManager {
  constructor(game) {
    this.game = game;
    this.ctx = null;
    this.unlocked = false;

    this.master = null;
    this.musicBus = null;
    this.sfxBus = null;

    this.windGain = null;
    this.carveGain = null;
    this.carveFilter = null;
    this.edgeOsc = null;
    this.edgeGain = null;

    this.musicTimer = 0;
    this.chordIndex = 0;
    this.nextNoteTime = 0;

    // Chord progressions (semitone offsets from root A2).
    this.progression = [
      [0, 7, 12, 16], [-4, 3, 12, 19], [-7, 0, 9, 16], [-2, 5, 12, 17]
    ];
    this.scale = [0, 3, 5, 7, 10, 12, 15, 19];

    const unlock = () => this.unlock();
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });

    this.bindEvents();
  }

  unlock() {
    if (this.unlocked) {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (err) {
      console.warn('[Audio] WebAudio unavailable.', err);
      return;
    }
    this.unlocked = true;
    this.buildGraph();
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.unlocked) return;
    const s = this.game.save.profile.settings;
    this.master.gain.value = s.master;
    this.musicBus.gain.value = s.music;
    this.sfxBus.gain.value = s.sfx;
  }

  buildGraph() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);

    this.musicBus = ctx.createGain();
    this.musicBus.connect(this.master);
    this.sfxBus = ctx.createGain();
    this.sfxBus.connect(this.master);

    // Shared noise buffer.
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // --- wind loop ---
    const wind = ctx.createBufferSource();
    wind.buffer = this.noiseBuffer;
    wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 300;
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.sfxBus);
    wind.start();

    // --- board carve loop ---
    const carve = ctx.createBufferSource();
    carve.buffer = this.noiseBuffer;
    carve.loop = true;
    carve.playbackRate.value = 0.7;
    this.carveFilter = ctx.createBiquadFilter();
    this.carveFilter.type = 'highpass';
    this.carveFilter.frequency.value = 1600;
    this.carveGain = ctx.createGain();
    this.carveGain.gain.value = 0;
    carve.connect(this.carveFilter).connect(this.carveGain).connect(this.sfxBus);
    carve.start();

    // --- icy edge whine (audible on hard ice) ---
    this.edgeOsc = ctx.createOscillator();
    this.edgeOsc.type = 'sawtooth';
    this.edgeOsc.frequency.value = 90;
    const edgeFilter = ctx.createBiquadFilter();
    edgeFilter.type = 'lowpass';
    edgeFilter.frequency.value = 500;
    this.edgeGain = ctx.createGain();
    this.edgeGain.gain.value = 0;
    this.edgeOsc.connect(edgeFilter).connect(this.edgeGain).connect(this.sfxBus);
    this.edgeOsc.start();

    // Music pad bus with gentle lowpass.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.connect(this.musicBus);
  }

  /* ---------------- one-shot synthesis helpers ---------------- */

  blip(freq, dur = 0.12, type = 'sine', gain = 0.25, slide = 0) {
    if (!this.unlocked) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  noiseBurst(dur = 0.25, freq = 800, q = 1, gain = 0.4, type = 'bandpass') {
    if (!this.unlocked) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  chime(notes, base = 440, step = 0.07, gain = 0.2) {
    if (!this.unlocked) return;
    notes.forEach((n, i) => {
      setTimeout(() => this.blip(base * Math.pow(2, n / 12), 0.35, 'sine', gain), i * step * 1000);
    });
  }

  /* ---------------- event bindings ---------------- */

  bindEvents() {
    const bus = this.game.bus;
    bus.on('ui-click', () => this.blip(660, 0.05, 'triangle', 0.12));
    bus.on('ui-open', () => this.blip(520, 0.08, 'triangle', 0.1));
    bus.on('jump', () => this.noiseBurst(0.3, 1400, 0.8, 0.25, 'highpass'));
    bus.on('landing', (e) => {
      if (e.quality !== 'crash') {
        this.noiseBurst(0.18, 300, 1, Math.min(0.5, 0.15 + e.impact * 0.02), 'lowpass');
      }
    });
    bus.on('perfect', () => this.chime([0, 7, 12], 660, 0.05, 0.16));
    bus.on('crash', () => {
      this.noiseBurst(0.5, 250, 0.7, 0.55, 'lowpass');
      this.blip(120, 0.4, 'sawtooth', 0.2, -60);
    });
    bus.on('collect', () => this.chime([0, 12], 880, 0.04, 0.14));
    bus.on('ring', () => this.chime([0, 5, 12], 520, 0.05, 0.18));
    bus.on('bounce', () => this.blip(220, 0.25, 'sine', 0.3, 340));
    bus.on('powerup', () => this.chime([0, 7, 12, 19], 620, 0.05, 0.2));
    bus.on('shield-save', () => this.chime([12, 5, 0], 440, 0.07, 0.22));
    bus.on('arch', () => this.chime([0, 4, 9], 700, 0.04, 0.16));
    bus.on('power-used', () => this.chime([0, 12], 520, 0.04, 0.18));
    bus.on('power-denied', () => this.blip(180, 0.12, 'square', 0.08));
    bus.on('ramp', () => this.noiseBurst(0.25, 900, 1, 0.2, 'highpass'));
    bus.on('checkpoint', () => this.chime([0, 4, 7, 12], 540, 0.06, 0.2));
    bus.on('countdown', (e) => this.blip(e.n === 0 ? 880 : 440, 0.18, 'square', 0.15));
    bus.on('levelup', () => this.chime([0, 4, 7, 12, 16], 440, 0.09, 0.22));
    bus.on('achievement', () => this.chime([0, 5, 9, 12], 587, 0.08, 0.2));
    bus.on('trick', (e) => {
      if (e.points > 800) this.chime([0, 7], 740, 0.05, 0.12);
    });
    bus.on('session-end', () => this.chime([0, 4, 7, 12], 494, 0.1, 0.2));
  }

  /* ---------------- continuous update ---------------- */

  update(dt) {
    if (!this.unlocked) return;
    const game = this.game;
    const player = game.player;
    const playing = game.state === 'playing';

    // Wind: from rider speed + weather wind.
    let windLevel = 0.04;
    if (playing && player) {
      const speed = player.speed;
      windLevel = Math.min(0.5, 0.03 + speed * 0.008);
      if (!player.body.grounded) windLevel *= 1.5;
    }
    if (game.weather) windLevel += game.weather.wind.length() * 0.03;
    this.windGain.gain.value += (windLevel - this.windGain.gain.value) * Math.min(1, dt * 3);
    this.windFilter.frequency.value = 240 + windLevel * 900;

    // Carve: intensity + surface character.
    let carveLevel = 0, edgeLevel = 0;
    if (playing && player && player.body.grounded && player.crashTimer <= 0) {
      const icy = Math.min(1, Math.max(0, player.body.surface));
      carveLevel = Math.min(0.4, player.carveIntensity * 0.35 + player.speed * 0.003);
      // Snow is a broadband hiss; ice whines and rings.
      this.carveFilter.frequency.value = 1200 + icy * 2600;
      edgeLevel = icy * Math.min(0.06, player.speed * 0.002) * (0.4 + player.carveIntensity);
      this.edgeOsc.frequency.value = 70 + player.speed * 3.5;
    }
    this.carveGain.gain.value += (carveLevel - this.carveGain.gain.value) * Math.min(1, dt * 8);
    this.edgeGain.gain.value += (edgeLevel - this.edgeGain.gain.value) * Math.min(1, dt * 6);

    // Boost roar.
    if (playing && player && player.boosting) {
      this.windGain.gain.value = Math.min(0.7, this.windGain.gain.value + 0.2);
    }

    this.updateMusic();
  }

  updateMusic() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.currentTime + 0.3 < this.nextNoteTime) return;

    const zen = this.game.mode && this.game.mode.zen;
    const chordDur = zen ? 9 : 6.5;
    const chord = this.progression[this.chordIndex % this.progression.length];
    this.chordIndex++;
    const t = Math.max(ctx.currentTime, this.nextNoteTime);
    this.nextNoteTime = t + chordDur;

    const root = 110; // A2
    // Pad: detuned triangles per chord tone.
    for (const semi of chord) {
      for (const detune of [-4, 4]) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = root * Math.pow(2, semi / 12);
        osc.detune.value = detune;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.028, t + chordDur * 0.35);
        g.gain.linearRampToValueAtTime(0.0001, t + chordDur);
        osc.connect(g).connect(this.padFilter);
        osc.start(t);
        osc.stop(t + chordDur + 0.1);
      }
    }
    // Sparse bell melody.
    const bells = zen ? 2 : 3;
    for (let i = 0; i < bells; i++) {
      if (Math.random() < 0.35) continue;
      const semi = this.scale[Math.floor(Math.random() * this.scale.length)] + 24;
      const bt = t + (i + Math.random() * 0.5) * (chordDur / (bells + 1));
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = root * Math.pow(2, semi / 12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, bt);
      g.gain.linearRampToValueAtTime(0.05, bt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, bt + 2.2);
      osc.connect(g).connect(this.musicBus);
      osc.start(bt);
      osc.stop(bt + 2.4);
    }
  }
}

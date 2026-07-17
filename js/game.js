/**
 * game.js — Main bootstrap and orchestration.
 *
 * Owns the renderer, the fixed-timestep simulation loop, the game state
 * machine (menu / playing / paused / photo / results), session & mode
 * logic (checkpoints, timers, races, avalanche), quality scaling and the
 * shared infrastructure: EventBus, AssetManager, InputManager, Profiler.
 */

import * as THREE from 'three';
import { PhysicsEngine } from './physics.js';
import { World } from './world.js';
import { Player } from './player.js';
import { AIManager } from './ai.js';
import { WeatherSystem } from './weather.js';
import { CameraManager } from './camera.js';
import { UIManager } from './ui.js';
import { AudioManager } from './audio.js';
import { SaveManager } from './save.js';

/* ================================================================== */
/* EventBus                                                            */
/* ================================================================== */

export class EventBus {
  constructor() { this.listeners = new Map(); }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) { this.listeners.get(event)?.delete(fn); }
  emit(event, payload) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); }
      catch (err) { console.error(`[Bus] listener for "${event}" failed:`, err); }
    }
  }
}

/* ================================================================== */
/* AssetManager                                                        */
/* ================================================================== */

export class AssetManager {
  constructor() {
    this.configs = {};
    this.shaders = {};
  }

  async loadJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
    return res.json();
  }

  async loadText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
    return res.text();
  }

  /** Parse "// #SECTION" delimited GLSL files into { SECTION: code }. */
  parseSections(text) {
    const sections = {};
    let name = null, buf = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*\/\/\s*#([A-Z_]+)\s*$/);
      if (m) {
        if (name) sections[name] = buf.join('\n');
        name = m[1];
        buf = [];
      } else if (name) {
        buf.push(line);
      }
    }
    if (name) sections[name] = buf.join('\n');
    return sections;
  }

  async loadAll(onProgress) {
    const configFiles = ['gameplay', 'physics', 'weather', 'maps', 'obstacles', 'tricks', 'progression'];
    const shaderFiles = ['sky', 'aurora', 'snow', 'ice', 'clouds'];
    const total = configFiles.length + shaderFiles.length;
    let done = 0;
    const tick = () => { done++; if (onProgress) onProgress(done / total); };

    await Promise.all([
      ...configFiles.map(async (n) => {
        this.configs[n] = await this.loadJSON(`config/${n}.json`);
        tick();
      }),
      ...shaderFiles.map(async (n) => {
        this.shaders[n] = this.parseSections(await this.loadText(`shaders/${n}.glsl`));
        tick();
      })
    ]);
    return this.configs;
  }
}

/* ================================================================== */
/* InputManager                                                        */
/* ================================================================== */

export class InputManager {
  constructor(game) {
    this.game = game;
    this.keys = new Set();           // active key codes
    this.codeMap = new Map();        // code -> action
    this.touchButtons = {};          // action -> bool
    this.touchAxes = { steer: 0, pitch: 0 };
    this.smoothSteer = 0;
    this.smoothPitch = 0;
    this.gamepadIndex = null;
    this.prevGamepadButtons = [];

    const controls = game.config.gameplay.controls;
    for (const [action, codes] of Object.entries(controls)) {
      for (const code of codes) this.codeMap.set(code, action);
    }

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      // Power slots on 1-5 (top row or numpad).
      const powerMatch = e.code.match(/^(?:Digit|Numpad)([1-5])$/);
      if (powerMatch) {
        game.bus.emit('action', { action: 'power', slot: Number(powerMatch[1]) });
        return;
      }
      const action = this.codeMap.get(e.code);
      if (!action) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
      this.keys.add(e.code);
      // Edge-triggered meta actions go through the bus.
      if (['pause', 'camera', 'photo', 'reset'].includes(action)) {
        game.bus.emit('action', { action });
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });
  }

  actionKeyDown(action) {
    const codes = this.game.config.gameplay.controls[action] || [];
    return codes.some((c) => this.keys.has(c));
  }

  isDown(action) {
    if (this.actionKeyDown(action)) return true;
    if (this.touchButtons[action]) return true;
    const gp = this.gamepad();
    if (gp) {
      const map = { jump: 0, grab: 1, boost: 2, tuck: 7, brake: 6 };
      if (action in map && gp.buttons[map[action]]?.pressed) return true;
    }
    return false;
  }

  gamepad() {
    if (this.gamepadIndex === null) return null;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return pads[this.gamepadIndex] || null;
  }

  axis(name) {
    if (name === 'steer') return this.smoothSteer;
    if (name === 'pitch') return this.smoothPitch;
    return 0;
  }

  setTouchAxis(steer, pitch) {
    this.touchAxes.steer = THREE.MathUtils.clamp(steer, -1, 1);
    this.touchAxes.pitch = THREE.MathUtils.clamp(pitch, -1, 1);
  }

  setTouchButton(action, down) {
    this.touchButtons[action] = down;
    if (down && ['pause', 'camera', 'photo', 'reset'].includes(action)) {
      this.game.bus.emit('action', { action });
      this.touchButtons[action] = false;
    }
  }

  update(dt) {
    // Keyboard digital -> analog smoothing.
    // NOTE on signs: the chase camera looks down +Z (downhill), which makes
    // screen-right equal world -X. Positive steer increases heading (turns
    // toward world +X = screen LEFT), so "left" inputs map to +1 here.
    let steerTarget = 0;
    if (this.actionKeyDown('steerLeft')) steerTarget += 1;
    if (this.actionKeyDown('steerRight')) steerTarget -= 1;
    let pitchTarget = 0;
    if (this.actionKeyDown('tuck')) pitchTarget += 1;
    if (this.actionKeyDown('brake')) pitchTarget -= 1;

    const gp = this.gamepad();
    if (gp) {
      const gx = gp.axes[0] || 0, gy = gp.axes[1] || 0;
      if (Math.abs(gx) > 0.12) steerTarget -= gx;
      if (Math.abs(gy) > 0.15) pitchTarget += -gy;
      // Edge-triggered gamepad buttons: 9 = start (pause), 3 = Y (camera).
      const edges = { 9: 'pause', 3: 'camera' };
      for (const [idx, action] of Object.entries(edges)) {
        const now = gp.buttons[idx]?.pressed || false;
        if (now && !this.prevGamepadButtons[idx]) this.game.bus.emit('action', { action });
        this.prevGamepadButtons[idx] = now;
      }
    }

    // Touch stick reports screen-space dx (right = +), so it flips too.
    steerTarget = THREE.MathUtils.clamp(steerTarget - this.touchAxes.steer, -1, 1);
    pitchTarget = THREE.MathUtils.clamp(pitchTarget + this.touchAxes.pitch, -1, 1);

    const rate = Math.min(1, dt * 7);
    this.smoothSteer += (steerTarget - this.smoothSteer) * rate;
    this.smoothPitch += (pitchTarget - this.smoothPitch) * rate;
    if (Math.abs(this.smoothSteer) < 0.01 && steerTarget === 0) this.smoothSteer = 0;
    if (Math.abs(this.smoothPitch) < 0.01 && pitchTarget === 0) this.smoothPitch = 0;
  }
}

/* ================================================================== */
/* Profiler                                                            */
/* ================================================================== */

export class Profiler {
  constructor(game) {
    this.game = game;
    this.fps = 60;
    this.frameMs = 16;
    this.checkTimer = 4;
    this.lowStreak = 0;
    this.highStreak = 0;
  }

  frame(dt) {
    const fps = 1 / Math.max(dt, 0.0001);
    this.fps += (fps - this.fps) * 0.05;
    this.frameMs += (dt * 1000 - this.frameMs) * 0.05;

    if (this.game.save.profile.settings.quality !== 'auto') return;
    this.checkTimer -= dt;
    if (this.checkTimer > 0) return;
    this.checkTimer = 4;

    if (this.fps < 42) { this.lowStreak++; this.highStreak = 0; }
    else if (this.fps > 57) { this.highStreak++; this.lowStreak = 0; }
    else { this.lowStreak = 0; this.highStreak = 0; }

    const order = ['low', 'medium', 'high'];
    const idx = order.indexOf(this.game.qualityLevel);
    if (this.lowStreak >= 2 && idx > 0) {
      this.game.applyQuality(order[idx - 1]);
      this.lowStreak = 0;
    } else if (this.highStreak >= 4 && idx < order.length - 1) {
      this.game.applyQuality(order[idx + 1]);
      this.highStreak = 0;
    }
  }
}

/* ================================================================== */
/* Quality presets                                                     */
/* ================================================================== */

/**
 * Sky themes — one is picked at random every time a run (or the menu
 * world) starts, recoloring sky dome, fog, reflections and ambient light.
 */
const SKY_THEMES = [
  { name: 'Rose Dawn',    top: '#e87fb4', horizon: '#ffdcee', fog: '#f2cade' },
  { name: 'Mint Glacier', top: '#4ec9a0', horizon: '#e4fff3', fog: '#c8ecdb' },
  { name: 'Violet Dream', top: '#8b6fe8', horizon: '#ecdcff', fog: '#d7c4ef' },
  { name: 'Golden Hour',  top: '#f0b23e', horizon: '#fff3d0', fog: '#f0deb2' },
  { name: 'Polar Blue',   top: '#2f6fce', horizon: '#cfe6f7', fog: '#cfdff0' },
  { name: 'Peach Frost',  top: '#f28a60', horizon: '#ffe6d5', fog: '#f2d2c0' },
  { name: 'Aqua Aurora',  top: '#35b8c9', horizon: '#defbff', fog: '#c5ecf0' },
  { name: 'Lilac Dusk',   top: '#b57fd6', horizon: '#ffe3f4', fog: '#e3c8e6' }
];

const QUALITY_PRESETS = {
  low: {
    pixelRatio: 1, shadowMap: 1024, shadows: true, obstacleShadows: false,
    snowParticles: 900, viewRadius: 2, detailRadius: 1
  },
  medium: {
    pixelRatio: 1.5, shadowMap: 2048, shadows: true, obstacleShadows: true,
    snowParticles: 2200, viewRadius: 3, detailRadius: 1
  },
  high: {
    pixelRatio: 2, shadowMap: 4096, shadows: true, obstacleShadows: true,
    snowParticles: 3800, viewRadius: 4, detailRadius: 2
  }
};

/* ================================================================== */
/* Game                                                                */
/* ================================================================== */

export class Game {
  constructor() {
    this.state = 'boot';
    this.elapsed = 0;
    this.accumulator = 0;
    this.session = null;
    this.mode = null;
    this.map = null;
    this.bus = new EventBus();
    this.assets = new AssetManager();
    this.config = null;
    this.qualityLevel = 'medium';
    this.quality = { ...QUALITY_PRESETS.medium };
    this.lastFrame = performance.now();
    // Time Warp power: scales simulation speed (1 = realtime).
    this.timeScale = 1;
    this.timeScaleTimer = 0;
    // Coarse-pointer devices get mobile-tuned rendering defaults.
    this.isMobile = ('ontouchstart' in window || navigator.maxTouchPoints > 0)
      && window.matchMedia('(pointer: coarse)').matches;
  }

  setTimeScale(scale, duration) {
    this.timeScale = scale;
    this.timeScaleTimer = duration;
    document.getElementById('app').classList.toggle('slowmo', scale < 1);
  }

  async init() {
    const canvas = document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance'
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      70, window.innerWidth / window.innerHeight, 0.1, 2400
    );
    this.camera.position.set(0, 40, -60);

    // --- load configs & shaders ---
    const barFill = document.getElementById('loading-bar-fill');
    this.config = await this.assets.loadAll((p) => {
      if (barFill) barFill.style.width = `${Math.round(p * 100)}%`;
    });

    // --- managers (order matters only for construction-time deps) ---
    this.save = new SaveManager(this);
    await this.save.init();
    this.input = new InputManager(this);
    this.physics = new PhysicsEngine(this);
    this.world = new World(this);
    this.weather = new WeatherSystem(this);
    this.player = new Player(this);
    this.ai = new AIManager(this);
    this.cameras = new CameraManager(this);
    this.audio = new AudioManager(this);
    this.profiler = new Profiler(this);
    this.ui = new UIManager(this);
    this.ui.build();

    const pref = this.save.profile.settings.quality;
    // Phones/tablets start one notch lower in auto mode; the profiler can
    // still upgrade them if the device proves fast.
    this.applyQuality(pref === 'auto' ? (this.isMobile ? 'low' : 'medium') : pref, true);

    this.bindGlobalEvents();
    this.resize();
    window.addEventListener('resize', () => this.resize());

    // --- menu world behind the main menu ---
    this.loadMenuWorld();
    this.ui.showScreen('main');
    this.state = 'menu';

    this.renderer.setAnimationLoop(() => this.frame());
  }

  bindGlobalEvents() {
    this.bus.on('action', ({ action, slot }) => {
      if (action === 'pause') this.handlePauseAction();
      else if (action === 'camera' && this.state === 'playing') this.cameras.cycleMode();
      else if (action === 'photo') this.togglePhotoMode();
      else if (action === 'reset' && this.state === 'playing') this.player.respawn();
      else if (action === 'power' && this.state === 'playing') this.player.activatePower(slot);
    });
    window.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });
  }

  handlePauseAction() {
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
    else if (this.state === 'photo') this.togglePhotoMode();
  }

  applyQuality(level, initial = false) {
    if (!QUALITY_PRESETS[level]) level = 'medium';
    this.qualityLevel = level;
    this.quality = { ...QUALITY_PRESETS[level] };
    const q = this.quality;
    if (this.isMobile) {
      // High-DPI phone screens burn fill-rate fast; cap resolution and
      // shadow cost so battery and frame rate hold up.
      q.pixelRatio = Math.min(q.pixelRatio, 1.6);
      q.shadowMap = Math.min(q.shadowMap, 2048);
      q.snowParticles = Math.round(q.snowParticles * 0.6);
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    this.renderer.shadowMap.enabled = q.shadows;
    this.world.viewRadius = q.viewRadius;
    this.world.detailRadius = q.detailRadius;
    this.world.obstacleRadius = Math.min(2, q.viewRadius);
    if (this.world.sun) this.world.sun.shadow.mapSize.setScalar(q.shadowMap);
    if (!initial) this.bus.emit('quality', { level });
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  /* ---------------- menu / session flow ---------------- */

  unlockedMaps() {
    const level = this.save.level;
    return this.config.maps.maps.filter((m) => m.unlockLevel <= level);
  }

  pickSkyTheme() {
    return SKY_THEMES[Math.floor(Math.random() * SKY_THEMES.length)];
  }

  loadMenuWorld() {
    const map = this.unlockedMaps()[0] || this.config.maps.maps[0];
    this.world.loadMap(map, this.pickSkyTheme());
    this.weather.setupForMap(this.world.map, { weatherDynamic: true });
    this.cameras.menuPhase = 0;
  }

  startSession(mapId, modeId) {
    const map = this.config.maps.maps.find((m) => m.id === mapId);
    const mode = this.config.gameplay.modes.find((m) => m.id === modeId);
    if (!map || !mode) return;

    this.ui.showSessionLoading(map, mode);
    // Yield a frame so the loading overlay paints before the heavy sync work.
    setTimeout(() => this.buildSession(map, mode), 60);
  }

  buildSession(map, mode) {
    const gp = this.config.gameplay;
    this.map = map;
    this.mode = mode;

    const sky = this.pickSkyTheme();
    this.skyTheme = sky;
    this.world.loadMap(map, sky);
    this.weather.setupForMap(this.world.map, mode);
    this.bus.emit('sky-theme', sky);

    const spawn = this.world.spawnPoint();
    this.player.buildMesh();
    this.player.spawn(spawn.x, spawn.z, 0);

    if (mode.checkpoints > 0) this.world.buildCheckpoints(mode.checkpoints);
    this.ai.spawnForSession(mode);

    this.session = {
      mapId: map.id, modeId: mode.id,
      time: 0, timeLeft: mode.timeLimit || 0,
      score: 0, trickScore: 0,
      distance: 0, topSpeed: 0, airTime: 0,
      crystals: 0, boost: 30,
      checkpointIndex: 0, splits: [],
      finished: false, outcome: null,
      countdown: gp.session.countdownSeconds + 0.999,
      recordGhost: !!mode.ghost,
      avalancheZ: null, position: 0,
      ghostBestTime: null
    };

    if (mode.avalanche) {
      this.session.avalancheZ = spawn.z - this.config.physics.avalanche.startDistance;
      this.world.createAvalanche(this.session.avalancheZ);
    }
    if (mode.ghost) {
      this.ai.loadGhost(map.id).then((t) => {
        if (this.session) this.session.ghostBestTime = t;
      });
    }

    this.accumulator = 0;
    this.state = 'playing';
    this.ui.showHUD();
    this.bus.emit('session-start', { map, mode });
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.ui.showScreen('pause');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.ui.showHUD();
  }

  togglePhotoMode() {
    if (this.state === 'playing') {
      this.state = 'photo';
      this.cameras.enterPhotoMode();
      this.ui.showPhotoUI(true);
    } else if (this.state === 'photo') {
      this.state = 'playing';
      this.cameras.exitPhotoMode();
      this.ui.showPhotoUI(false);
      this.ui.showHUD();
    }
  }

  restartSession() {
    if (!this.map || !this.mode) return;
    const map = this.map, mode = this.mode;
    this.teardownSession();
    this.ui.showSessionLoading(map, mode);
    setTimeout(() => this.buildSession(map, mode), 60);
  }

  teardownSession() {
    this.setTimeScale(1, 0);
    this.ai.clear();
    this.player.disposeMesh();
    this.session = null;
  }

  returnToMenu() {
    this.teardownSession();
    this.mode = null;
    this.map = null;
    this.loadMenuWorld();
    this.state = 'menu';
    this.ui.showScreen('main');
  }

  /* ---------------- mode logic ---------------- */

  updateModeLogic(dt) {
    const s = this.session;
    const mode = this.mode;
    if (!s || s.finished) return;

    // Continuous score for distance modes.
    if (mode.distanceScore) {
      s.score = s.trickScore + Math.floor(s.distance * 10);
    } else if (mode.scoring) {
      s.score = s.trickScore;
    }

    // Checkpoints.
    if (mode.checkpoints > 0 && s.checkpointIndex < this.world.checkpoints.length) {
      const cp = this.world.checkpoints[s.checkpointIndex];
      const p = this.player.body.pos;
      if (Math.hypot(p.x - cp.x, p.z - cp.z) < cp.radius) {
        s.checkpointIndex++;
        s.splits.push(s.time);
        this.bus.emit('checkpoint', {
          index: s.checkpointIndex, total: this.world.checkpoints.length, time: s.time
        });
        if (cp.isFinish) {
          this.finishSession('finished');
          return;
        }
      }
    }

    // Time limit.
    if (mode.timeLimit > 0) {
      s.timeLeft -= dt;
      if (s.timeLeft <= 0) {
        s.timeLeft = 0;
        this.finishSession('timeup');
        return;
      }
    }

    // Avalanche chase.
    if (mode.avalanche && s.avalancheZ !== null) {
      const av = this.config.physics.avalanche;
      const speed = Math.min(av.maxSpeed, av.baseSpeed + av.acceleration * s.time * s.time * 0.5);
      s.avalancheZ += speed * dt;
      this.world.updateAvalanche(dt, s.avalancheZ);
      const gap = this.player.body.pos.z - s.avalancheZ;
      s.avalancheGap = gap;
      if (gap <= 0) {
        this.player.crash('avalanche');
        this.finishSession('caught');
        return;
      }
    }

    // Race standings.
    if (mode.race) {
      s.standingsTimer = (s.standingsTimer || 0) - dt;
      if (s.standingsTimer <= 0) {
        s.standingsTimer = 0.5;
        s.standings = this.ai.standings();
        s.position = s.standings.findIndex((r) => !r.ai) + 1;
      }
    }
  }

  finishSession(outcome) {
    const s = this.session;
    if (!s || s.finished) return;
    s.finished = true;
    s.outcome = outcome;
    const mode = this.mode, map = this.map;
    const gp = this.config.gameplay;

    // --- medal ---
    let medal = null;
    if (mode.id === 'timetrial' && outcome === 'finished') {
      const m = map.medals;
      if (s.time <= m.gold) medal = 'gold';
      else if (s.time <= m.silver) medal = 'silver';
      else if (s.time <= m.bronze) medal = 'bronze';
    } else if (mode.race && outcome === 'finished') {
      const pos = this.ai.standings().findIndex((r) => !r.ai) + 1;
      s.position = pos;
      medal = pos === 1 ? 'gold' : pos === 2 ? 'silver' : pos === 3 ? 'bronze' : null;
    }
    s.medal = medal;

    // --- XP ---
    let xp = Math.round(s.score / gp.xp.scoreDivisor + s.distance / gp.xp.distanceDivisor);
    if (outcome === 'finished') xp += gp.xp.finishBonus;
    if (medal) xp += gp.xp.medalBonus[medal];
    s.xpEarned = xp;

    // --- stats ---
    const save = this.save;
    save.recordStat('sessions', 1);
    save.recordStat('totalScore', s.score);
    save.recordStat('totalDistance', s.distance);
    save.recordStat('topSpeedKmh', s.topSpeed, 'max');
    save.recordStat('totalAirTime', s.airTime);
    if (mode.id === 'timetrial' && outcome === 'finished') save.recordStat('timeTrialsDone', 1);
    if (mode.avalanche) save.recordStat('bestEscape', s.distance, 'max');
    if (mode.race && s.position === 1) save.recordStat('racesWon', 1);
    if (medal) save.recordStat(`${medal}Medals`, 1);

    // --- bests & ghost ---
    if (mode.scoring) {
      s.newBestScore = save.submitScore(map.id, mode.id, s.score);
    }
    if (mode.id === 'timetrial' && outcome === 'finished') {
      s.newBestTime = save.submitTime(map.id, s.time);
      if (s.newBestTime && this.player.recording.length) {
        save.saveGhost(map.id, s.time, new Float32Array(this.player.recording))
          .catch((err) => console.warn('[Save] Ghost save failed:', err));
      }
    }

    const levelBefore = save.level;
    save.addXP(xp);
    save.checkAchievements();
    save.persist();
    s.leveledUp = save.level > levelBefore;
    s.levelAfter = save.level;

    this.state = 'results';
    this.bus.emit('session-end', { session: s, mode, map });
    this.ui.showResults(s, mode, map);
  }

  /* ---------------- main loop ---------------- */

  frame() {
    const now = performance.now();
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    dt = Math.min(dt, 0.1);
    this.elapsed += dt;

    try {
      this.step(dt);
    } catch (err) {
      console.error('[Game] Frame error:', err);
    }
  }

  step(dt) {
    this.input.update(dt);
    this.profiler.frame(dt);

    if (this.state === 'playing' && this.session) {
      const s = this.session;
      if (s.countdown > 0) {
        const before = Math.ceil(s.countdown);
        s.countdown -= dt;
        const after = Math.ceil(Math.max(0, s.countdown));
        if (after !== before) this.bus.emit('countdown', { n: after });
        if (s.countdown <= 0) this.bus.emit('countdown', { n: 0 });
      } else {
        // Time Warp winds back to realtime on a real-seconds clock.
        if (this.timeScaleTimer > 0) {
          this.timeScaleTimer -= dt;
          if (this.timeScaleTimer <= 0) this.setTimeScale(1, 0);
        }
        const step = this.config.physics.fixedTimeStep;
        this.accumulator = Math.min(
          this.accumulator + dt * this.timeScale,
          step * this.config.physics.maxSubSteps * 4
        );
        while (this.accumulator >= step) {
          this.player.fixedUpdate(step);
          this.ai.fixedUpdate(step);
          s.time += step;
          this.accumulator -= step;
        }
        this.updateModeLogic(dt);
        this.save.profile.stats.playTime += dt;
      }
    }

    const focus = (this.state === 'playing' || this.state === 'photo' || this.state === 'paused' || this.state === 'results') && this.player.mesh
      ? this.player.body.pos
      : this.camera.position;

    this.world.update(dt, focus);
    this.weather.update(dt);

    if (this.player.mesh && this.state !== 'paused') {
      this.player.update(dt);
      this.ai.update(dt);
    }

    this.cameras.update(dt);
    this.audio.update(dt);
    this.ui.update(dt);

    this.renderer.render(this.scene, this.camera);
  }

  captureScreenshot() {
    this.renderer.render(this.scene, this.camera);
    this.renderer.domElement.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `alpha-ice-surfers-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  }
}

/* ================================================================== */
/* Boot                                                                */
/* ================================================================== */

async function boot() {
  const game = new Game();
  window.AIS = game; // debug/console handle
  try {
    await game.init();
    const loading = document.getElementById('screen-loading');
    if (loading) loading.classList.add('hidden');
  } catch (err) {
    console.error('[Game] Failed to start:', err);
    const el = document.getElementById('loading-status');
    if (el) {
      el.innerHTML = `Failed to start.<br><small>${String(err.message || err)}</small>` +
        '<br><small>If you opened index.html directly, serve the folder over HTTP instead ' +
        '(e.g. <code>python3 -m http.server</code>).</small>';
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

/**
 * save.js — SaveManager: player profile, statistics, achievements,
 * unlocks, settings and ghost storage.
 *
 * Profile data lives in localStorage (small, synchronous, robust).
 * Ghost recordings live in IndexedDB (binary Float32Array payloads).
 * Both degrade gracefully to in-memory storage when unavailable.
 */

const SAVE_KEY = 'ais3d_save_v1';
const DB_NAME = 'ais3d';
const DB_VERSION = 1;
const GHOST_STORE = 'ghosts';

function defaultProfile() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    xp: 0,
    selectedCharacter: 'alpha',
    selectedBoard: 'rookie',
    settings: {
      quality: 'auto',
      master: 0.8,
      music: 0.55,
      sfx: 0.9,
      showFps: false,
      invertFlip: false,
      cameraMode: 'follow',
      difficulty: 'pro'
    },
    stats: {
      sessions: 0, tricksLanded: 0, flipsLanded: 0, spinsLanded: 0,
      bestCombo: 0, topSpeedKmh: 0, totalDistance: 0, crystals: 0,
      perfectLandings: 0, bestAirTime: 0, timeTrialsDone: 0,
      goldMedals: 0, silverMedals: 0, bronzeMedals: 0,
      bestEscape: 0, racesWon: 0, crashes: 0, jumps: 0, totalScore: 0,
      totalAirTime: 0, playTime: 0, level: 1
    },
    achievements: {},
    bestScores: {},
    bestTimes: {},
    daily: { lastClaim: '', streak: 0 }
  };
}

export class SaveManager {
  constructor(game) {
    this.game = game;
    this.profile = defaultProfile();
    this.db = null;
    this.memoryGhosts = new Map();
    this.storageOk = true;
  }

  async init() {
    this.load();
    try {
      this.db = await this.openDB();
    } catch (err) {
      console.warn('[Save] IndexedDB unavailable, ghosts kept in memory.', err);
      this.db = null;
    }
  }

  /* -------------------- profile: localStorage -------------------- */

  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        // Merge over defaults so new fields appear on old saves.
        const base = defaultProfile();
        this.profile = {
          ...base, ...data,
          settings: { ...base.settings, ...(data.settings || {}) },
          stats: { ...base.stats, ...(data.stats || {}) },
          daily: { ...base.daily, ...(data.daily || {}) }
        };
      }
    } catch (err) {
      console.warn('[Save] Could not load profile:', err);
      this.storageOk = false;
    }
  }

  persist() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.profile));
    } catch (err) {
      if (this.storageOk) console.warn('[Save] Could not persist profile:', err);
      this.storageOk = false;
    }
  }

  /* -------------------- XP & levels -------------------- */

  levelForXP(xp) {
    const cfg = this.game.config.progression.levels;
    let level = 1, need = cfg.baseXP, acc = 0;
    while (level < cfg.maxLevel && xp >= acc + need) {
      acc += need;
      need = Math.round(need * cfg.growth);
      level++;
    }
    return level;
  }

  xpProgress() {
    const cfg = this.game.config.progression.levels;
    let level = 1, need = cfg.baseXP, acc = 0;
    while (level < cfg.maxLevel && this.profile.xp >= acc + need) {
      acc += need;
      need = Math.round(need * cfg.growth);
      level++;
    }
    return { level, into: this.profile.xp - acc, need };
  }

  get level() { return this.levelForXP(this.profile.xp); }

  addXP(amount) {
    amount = Math.max(0, Math.round(amount));
    const before = this.level;
    this.profile.xp += amount;
    const after = this.level;
    this.profile.stats.level = after;
    this.persist();
    if (after > before) {
      this.game.bus.emit('levelup', { level: after });
      this.checkAchievements();
    }
    this.game.bus.emit('xp', { amount, total: this.profile.xp, level: after });
    return { leveledUp: after > before, level: after };
  }

  /* -------------------- stats & achievements -------------------- */

  recordStat(name, value, mode = 'add') {
    const s = this.profile.stats;
    if (!(name in s)) s[name] = 0;
    if (mode === 'max') s[name] = Math.max(s[name], value);
    else s[name] += value;
  }

  checkAchievements() {
    const defs = this.game.config.progression.achievements;
    const unlocked = [];
    for (const a of defs) {
      if (this.profile.achievements[a.id]) continue;
      const v = this.profile.stats[a.stat] || 0;
      if (v >= a.target) {
        this.profile.achievements[a.id] = true;
        unlocked.push(a);
      }
    }
    if (unlocked.length) {
      this.persist();
      for (const a of unlocked) {
        this.game.bus.emit('achievement', a);
        // XP grant after emit so the toast shows before a level-up toast.
        this.addXP(a.xp);
      }
    }
    return unlocked;
  }

  /* -------------------- daily reward -------------------- */

  dailyStatus() {
    const today = new Date().toISOString().slice(0, 10);
    const d = this.profile.daily;
    if (d.lastClaim === today) return { claimable: false, streak: d.streak };
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const nextStreak = d.lastClaim === yesterday ? d.streak + 1 : 1;
    return { claimable: true, streak: nextStreak };
  }

  claimDaily() {
    const status = this.dailyStatus();
    if (!status.claimable) return null;
    const cfg = this.game.config.progression.dailyReward;
    const streak = Math.min(status.streak, cfg.maxStreak);
    const xp = cfg.baseXP + cfg.streakBonusXP * (streak - 1);
    this.profile.daily = {
      lastClaim: new Date().toISOString().slice(0, 10),
      streak: status.streak
    };
    this.persist();
    this.addXP(xp);
    return { xp, streak: status.streak };
  }

  /* -------------------- bests -------------------- */

  submitScore(mapId, modeId, score) {
    const key = `${mapId}:${modeId}`;
    const prev = this.profile.bestScores[key] || 0;
    if (score > prev) {
      this.profile.bestScores[key] = Math.round(score);
      this.persist();
      return true;
    }
    return false;
  }

  submitTime(mapId, seconds) {
    const prev = this.profile.bestTimes[mapId];
    if (prev === undefined || seconds < prev) {
      this.profile.bestTimes[mapId] = Math.round(seconds * 100) / 100;
      this.persist();
      return true;
    }
    return false;
  }

  /* -------------------- ghosts: IndexedDB -------------------- */

  openDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('no idb')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(GHOST_STORE)) {
          db.createObjectStore(GHOST_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * @param {Float32Array} samples packed [t, x, y, z, heading] * n
   */
  async saveGhost(mapId, time, samples) {
    const record = { key: `ghost:${mapId}`, mapId, time, samples, savedAt: Date.now() };
    if (!this.db) { this.memoryGhosts.set(record.key, record); return; }
    await new Promise((resolve, reject) => {
      const tx = this.db.transaction(GHOST_STORE, 'readwrite');
      tx.objectStore(GHOST_STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadGhost(mapId) {
    const key = `ghost:${mapId}`;
    if (!this.db) return this.memoryGhosts.get(key) || null;
    return new Promise((resolve) => {
      const tx = this.db.transaction(GHOST_STORE, 'readonly');
      const req = tx.objectStore(GHOST_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  /* -------------------- export / import -------------------- */

  exportSave() {
    const blob = new Blob([JSON.stringify(this.profile, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'alpha-ice-surfers-save.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  importSave(json) {
    const data = JSON.parse(json);
    if (typeof data !== 'object' || typeof data.xp !== 'number') {
      throw new Error('Not a valid Alpha Ice Surfers save file.');
    }
    const base = defaultProfile();
    this.profile = {
      ...base, ...data,
      settings: { ...base.settings, ...(data.settings || {}) },
      stats: { ...base.stats, ...(data.stats || {}) }
    };
    this.persist();
  }

  resetSave() {
    this.profile = defaultProfile();
    this.persist();
  }
}

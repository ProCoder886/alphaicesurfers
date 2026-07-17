/**
 * terrainWorker.js — Deterministic procedural terrain generation.
 *
 * This file is BOTH:
 *   1. A module Web Worker (spawned by world.js with { type: 'module' }) that
 *      generates terrain chunks off the main thread, and
 *   2. An importable ES module (used as a synchronous fallback and for
 *      main-thread height math that must match the meshes exactly).
 *
 * Keeping generation in one file guarantees the physics heightfield, the
 * rendered meshes and the worker output can never drift apart.
 *
 * All generation is seeded and purely functional: (seed, x, z) -> height,
 * so chunks are reproducible across sessions, workers and ghost replays.
 */

export const CHUNK_SIZE = 140;   // metres per chunk side
export const CHUNK_RES = 64;     // cells per side (CHUNK_RES+1 vertices)
export const LAKE_SURF = 1.25;   // sentinel written into the surf array for frozen lakes

/* ------------------------------------------------------------------ */
/* Deterministic hashing / noise                                       */
/* ------------------------------------------------------------------ */

function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t) { return t * t * (3 - 2 * t); }

function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = smooth(x - ix), fz = smooth(z - iz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Fractal Brownian motion, output roughly in [-1, 1]. */
function fbm(x, z, seed, octaves) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * (valueNoise(x * freq, z * freq, seed + i * 131) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

/** Ridged noise in [0, 1] — sharp crests, good for mountain spines. */
function ridged(x, z, seed, octaves) {
  let sum = 0, amp = 0.55, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(x * freq, z * freq, seed + 977 + i * 131) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2.11;
  }
  return sum / norm;
}

/** Small deterministic PRNG for per-chunk object placement. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Terrain shape                                                       */
/* ------------------------------------------------------------------ */

/**
 * The "racing corridor" — a meandering line the level design gravitates
 * around: solid obstacles keep clear of it, boosters and ramps hug it,
 * and checkpoints ride along it.
 */
export function corridorX(z) {
  return Math.sin(z * 0.008) * 55 + Math.sin(z * 0.0023 + 1.7) * 130;
}

export class TerrainGenerator {
  /**
   * @param {number} seed     map seed
   * @param {object} terrain  terrain params from maps.json (slope, amp, ...)
   */
  constructor(seed, terrain) {
    this.seed = seed | 0;
    this.p = terrain;
  }

  /** Analytic terrain height at any world position. Downhill is +Z. */
  height(x, z) {
    const p = this.p, s = this.seed;
    const ridge = ridged(x * 0.0042, z * 0.0042, s, 4) * p.ridgeAmp;
    const rolling = fbm(x * 0.016, z * 0.016, s + 7, 4) * p.amp;
    const detail = fbm(x * 0.085, z * 0.085, s + 23, 3) * 1.6 * p.roughness;
    let h = -z * p.slope + ridge + rolling + detail;

    // Keep the racing line clear: near the corridor, damp bumps and pull
    // the big ridges toward their midline so a rideable groove runs down
    // the middle while hills and walls stay tall on either side.
    const corridorDist = Math.abs(x - corridorX(z));
    const W = 44;
    if (corridorDist < W) {
      let t = 1 - corridorDist / W;
      t = t * t * (3 - 2 * t); // smoothstep — no crease at the edge
      h -= detail * t * 0.9;
      h -= rolling * t * 0.5;
      h -= (ridge - p.ridgeAmp * 0.42) * t * 0.55;
    }

    if (p.city) {
      // Gentle terracing reads as buried streets and plazas.
      const q = Math.round(h / 7) * 7;
      h = h * 0.72 + q * 0.28;
    }

    if (p.island) {
      // Carve the world into floating islands over a void.
      const mask = fbm(x * 0.0036, z * 0.0036, s + 51, 3) + 0.32;
      const edge = Math.min(1, Math.max(0, mask / 0.3));
      if (mask < 0.3) h -= (1 - edge) * (1 - edge) * 420;
    }

    if (p.lakeLevel !== null && p.lakeLevel !== undefined) {
      const lakeH = -z * p.slope + p.lakeLevel;
      if (h < lakeH) return lakeH;
    }
    return h;
  }

  /** Whether analytic position is a frozen-lake surface. */
  isLake(x, z) {
    const p = this.p;
    if (p.lakeLevel === null || p.lakeLevel === undefined) return false;
    const lakeH = -z * p.slope + p.lakeLevel;
    // Recompute raw height without the lake clamp.
    const saved = p.lakeLevel;
    p.lakeLevel = null;
    const raw = this.height(x, z);
    p.lakeLevel = saved;
    return raw <= lakeH + 0.01;
  }

  /** Iciness 0..1 (or LAKE_SURF sentinel) at world position. */
  surface(x, z) {
    if (this.isLake(x, z)) return LAKE_SURF;
    const p = this.p, s = this.seed;
    const n = fbm(x * 0.02, z * 0.02, s + 89, 3) * 0.5 + 0.5;
    const threshold = 1 - p.iceRatio;
    if (n < threshold) {
      // Snow — vary subtly between powder and packed.
      return Math.max(0, (n / threshold) * 0.3 - 0.05);
    }
    const t = (n - threshold) / Math.max(0.0001, 1 - threshold);
    return 0.45 + Math.min(1, t) * 0.55;
  }

  /** Terrain normal from central differences (matches mesh closely). */
  normal(x, z, out) {
    const e = 1.2;
    const hl = this.height(x - e, z), hr = this.height(x + e, z);
    const hd = this.height(x, z - e), hu = this.height(x, z + e);
    const nx = hl - hr, nz = hd - hu, ny = 2 * e;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    if (out) { out.x = nx / len; out.y = ny / len; out.z = nz / len; return out; }
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  /**
   * Generate one chunk: height grid, surface grid, per-vertex normals and
   * obstacle placements. Normals are computed from an apron grid (one
   * extra vertex ring) so chunk borders shade seamlessly.
   * @returns {{heights: Float32Array, surf: Float32Array, normals: Float32Array, obstacles: Array}}
   */
  generateChunk(cx, cz, density, obstacleTypes, rules) {
    const n = CHUNK_RES + 1;
    const step = CHUNK_SIZE / CHUNK_RES;
    const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;

    // Apron grid covers vertex indices -1 .. CHUNK_RES+1.
    const an = n + 2;
    const apron = new Float32Array(an * an);
    for (let j = -1; j <= CHUNK_RES + 1; j++) {
      for (let i = -1; i <= CHUNK_RES + 1; i++) {
        apron[(j + 1) * an + (i + 1)] = this.height(ox + i * step, oz + j * step);
      }
    }

    const heights = new Float32Array(n * n);
    const surf = new Float32Array(n * n);
    const normals = new Float32Array(n * n * 3);

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        heights[idx] = apron[(j + 1) * an + (i + 1)];
        surf[idx] = this.surface(ox + i * step, oz + j * step);

        const hl = apron[(j + 1) * an + i];
        const hr = apron[(j + 1) * an + (i + 2)];
        const hd = apron[j * an + (i + 1)];
        const hu = apron[(j + 2) * an + (i + 1)];
        let nx = hl - hr, ny = 2 * step, nz = hd - hu;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        normals[idx * 3] = nx / len;
        normals[idx * 3 + 1] = ny / len;
        normals[idx * 3 + 2] = nz / len;
      }
    }

    const obstacles = this.placeObstacles(cx, cz, density, obstacleTypes, rules);
    return { heights, surf, normals, obstacles };
  }

  placeObstacles(cx, cz, density, obstacleTypes, rules) {
    const rng = mulberry32(this.seed ^ Math.imul(cx, 7919) ^ Math.imul(cz, 104729));
    const out = [];
    const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
    const p = this.p;

    for (const type of obstacleTypes) {
      if (type.cityOnly && !p.city) continue;
      const densScale = density[type.id] !== undefined ? density[type.id] : 1;
      const count = Math.round(type.baseDensity * densScale * (0.7 + rng() * 0.6));
      for (let k = 0; k < count; k++) {
        let x, z;
        if (type.kind === 'trigger') {
          // Gameplay triggers live near the corridor where riders actually go.
          z = oz + rng() * CHUNK_SIZE;
          x = corridorX(z) + (rng() * 2 - 1) * 22;
          if (x < ox - 4 || x > ox + CHUNK_SIZE + 4) continue;
        } else {
          x = ox + rng() * CHUNK_SIZE;
          z = oz + rng() * CHUNK_SIZE;
          // Keep the racing line clear of solid objects.
          if (Math.abs(x - corridorX(z)) < rules.corridorClearance + type.radius) continue;
        }
        // Keep the spawn area safe.
        if (z < 40 && Math.abs(x - corridorX(0)) < rules.spawnClearRadius) continue;

        const y = this.height(x, z);
        // Skip void areas on island maps.
        if (p.island && y < -z * p.slope - 60) continue;
        // Trees avoid cliffs; everything avoids near-vertical walls.
        const nrm = this.normal(x, z);
        if (type.minSlopeClear && nrm.y < type.minSlopeClear) continue;
        if (nrm.y < 0.45) continue;
        // No trees on lakes or deep ice.
        if (type.id === 'tree' && this.surface(x, z) > 0.6) continue;

        out.push({
          type: type.id,
          x, z,
          y: y + (type.hover || 0),
          rot: rng() * Math.PI * 2,
          scale: 0.8 + rng() * 0.7
        });
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Worker entry point                                                  */
/* ------------------------------------------------------------------ */

const isWorker = typeof self !== 'undefined' && typeof window === 'undefined'
  && typeof self.postMessage === 'function';

if (isWorker) {
  const generators = new Map();
  self.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.cmd === 'reset') { generators.clear(); return; }
    const key = msg.seed + JSON.stringify(msg.terrain);
    let gen = generators.get(key);
    if (!gen) {
      gen = new TerrainGenerator(msg.seed, msg.terrain);
      generators.set(key, gen);
    }
    const { heights, surf, normals, obstacles } = gen.generateChunk(
      msg.cx, msg.cz, msg.density, msg.obstacleTypes, msg.rules
    );
    self.postMessage(
      { id: msg.id, cx: msg.cx, cz: msg.cz, heights, surf, normals, obstacles },
      [heights.buffer, surf.buffer, normals.buffer]
    );
  };
}

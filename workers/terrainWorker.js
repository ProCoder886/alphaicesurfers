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
 * The "racing corridor" — the valley floor's centre line. The whole map is
 * built around it: the rideable groove follows it, the pipe walls rise on
 * both sides of it, triggers and checkpoints ride along it. Mostly straight
 * with long, gentle curves.
 */
export function corridorX(z) {
  return Math.sin(z * 0.006) * 26 + Math.sin(z * 0.0016 + 1.7) * 55;
}

function smoothstep01(t) {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
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

  /**
   * Analytic terrain height at any world position. Downhill is +Z.
   *
   * The world is one long glacial valley — a natural half-pipe:
   *  - a clean, steadily descending floor along corridorX(z) (steepness
   *    varies along the run but NEVER climbs, so no holes or uphills),
   *  - concave pipe walls rising on both sides (ride up, launch, spin),
   *  - ridge lines and background peaks beyond the walls.
   */
  height(x, z) {
    const p = this.p, s = this.seed;

    // --- valley spine: monotonic descent with flowing steepness ---
    // Each sine's slope contribution is capped so the sum never exceeds
    // the base slope: d/dz is always negative. Steep drops happen on the
    // straight path, but the floor never dips into a hole.
    const sp = p.slope;
    const u1 = Math.sin(z * 0.012 + s % 7) * (sp * 0.32 / 0.012);
    const u2 = Math.sin(z * 0.0031 + (s % 11) * 0.7) * (sp * 0.34 / 0.0031);
    let h = -z * sp + u1 + u2;

    // --- valley cross-section ---
    const d = Math.abs(x - corridorX(z));
    const floorHW = p.floorWidth || 16;
    const wallSpan = p.wallSpan || 95;
    const wallH = (p.wallHeight || 55) *
      (0.82 + 0.36 * (valueNoise(z * 0.004, 0, s + 61)));

    if (d < floorHW) {
      // Gentle dish so riders funnel back to the centre line.
      const f = d / floorHW;
      h += f * f * 2.2;
      // Tiny floor detail only — the racing line stays clean.
      h += fbm(x * 0.09, z * 0.09, s + 23, 2) * 0.4 * p.roughness;
    } else {
      const t = (d - floorHW) / wallSpan;
      // Concave quarter-pipe transition into the wall.
      const wall = wallH * Math.pow(smoothstep01(t), 1.55);
      h += 2.2 + wall;
      // Texture the walls, fading in away from the lip of the pipe.
      const wallNoise = fbm(x * 0.03, z * 0.03, s + 7, 3) * 6
        + fbm(x * 0.085, z * 0.085, s + 23, 2) * 1.6 * p.roughness;
      h += wallNoise * Math.min(1, t * 1.4);
      // Background peaks beyond the ridge line.
      if (t > 1) {
        const back = Math.min(1, t - 1);
        h += ridged(x * 0.0042, z * 0.0042, s, 4) * (p.ridgeAmp || 40) * back;
      }
    }
    return h;
  }

  /** Iciness 0..1 at world position — the floor runs icier than the walls. */
  surface(x, z) {
    const p = this.p, s = this.seed;
    const n = fbm(x * 0.02, z * 0.02, s + 89, 3) * 0.5 + 0.5;
    const d = Math.abs(x - corridorX(z));
    const floorHW = p.floorWidth || 16;
    // Bias: the racing groove is polished ice, the walls hold snow.
    const bias = d < floorHW ? 0.18 : -0.1 * Math.min(1, (d - floorHW) / 40);
    const threshold = Math.min(0.96, Math.max(0.05, 1 - p.iceRatio - bias));
    if (n < threshold) {
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

    // On-path hazards ramp up the deeper you ride into the run.
    const difficulty = Math.min(1.6, 0.35 + Math.max(0, oz) / 1600);

    for (const type of obstacleTypes) {
      if (type.cityOnly && !p.city) continue;
      const densScale = density[type.id] !== undefined ? density[type.id] : 1;
      let count = Math.round(type.baseDensity * densScale * (0.7 + rng() * 0.6));
      if (type.onPath && type.kind === 'solid') {
        count = Math.round(count * difficulty);
        if (oz < 140) count = 0; // safe opening stretch
      }
      for (let k = 0; k < count; k++) {
        let x, z;
        if (type.onPath) {
          // Hazards and pickups sit ON the racing line — dodge or jump them.
          z = oz + rng() * CHUNK_SIZE;
          const spread = type.kind === 'solid' ? 11 : 18;
          x = corridorX(z) + (rng() * 2 - 1) * spread;
          if (x < ox - 4 || x > ox + CHUNK_SIZE + 4) continue;
          if (type.kind === 'solid' && z < 160) continue;
        } else if (type.kind === 'trigger') {
          // Rewards hug the corridor where riders actually go.
          z = oz + rng() * CHUNK_SIZE;
          x = corridorX(z) + (rng() * 2 - 1) * 22;
          if (x < ox - 4 || x > ox + CHUNK_SIZE + 4) continue;
        } else {
          // Scenery solids live on the valley walls, clear of the groove.
          x = ox + rng() * CHUNK_SIZE;
          z = oz + rng() * CHUNK_SIZE;
          if (Math.abs(x - corridorX(z)) < rules.corridorClearance + type.radius) continue;
        }
        // Keep the spawn area safe.
        if (z < 40 && Math.abs(x - corridorX(0)) < rules.spawnClearRadius) continue;

        const y = this.height(x, z);
        // Trees avoid cliffs; everything avoids near-vertical walls.
        const nrm = this.normal(x, z);
        if (type.minSlopeClear && nrm.y < type.minSlopeClear) continue;
        if (nrm.y < 0.45) continue;
        // No trees on polished ice.
        if (type.id === 'tree' && this.surface(x, z) > 0.6) continue;

        // Path-crossing pieces (ridges, arches) align to the corridor.
        const alignToPath = type.alignPath
          ? Math.atan2(corridorX(z + 1) - corridorX(z - 1), 2)
          : null;

        out.push({
          type: type.id,
          x, z,
          y: y + (type.hover || 0),
          rot: alignToPath !== null ? alignToPath : rng() * Math.PI * 2,
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

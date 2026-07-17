/**
 * world.js — World generation, terrain streaming and environment.
 *
 * Owns: terrain chunk streaming (worker-generated, LOD'd, instanced
 * obstacles), lighting, procedural sky dome, environment reflections,
 * checkpoint gates, the avalanche wall and all map-level visuals.
 *
 * Terrain math lives in workers/terrainWorker.js (single source of truth);
 * this module turns that data into meshes and answers physics queries
 * (sampleHeight / sampleNormal / surfaceAt / obstaclesNear) by bilinear
 * sampling of the cached height grids — so the collision ground and the
 * rendered ground are always identical.
 */

import * as THREE from 'three';
import {
  TerrainGenerator, corridorX, CHUNK_SIZE, CHUNK_RES
} from '../workers/terrainWorker.js';
import { SprayEmitter } from './player.js';

const HAZARD_IDS = ['icefang', 'iceridge', 'boulder', 'spike'];

const _v1 = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _q1 = new THREE.Quaternion();
const _s1 = new THREE.Vector3();

const OBSTACLE_HEIGHTS = {
  tree: 5, rock: 2.2, spike: 3.2, tower: 40,
  icefang: 2.6, iceridge: 1.5, boulder: 3.0
};

export class World {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.group = null;
    this.map = null;
    this.generator = null;

    this.chunks = new Map();     // "cx,cz" -> chunk record
    this.buildQueue = [];
    this.aheadChunks = 7;        // forward streaming horizon (quality-scaled)

    this.checkpoints = [];
    this.avalanche = null;
    this.powerupAnim = new Set();
    this.meteors = [];
    this.impactSpray = null;
    this.timeU = { value: 0 };
    this.envTexture = null;
    this.sky = null;
    this.sun = null;
    this.hemi = null;

    this.reqId = 0;
    this.requested = new Set();
    this.worker = null;
    this.initWorker();

    // Shared grid indices for full and coarse LOD meshes.
    this.indexFull = World.buildGridIndex(CHUNK_RES, 1);
    this.indexCoarse = World.buildGridIndex(CHUNK_RES, 4);
  }

  initWorker() {
    try {
      this.worker = new Worker(
        new URL('../workers/terrainWorker.js', import.meta.url),
        { type: 'module', name: 'terrain' }
      );
      this.worker.onmessage = (e) => this.onWorkerChunk(e.data);
      this.worker.onerror = (err) => {
        console.warn('[World] Terrain worker failed, falling back to sync generation.', err);
        this.worker = null;
      };
    } catch (err) {
      console.warn('[World] Web Workers unavailable, using sync generation.', err);
      this.worker = null;
    }
  }

  static buildGridIndex(res, stride) {
    const n = res + 1;
    const cells = res / stride;
    const idx = [];
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const a = (j * stride) * n + (i * stride);
        const b = a + stride;
        const c = a + stride * n;
        const d = c + stride;
        idx.push(a, c, b, b, c, d);
      }
    }
    return new THREE.BufferAttribute(new Uint32Array(idx), 1);
  }

  /* ================= map lifecycle ================= */

  /**
   * @param {object} mapDef   entry from maps.json
   * @param {object} [skyTheme] optional random sky override {top, horizon, fog}
   */
  loadMap(mapDef, skyTheme) {
    this.disposeMap();
    // A fresh sky palette every run: clone the map and recolor the sky keys
    // so every downstream consumer (sky shader, fog, env map, weather,
    // hemisphere light) picks the theme up automatically.
    this.map = skyTheme
      ? {
        ...mapDef,
        palette: {
          ...mapDef.palette,
          skyTop: skyTheme.top,
          skyHorizon: skyTheme.horizon,
          fog: skyTheme.fog
        }
      }
      : mapDef;
    mapDef = this.map;
    this.generator = new TerrainGenerator(mapDef.seed, mapDef.terrain);

    // Difficulty scales the on-path hazard density.
    const hazardScale = this.game.difficulty ? this.game.difficulty.hazardScale : 1;
    this.densityScaled = { ...mapDef.density };
    for (const id of HAZARD_IDS) {
      this.densityScaled[id] = (this.densityScaled[id] ?? 1) * hazardScale;
    }
    this.group = new THREE.Group();
    this.group.name = `map:${mapDef.id}`;
    this.scene.add(this.group);

    const pal = mapDef.palette;
    this.buildLights(pal);
    this.buildSky(pal);
    this.buildEnvironment(pal);
    this.buildTerrainMaterial(pal);
    this.buildObstacleAssets(pal);

    this.scene.fog = new THREE.FogExp2(new THREE.Color(pal.fog), 0.0022);

    // Shared particle pool for meteor impacts.
    this.impactSpray = new SprayEmitter(this.group, '#ffffff', 140);

    // Start arch so the spawn reads as a place, not a random field.
    const spawn = this.spawnPoint();
    this.startArch = this.buildGate('START', pal.neon, spawn.x, spawn.z + 8, false);
    this.group.add(this.startArch);

    // Warm the spawn area synchronously so physics has ground immediately.
    this.prewarm(spawn.x, spawn.z, 1);
  }

  disposeMap() {
    if (this.worker) this.worker.postMessage({ cmd: 'reset' });
    this.requested.clear();
    this.buildQueue.length = 0;
    for (const chunk of this.chunks.values()) this.disposeChunkMeshes(chunk);
    this.chunks.clear();
    this.checkpoints = [];
    this.avalanche = null;
    this.powerupAnim.clear();
    this.meteors = [];
    this.impactSpray = null;
    if (this.group) {
      this.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && !Array.isArray(o.material)) o.material.dispose();
        if (o.material && Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      });
      this.scene.remove(this.group);
      this.group = null;
    }
    if (this.envTexture) { this.envTexture.dispose(); this.envTexture = null; }
    this.scene.environment = null;
    this.map = null;
  }

  /* ================= environment ================= */

  buildLights(pal) {
    this.sun = new THREE.DirectionalLight(new THREE.Color(pal.sunColor), 2.8);
    this.sun.castShadow = true;
    const q = this.game.quality;
    this.sun.shadow.mapSize.setScalar(q.shadowMap);
    this.sun.shadow.camera.left = -70;
    this.sun.shadow.camera.right = 70;
    this.sun.shadow.camera.top = 70;
    this.sun.shadow.camera.bottom = -70;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 500;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.5;
    this.group.add(this.sun, this.sun.target);

    this.hemi = new THREE.HemisphereLight(
      new THREE.Color(pal.skyHorizon), new THREE.Color(pal.snowShadow), 0.85
    );
    this.group.add(this.hemi);
  }

  buildSky(pal) {
    const sh = this.game.assets.shaders.sky;
    const geo = new THREE.SphereGeometry(1100, 32, 16);
    const mat = new THREE.ShaderMaterial({
      vertexShader: sh.VERTEX,
      fragmentShader: sh.FRAGMENT,
      uniforms: {
        uTopColor: { value: new THREE.Color(pal.skyTop) },
        uHorizonColor: { value: new THREE.Color(pal.skyHorizon) },
        uSunColor: { value: new THREE.Color(pal.sunColor) },
        uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.2) },
        uMoonDir: { value: new THREE.Vector3(-0.3, 0.5, -0.2) },
        uNight: { value: 0 },
        uTime: this.timeU
      },
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.group.add(this.sky);
  }

  buildEnvironment(pal) {
    // Cheap PBR reflections: a tiny gradient equirect run through PMREM.
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 32);
    grad.addColorStop(0, pal.skyTop);
    grad.addColorStop(0.55, pal.skyHorizon);
    grad.addColorStop(0.62, pal.snowShadow);
    grad.addColorStop(1, pal.snow);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 32);
    const tex = new THREE.CanvasTexture(canvas);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(this.game.renderer);
    this.envTexture = pmrem.fromEquirectangular(tex).texture;
    this.scene.environment = this.envTexture;
    tex.dispose();
    pmrem.dispose();
  }

  buildTerrainMaterial(pal) {
    const sh = this.game.assets.shaders.ice;
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(pal.snow),
      roughness: 0.92,
      metalness: 0.02
    });
    const uniforms = {
      uTime: this.timeU,
      uIceTint: { value: new THREE.Color(pal.ice) },
      uLakeTint: { value: new THREE.Color(pal.ice).multiplyScalar(0.55) },
      uSparkleColor: { value: new THREE.Color(1, 1, 1).multiplyScalar(0.6) }
    };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${sh.VERTEX_DECL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${sh.VERTEX_MAIN}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${sh.FRAG_DECL}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${sh.FRAG_COLOR}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${sh.FRAG_ROUGHNESS}`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${sh.FRAG_METALNESS}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${sh.FRAG_EMISSIVE}`);
    };
    mat.customProgramCacheKey = () => 'ais-terrain';
    this.terrainMat = mat;
  }

  buildObstacleAssets(pal) {
    const flat = (color, opts = {}) => new THREE.MeshStandardMaterial({
      color: new THREE.Color(color), flatShading: true, roughness: 0.85, ...opts
    });
    const glow = (color, intensity = 1.6, opts = {}) => new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      emissive: new THREE.Color(color),
      emissiveIntensity: intensity,
      roughness: 0.4,
      ...opts
    });

    // Trees: two foliage tiers plus a snow cap for a wintry silhouette.
    const foliage = new THREE.ConeGeometry(1.8, 3.4, 7);
    foliage.translate(0, 2.6, 0);
    const foliageTop = new THREE.ConeGeometry(1.25, 2.6, 7);
    foliageTop.translate(0, 4.5, 0);
    const treeSnow = new THREE.ConeGeometry(1.32, 1.15, 7);
    treeSnow.translate(0, 5.35, 0);
    const trunk = new THREE.CylinderGeometry(0.26, 0.38, 1.7, 5);
    trunk.translate(0, 0.85, 0);
    const rock = new THREE.DodecahedronGeometry(1.6, 0);
    rock.translate(0, 0.8, 0);
    const rockSnow = new THREE.SphereGeometry(1.25, 8, 5);
    rockSnow.scale(1.15, 0.35, 1.15);
    rockSnow.translate(0, 1.55, 0);
    const spike = new THREE.ConeGeometry(0.95, 3.6, 5);
    spike.translate(0, 1.7, 0);
    const towerBody = new THREE.BoxGeometry(6.4, 42, 6.4);
    towerBody.translate(0, 20, 0);
    const towerCap = new THREE.BoxGeometry(6.9, 1.4, 6.9);
    towerCap.translate(0, 41.5, 0);
    const crystal = new THREE.OctahedronGeometry(1.35, 0);
    crystal.scale(1, 1.8, 1);
    crystal.translate(0, 2.1, 0);
    const ring = new THREE.TorusGeometry(3.1, 0.24, 8, 26);
    const ramp = new THREE.BoxGeometry(6, 0.6, 8);
    ramp.rotateX(-0.34);
    ramp.translate(0, 1.15, 0);
    const pad = new THREE.CylinderGeometry(2.0, 2.3, 0.55, 12);
    pad.translate(0, 0.28, 0);

    // Power-up pickups — distinct silhouettes, individually animated.
    const magnet = new THREE.TorusKnotGeometry(0.85, 0.26, 48, 8);
    const shield = new THREE.IcosahedronGeometry(1.15, 1);
    const nitro = new THREE.OctahedronGeometry(1.05, 0);
    nitro.scale(0.8, 1.4, 0.8);
    const star = new THREE.DodecahedronGeometry(1.05, 0);
    const clock = new THREE.TorusGeometry(0.95, 0.3, 10, 18);

    // On-path ice hazards.
    const fangA = new THREE.ConeGeometry(0.7, 2.8, 5);
    fangA.translate(0, 1.3, 0);
    const fangB = new THREE.ConeGeometry(0.5, 1.9, 5);
    fangB.translate(0.9, 0.9, 0.3);
    fangB.rotateZ(-0.16);
    const fangC = new THREE.ConeGeometry(0.45, 1.5, 5);
    fangC.translate(-0.8, 0.7, -0.35);
    fangC.rotateZ(0.14);
    const iceridge = new THREE.BoxGeometry(7.2, 1.3, 1.7);
    iceridge.translate(0, 0.6, 0);
    const boulder = new THREE.IcosahedronGeometry(2.1, 0);
    boulder.translate(0, 1.3, 0);
    const archGeo = new THREE.TorusGeometry(4.2, 0.65, 8, 22);

    const snowMat = flat(pal.snow, { roughness: 0.95 });
    this.obstacleTemplates = {
      tree: {
        parts: [[foliage, flat(pal.tree)], [foliageTop, flat(pal.tree)],
                [treeSnow, snowMat], [trunk, flat(pal.trunk)]],
        shadow: true
      },
      rock: { parts: [[rock, flat(pal.rock)], [rockSnow, snowMat]], shadow: true },
      spike: { parts: [[spike, glow('#a12a52', 0.5, { roughness: 0.25 })]], shadow: true },
      tower: { parts: [[towerBody, flat(pal.rock)], [towerCap, glow(pal.neon, 2.2)]], shadow: true },
      crystal: { parts: [[crystal, glow(pal.crystal, 1.2, { transparent: true, opacity: 0.92 })]], shadow: false },
      ring: { parts: [[ring, glow(pal.neon, 2.0)]], shadow: false },
      ramp: { parts: [[ramp, glow(pal.ice, 0.35, { roughness: 0.3 })]], shadow: true },
      pad: { parts: [[pad, glow(pal.neon, 1.4)]], shadow: false },
      magnet: { parts: [[magnet, glow('#ff9d3c', 1.7)]], shadow: false, powerup: true },
      shield: { parts: [[shield, glow('#5cd7ff', 1.5, { transparent: true, opacity: 0.72 })]], shadow: false, powerup: true },
      nitro: { parts: [[nitro, glow('#ff5a2a', 1.9)]], shadow: false, powerup: true },
      star: { parts: [[star, glow('#ffd166', 1.8)]], shadow: false, powerup: true },
      clock: { parts: [[clock, glow('#b0f0a8', 1.6)]], shadow: false, powerup: true },
      // Hazards wear dark warning colors that pop against white snow.
      icefang: {
        parts: [[fangA, glow('#d92b45', 0.75, { roughness: 0.25 })],
                [fangB, glow('#b31f38', 0.6, { roughness: 0.25 })],
                [fangC, glow('#8f1830', 0.5, { roughness: 0.3 })]],
        shadow: true
      },
      iceridge: { parts: [[iceridge, glow('#8b3ddb', 0.8, { roughness: 0.2, transparent: true, opacity: 0.94 })]], shadow: true },
      boulder: { parts: [[boulder, glow('#5e2f8e', 0.55, { roughness: 0.3 })]], shadow: true },
      icearch: { parts: [[archGeo, glow(pal.crystal, 1.1, { roughness: 0.2, metalness: 0.3 })]], shadow: false }
    };
    this.pulseMaterials = [
      this.obstacleTemplates.ring.parts[0][1],
      this.obstacleTemplates.pad.parts[0][1],
      this.obstacleTemplates.crystal.parts[0][1]
    ];
    this.obstacleTypeMap = {};
    for (const t of this.game.config.obstacles.types) this.obstacleTypeMap[t.id] = t;
  }

  /* ================= gates / checkpoints ================= */

  makeTextTexture(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(8,12,24,0.85)';
    ctx.fillRect(0, 0, 512, 96);
    ctx.font = 'bold 62px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, 256, 52);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  buildGate(label, color, x, z, isCheckpoint) {
    const g = new THREE.Group();
    const y = this.sampleHeight(x, z);
    const poleGeo = new THREE.CylinderGeometry(0.22, 0.28, 7.5, 8);
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x27303f, emissive: new THREE.Color(color), emissiveIntensity: 0.55, roughness: 0.5
    });
    const halfW = isCheckpoint ? 6 : 7.5;
    for (const side of [-1, 1]) {
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(side * halfW, 3.75, 0);
      pole.castShadow = true;
      g.add(pole);
    }
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(halfW * 2, 1.6),
      new THREE.MeshBasicMaterial({
        map: this.makeTextTexture(label, color), side: THREE.DoubleSide, transparent: false
      })
    );
    banner.position.set(0, 7.2, 0);
    // Riders approach from -Z, so face the readable side uphill.
    banner.rotation.y = Math.PI;
    g.add(banner);
    // Orient across the corridor direction.
    const dxdz = corridorX(z + 1) - corridorX(z - 1);
    g.rotation.y = Math.atan2(dxdz, 2);
    g.position.set(x, y, z);
    return g;
  }

  buildCheckpoints(count) {
    this.checkpoints = [];
    const pal = this.map.palette;
    for (let i = 0; i < count; i++) {
      const z = 130 + i * 115;
      const x = corridorX(z);
      const last = i === count - 1;
      const gate = this.buildGate(
        last ? 'FINISH' : `CHECKPOINT ${i + 1}`,
        last ? '#ffd166' : pal.neon, x, z, true
      );
      this.group.add(gate);
      this.checkpoints.push({
        index: i, x, z, y: this.sampleHeight(x, z),
        radius: 9, passed: false, gate, isFinish: last
      });
    }
    return this.checkpoints;
  }

  /* ================= sky attacks: ice meteors ================= */

  /**
   * Spawn an incoming ice meteor aimed at (x, z), landing in ~delay seconds.
   * A pulsing warning ring marks the impact point the whole way down.
   */
  spawnMeteor(x, z, delay = 1.7) {
    if (!this.map) return;
    const groundY = this.sampleHeight(x, z);

    const rockMesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.35, 0),
      new THREE.MeshStandardMaterial({
        color: 0x8fd8ff,
        emissive: new THREE.Color('#ff8a3c'),
        emissiveIntensity: 1.6,
        roughness: 0.3
      })
    );
    // Fiery tail: a stretched cone behind the fall direction.
    const tail = new THREE.Mesh(
      new THREE.ConeGeometry(0.9, 6, 6),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#ffb35c'), transparent: true, opacity: 0.55, depthWrite: false
      })
    );
    tail.position.y = 3.4;
    rockMesh.add(tail);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.2, 3.2, 26),
      new THREE.MeshBasicMaterial({
        color: 0xff4444, transparent: true, opacity: 0.65,
        side: THREE.DoubleSide, depthWrite: false
      })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, groundY + 0.15, z);
    this.group.add(rockMesh, ring);

    // Falls in from high ahead of the rider.
    const start = new THREE.Vector3(x + (Math.random() - 0.5) * 24, groundY + 135, z + 55);
    rockMesh.position.copy(start);
    const vel = new THREE.Vector3(x, groundY, z).sub(start).divideScalar(delay);
    this.meteors.push({ mesh: rockMesh, ring, vel, targetY: groundY, x, z });
  }

  updateMeteors(dt) {
    if (!this.meteors.length) return;
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.mesh.position.addScaledVector(m.vel, dt);
      m.mesh.rotation.x += dt * 6;
      m.mesh.rotation.y += dt * 4;
      m.ring.material.opacity = 0.45 + Math.sin(this.timeU.value * 14) * 0.25;
      if (m.mesh.position.y <= m.targetY + 0.6) {
        // Impact: snow burst + player check.
        if (this.impactSpray) {
          this.impactSpray.spawn(m.mesh.position, _v1.set(0, 6, 0), 45, 7);
        }
        const player = this.game.player;
        if (player && player.mesh) {
          const d = Math.hypot(player.body.pos.x - m.x, player.body.pos.z - m.z);
          if (d < 5) player.crash('meteor');
          else if (d < 9) this.game.bus.emit('nearmiss', {});
        }
        this.game.bus.emit('meteor-impact', {});
        this.disposeMeteor(m);
        this.meteors.splice(i, 1);
      }
    }
  }

  disposeMeteor(m) {
    this.group.remove(m.mesh, m.ring);
    m.mesh.geometry.dispose();
    m.mesh.material.dispose();
    m.mesh.children[0]?.geometry.dispose();
    m.mesh.children[0]?.material.dispose();
    m.ring.geometry.dispose();
    m.ring.material.dispose();
  }

  /* ================= avalanche ================= */

  createAvalanche(startZ) {
    const g = new THREE.Group();
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(700, 70, 24, 4),
      new THREE.MeshStandardMaterial({
        color: 0xf4f8ff, roughness: 1, transparent: true, opacity: 0.94, side: THREE.DoubleSide
      })
    );
    wall.rotation.x = 0.18;
    g.add(wall);
    // Tumbling boulder front.
    const boulders = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(2.2, 0),
      new THREE.MeshStandardMaterial({ color: 0xeef3fc, roughness: 1 }),
      60
    );
    for (let i = 0; i < 60; i++) {
      _m1.compose(
        _v1.set((Math.random() - 0.5) * 500, Math.random() * 8, (Math.random() - 0.5) * 14),
        _q1.setFromEuler(new THREE.Euler(Math.random() * 3, Math.random() * 3, 0)),
        _s1.setScalar(0.6 + Math.random() * 1.8)
      );
      boulders.setMatrixAt(i, _m1);
    }
    g.add(boulders);
    this.group.add(g);
    this.avalanche = { group: g, wall, boulders, z: startZ, phase: 0 };
    this.updateAvalanche(0, startZ);
    return this.avalanche;
  }

  updateAvalanche(dt, z) {
    if (!this.avalanche) return;
    const av = this.avalanche;
    av.z = z;
    av.phase += dt * 6;
    const px = this.game.player ? this.game.player.body.pos.x : corridorX(z);
    const y = this.sampleHeightIfLoaded(px, z);
    av.group.position.set(px, (y === null ? -z * this.map.terrain.slope : y) + 18, z);
    av.group.position.y += Math.sin(av.phase) * 0.8;
    av.wall.material.opacity = 0.88 + Math.sin(av.phase * 1.7) * 0.06;
  }

  /* ================= chunk streaming ================= */

  chunkKey(cx, cz) { return `${cx},${cz}`; }

  prewarm(x, z, rings) {
    const ccx = Math.floor(x / CHUNK_SIZE), ccz = Math.floor(z / CHUNK_SIZE);
    for (let dz = -rings; dz <= rings; dz++) {
      for (let dx = -rings; dx <= rings; dx++) {
        this.getOrGenData(ccx + dx, ccz + dz);
      }
    }
  }

  requestChunk(cx, cz) {
    const key = this.chunkKey(cx, cz);
    if (this.chunks.has(key) || this.requested.has(key)) return;
    if (!this.worker) {
      this.getOrGenData(cx, cz);
      return;
    }
    this.requested.add(key);
    this.worker.postMessage({
      id: ++this.reqId, cx, cz,
      seed: this.map.seed,
      terrain: this.map.terrain,
      density: this.densityScaled,
      obstacleTypes: this.game.config.obstacles.types,
      rules: this.game.config.obstacles
    });
  }

  onWorkerChunk(msg) {
    const key = this.chunkKey(msg.cx, msg.cz);
    this.requested.delete(key);
    if (!this.map || this.chunks.has(key)) return;
    this.registerChunk(msg.cx, msg.cz, msg);
  }

  registerChunk(cx, cz, data) {
    const key = this.chunkKey(cx, cz);
    const record = {
      cx, cz, key,
      heights: data.heights, surf: data.surf, normals: data.normals,
      obstacles: this.hydrateObstacles(data.obstacles),
      mesh: null, lod: -1, obstacleMeshes: null, lastNeeded: this.timeU.value
    };
    this.chunks.set(key, record);
    this.buildQueue.push(record);
    return record;
  }

  hydrateObstacles(list) {
    const out = [];
    for (const o of list) {
      const def = this.obstacleTypeMap[o.type];
      if (!def) continue;
      out.push({
        ...o,
        kind: def.kind,
        radius: def.radius,
        def,
        height: OBSTACLE_HEIGHTS[o.type] || 4,
        consumed: false,
        inst: null, instIndex: -1, meshObj: null
      });
    }
    return out;
  }

  getOrGenData(cx, cz) {
    const key = this.chunkKey(cx, cz);
    let chunk = this.chunks.get(key);
    if (chunk) return chunk;
    // Physics needs this ground *now* — generate synchronously.
    const data = this.generator.generateChunk(
      cx, cz, this.densityScaled, this.game.config.obstacles.types, this.game.config.obstacles
    );
    this.requested.delete(key);
    return this.registerChunk(cx, cz, data);
  }

  update(dt, focus) {
    if (!this.map) return;
    this.timeU.value += dt;
    const fx = focus ? focus.x : 0, fz = focus ? focus.z : 0;
    const ccx = Math.floor(fx / CHUNK_SIZE);
    const ccz = Math.floor(fz / CHUNK_SIZE);

    // The run is one-directional (downhill = +Z), so the streaming window
    // is asymmetric: a long corridor of chunks generates AHEAD of the
    // rider (the route literally builds itself as you progress) with only
    // a short tail kept behind. Lateral coverage spans the valley walls.
    const AHEAD = this.aheadChunks;   // quality-scaled forward horizon
    const BEHIND = 1;
    const LATERAL = 2;

    // Request nearest-ahead first so the route in front always exists.
    for (let dz = -BEHIND; dz <= AHEAD; dz++) {
      for (let dx = -LATERAL; dx <= LATERAL; dx++) {
        this.requestChunk(ccx + dx, ccz + dz);
      }
    }

    // Build meshes closest-to-the-rider-first, a few per frame.
    if (this.buildQueue.length > 1) {
      this.buildQueue.sort((a, b) => {
        const pa = Math.abs(a.cz - ccz) * 2 + Math.abs(a.cx - ccx);
        const pb = Math.abs(b.cz - ccz) * 2 + Math.abs(b.cx - ccx);
        return pa - pb;
      });
    }
    // If the ground right under/ahead of the rider has no mesh yet
    // (respawn, teleport, very fast riding), build flat-out this frame.
    let nearMissing = false;
    for (let dz = 0; dz <= 1 && !nearMissing; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const c = this.chunks.get(this.chunkKey(ccx + dx, ccz + dz));
        if (c && !c.mesh) { nearMissing = true; break; }
      }
    }
    let built = 0;
    const budget = nearMissing ? 9 : 3;
    while (this.buildQueue.length && built < budget) {
      const record = this.buildQueue.shift();
      if (!this.chunks.has(record.key)) continue;
      const dz = record.cz - ccz, dx = record.cx - ccx;
      if (dz < -BEHIND - 1 || dz > AHEAD || Math.abs(dx) > LATERAL) continue;
      this.buildChunkMesh(record, (dz >= -1 && dz <= 2 && Math.abs(dx) <= 1) ? 1 : 4);
      built++;
    }

    // LOD swaps + eviction + obstacle visibility.
    for (const [key, chunk] of this.chunks) {
      const dz = chunk.cz - ccz, dx = chunk.cx - ccx;
      if (dz < -BEHIND - 1 || dz > AHEAD + 1 || Math.abs(dx) > LATERAL + 1) {
        this.disposeChunkMeshes(chunk);
        this.chunks.delete(key);
        continue;
      }
      chunk.lastNeeded = this.timeU.value;
      const wantLod = (dz >= -1 && dz <= 2 && Math.abs(dx) <= 1) ? 1 : 4;
      if (chunk.mesh && chunk.lod !== wantLod) {
        this.buildChunkMesh(chunk, wantLod);
      }
      if (chunk.obstacleMeshes) {
        // Near window shows everything; far chunks only along the route.
        const show = (dz >= -1 && dz <= 4 && Math.abs(dx) <= 2)
          || (dz > 4 && dz <= AHEAD && Math.abs(dx) <= 1);
        for (const im of chunk.obstacleMeshes) {
          im.visible = show && !im.userData.consumed;
        }
      }
    }

    // Ambient animation.
    if (this.pulseMaterials) {
      const pulse = 1.4 + Math.sin(this.timeU.value * 3.2) * 0.55;
      for (const m of this.pulseMaterials) m.emissiveIntensity = pulse;
    }
    for (const entry of this.powerupAnim) {
      const m = entry.mesh;
      if (!m.visible) continue;
      m.rotation.y += dt * 2.1;
      m.position.y = entry.ob.y + Math.sin(this.timeU.value * 2.3 + entry.phase) * 0.35;
    }
    this.updateMeteors(dt);
    if (this.impactSpray) this.impactSpray.update(dt);
    if (this.sky && this.game.camera) this.sky.position.copy(this.game.camera.position);

    // Checkpoint gate highlight.
    const session = this.game.session;
    if (session && this.checkpoints.length) {
      for (const cp of this.checkpoints) {
        const active = cp.index === session.checkpointIndex;
        cp.gate.visible = cp.index >= session.checkpointIndex - 1;
        const scale = active ? 1 + Math.sin(this.timeU.value * 4) * 0.03 : 1;
        cp.gate.scale.setScalar(scale);
      }
    }
  }

  /** Position sun light + shadow frustum around the focus point. */
  placeSun(sunDir, focus) {
    if (!this.sun) return;
    this.sun.position.copy(focus).addScaledVector(sunDir, 260);
    this.sun.target.position.copy(focus);
    this.sun.target.updateMatrixWorld();
    if (this.sky) this.sky.material.uniforms.uSunDir.value.copy(sunDir);
  }

  /* ================= mesh building ================= */

  buildChunkMesh(record, lod) {
    this.disposeTerrainMesh(record);
    const n = CHUNK_RES + 1;
    const step = CHUNK_SIZE / CHUNK_RES;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        positions[idx * 3] = i * step;
        positions[idx * 3 + 1] = record.heights[idx];
        positions[idx * 3 + 2] = j * step;
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(record.normals, 3));
    geo.setAttribute('aSurf', new THREE.BufferAttribute(record.surf, 1));
    geo.setIndex(lod === 1 ? this.indexFull : this.indexCoarse);
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.position.set(record.cx * CHUNK_SIZE, 0, record.cz * CHUNK_SIZE);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    record.mesh = mesh;
    record.lod = lod;

    if (!record.obstacleMeshes) this.buildObstacleMeshes(record);
  }

  buildObstacleMeshes(record) {
    record.obstacleMeshes = [];
    const byType = new Map();
    for (const ob of record.obstacles) {
      if (!byType.has(ob.type)) byType.set(ob.type, []);
      byType.get(ob.type).push(ob);
    }
    for (const [type, list] of byType) {
      const tmpl = this.obstacleTemplates[type];
      if (!tmpl) continue;
      if (tmpl.powerup) {
        // Power-ups are few, so each gets its own mesh for spin/bob animation.
        for (const ob of list) {
          const group = new THREE.Group();
          for (const [geo, mat] of tmpl.parts) group.add(new THREE.Mesh(geo, mat));
          group.position.set(ob.x, ob.y, ob.z);
          group.rotation.y = ob.rot;
          group.scale.setScalar(ob.scale);
          group.userData.consumed = false;
          ob.meshObj = group;
          this.group.add(group);
          record.obstacleMeshes.push(group);
          this.powerupAnim.add({ mesh: group, ob, phase: ob.rot * 10 });
        }
        continue;
      }
      for (let p = 0; p < tmpl.parts.length; p++) {
        const [geo, mat] = tmpl.parts[p];
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        im.castShadow = tmpl.shadow && this.game.quality.obstacleShadows;
        im.receiveShadow = false;
        for (let i = 0; i < list.length; i++) {
          const ob = list[i];
          _m1.compose(
            _v1.set(ob.x, ob.y, ob.z),
            _q1.setFromAxisAngle(_v1b.set(0, 1, 0), ob.rot),
            _s1.setScalar(ob.scale)
          );
          im.setMatrixAt(i, _m1);
          if (p === 0) { ob.inst = [im]; ob.instIndex = i; }
          else ob.inst.push(im);
        }
        im.instanceMatrix.needsUpdate = true;
        this.group.add(im);
        record.obstacleMeshes.push(im);
      }
    }
  }

  disposeTerrainMesh(record) {
    if (record.mesh) {
      this.group.remove(record.mesh);
      record.mesh.geometry.dispose();
      record.mesh = null;
    }
  }

  disposeChunkMeshes(record) {
    this.disposeTerrainMesh(record);
    if (record.obstacleMeshes) {
      for (const im of record.obstacleMeshes) {
        this.group.remove(im);
        if (im.isInstancedMesh) im.dispose();
      }
      record.obstacleMeshes = null;
      // Drop animation entries whose meshes were just detached.
      for (const entry of this.powerupAnim) {
        if (!entry.mesh.parent) this.powerupAnim.delete(entry);
      }
    }
  }

  /* ================= queries ================= */

  spawnPoint() {
    return { x: corridorX(0), z: 0 };
  }

  voidY(z) {
    return -z * this.map.terrain.slope - 90;
  }

  sampleHeight(x, z) {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    const chunk = this.getOrGenData(cx, cz);
    return World.bilinear(chunk.heights, x - cx * CHUNK_SIZE, z - cz * CHUNK_SIZE);
  }

  sampleHeightIfLoaded(x, z) {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    const chunk = this.chunks.get(this.chunkKey(cx, cz));
    if (!chunk) return null;
    return World.bilinear(chunk.heights, x - cx * CHUNK_SIZE, z - cz * CHUNK_SIZE);
  }

  static bilinear(grid, lx, lz) {
    const n = CHUNK_RES + 1;
    const step = CHUNK_SIZE / CHUNK_RES;
    let fi = lx / step, fj = lz / step;
    fi = Math.min(CHUNK_RES - 0.0001, Math.max(0, fi));
    fj = Math.min(CHUNK_RES - 0.0001, Math.max(0, fj));
    const i = Math.floor(fi), j = Math.floor(fj);
    const tx = fi - i, tz = fj - j;
    const a = grid[j * n + i], b = grid[j * n + i + 1];
    const c = grid[(j + 1) * n + i], d = grid[(j + 1) * n + i + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  sampleNormal(x, z, out) {
    const e = 1.1;
    const hl = this.sampleHeight(x - e, z), hr = this.sampleHeight(x + e, z);
    const hd = this.sampleHeight(x, z - e), hu = this.sampleHeight(x, z + e);
    out.set(hl - hr, 2 * e, hd - hu).normalize();
    return out;
  }

  surfaceAt(x, z) {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    const chunk = this.getOrGenData(cx, cz);
    const n = CHUNK_RES + 1;
    const step = CHUNK_SIZE / CHUNK_RES;
    const i = Math.round(Math.min(CHUNK_RES, Math.max(0, (x - cx * CHUNK_SIZE) / step)));
    const j = Math.round(Math.min(CHUNK_RES, Math.max(0, (z - cz * CHUNK_SIZE) / step)));
    return chunk.surf[j * n + i];
  }

  obstaclesNear(x, z, r) {
    const out = [];
    const minCx = Math.floor((x - r) / CHUNK_SIZE), maxCx = Math.floor((x + r) / CHUNK_SIZE);
    const minCz = Math.floor((z - r) / CHUNK_SIZE), maxCz = Math.floor((z + r) / CHUNK_SIZE);
    for (let cz = minCz; cz <= maxCz; cz++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const chunk = this.chunks.get(this.chunkKey(cx, cz));
        if (!chunk) continue;
        for (const ob of chunk.obstacles) {
          const dx = ob.x - x, dz = ob.z - z;
          const reach = r + ob.radius * ob.scale;
          if (dx * dx + dz * dz < reach * reach) out.push(ob);
        }
      }
    }
    return out;
  }

  consumeObstacle(ob) {
    ob.consumed = true;
    if (ob.meshObj) {
      ob.meshObj.visible = false;
      ob.meshObj.userData.consumed = true;
    }
    if (ob.inst && ob.instIndex >= 0) {
      _m1.makeScale(0.0001, 0.0001, 0.0001);
      for (const im of ob.inst) {
        im.setMatrixAt(ob.instIndex, _m1);
        im.instanceMatrix.needsUpdate = true;
      }
    }
  }
}

const _v1b = new THREE.Vector3();

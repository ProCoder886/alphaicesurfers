/**
 * ai.js — AI riders, ghost playback and race management.
 *
 * AI riders run the exact same PhysicsEngine.integrateRider() as the
 * player, so they obey identical friction/grip/gravity rules. Their
 * "brain" produces the same input struct a human would: steer toward a
 * target line, avoid obstacles by sampling ahead, pop ramps, make
 * occasional personality-driven mistakes, and rubber-band subtly so
 * races stay close without feeling scripted.
 */

import * as THREE from 'three';
import { createRiderBody, wrapAngle } from './physics.js';
import { buildRider } from './player.js';
import { corridorX, mulberry32 } from '../workers/terrainWorker.js';

const AI_NAMES = [
  'Kira', 'Bjorn', 'Yuki', 'Sasha', 'Nanook', 'Elsa', 'Ragnar', 'Miko',
  'Freya', 'Otso', 'Anouk', 'Sven'
];
const AI_COLORS = [
  { suit: '#e2543a', accent: '#ffd166', board: '#ff5a2a', glow: '#ffc94a' },
  { suit: '#57d132', accent: '#1b1f24', board: '#37e6a0', glow: '#a9f8ff' },
  { suit: '#8b5cf6', accent: '#f0abfc', board: '#c86bff', glow: '#f0abfc' },
  { suit: '#1cc4b0', accent: '#ffffff', board: '#c0f0ff', glow: '#ffffff' },
  { suit: '#f43f5e', accent: '#0f172a', board: '#171a21', glow: '#ff4fd8' },
  { suit: '#f59e0b', accent: '#3b82f6', board: '#00e5ff', glow: '#c86bff' },
  { suit: '#3b82f6', accent: '#facc15', board: '#ffd166', glow: '#fff3b0' },
  { suit: '#0ea5a3', accent: '#ff9d3c', board: '#0f766e', glow: '#5eead4' },
  { suit: '#a3e635', accent: '#14532d', board: '#65a30d', glow: '#d9f99d' },
  { suit: '#e879f9', accent: '#1e1b4b', board: '#701a75', glow: '#f5d0fe' }
];

function makeNameSprite(name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 34px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(6,10,20,0.55)';
  ctx.beginPath();
  ctx.roundRect(48, 8, 160, 48, 12);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(name, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false
  }));
  sprite.scale.set(2.4, 0.6, 1);
  sprite.position.y = 2.2;
  return sprite;
}

export class AIRider {
  constructor(game, index) {
    this.game = game;
    this.index = index;
    this.name = AI_NAMES[index % AI_NAMES.length];
    const colors = AI_COLORS[index % AI_COLORS.length];
    this.rng = mulberry32(game.world.map.seed + 977 * (index + 1));

    const diffBonus = game.difficulty ? game.difficulty.aiSkillBonus : 0;
    this.skill = Math.min(0.98, Math.max(0.3, 0.62 + this.rng() * 0.33 + diffBonus));
    this.aggression = 0.4 + this.rng() * 0.6;
    // Ride slightly below the player's cruise; top-skill rivals match it.
    this.cruiseScale = 0.8 + this.skill * 0.22;

    this.body = createRiderBody();
    const { group, refs } = buildRider(colors);
    this.mesh = group;
    this.refs = refs;
    this.mesh.add(makeNameSprite(this.name, colors.glow));
    game.scene.add(this.mesh);

    this.checkpointIndex = 0;
    this.finished = false;
    this.finishTime = 0;
    this.crashTimer = 0;
    this.mistakeTimer = this.nextMistakeDelay();
    this.mistakeActive = 0;
    this.flipVisual = 0;
    this.steerSmooth = 0;
  }

  nextMistakeDelay() {
    const [lo, hi] = this.game.config.physics.ai.mistakeCooldown;
    // Better riders wait longer between mistakes.
    return (lo + this.rng() * (hi - lo)) * (0.6 + this.skill);
  }

  spawn(x, z) {
    const h = this.game.world.sampleHeight(x, z);
    this.body.pos.set(x, h + this.body.boardOffset, z);
    this.body.vel.set(0, 0, 0);
    this.body.heading = 0;
    this.body.grounded = true;
    this.checkpointIndex = 0;
    this.finished = false;
    this.mesh.position.copy(this.body.pos);
  }

  /** Target point the rider is steering toward. */
  targetPoint() {
    const world = this.game.world;
    const b = this.body;
    if (world.checkpoints.length && this.checkpointIndex < world.checkpoints.length) {
      const cp = world.checkpoints[this.checkpointIndex];
      // Far from the gate: follow the corridor line; near it: aim at the gate.
      const far = THREE.MathUtils.clamp((cp.z - b.pos.z - 40) / 120, 0, 1);
      const cx = corridorX(b.pos.z + 30);
      return { x: cp.x + (cx - cp.x) * far, z: cp.z };
    }
    const ahead = 34;
    return { x: corridorX(b.pos.z + ahead), z: b.pos.z + ahead };
  }

  fixedUpdate(dt) {
    const game = this.game;
    const cfg = game.config.physics;
    const b = this.body;

    if (this.finished) {
      // Coast to a stop past the finish line.
      game.physics.integrateRider(b, {
        steer: 0, tuck: false, brake: true, boost: false, jumpImpulse: 0, airControl: 0
      }, dt);
      return;
    }

    if (this.crashTimer > 0) {
      this.crashTimer -= dt;
      b.vel.multiplyScalar(Math.max(0, 1 - 2 * dt));
      game.physics.integrateRider(b, {
        steer: 0, tuck: false, brake: true, boost: false, jumpImpulse: 0, airControl: 0
      }, dt);
      return;
    }

    // --- steering brain ---
    const target = this.targetPoint();
    const desired = Math.atan2(target.x - b.pos.x, target.z - b.pos.z);
    let steer = THREE.MathUtils.clamp(wrapAngle(desired - b.heading) * 2.2, -1, 1);

    // Obstacle avoidance: probe ahead along the velocity direction.
    const speed = b.vel.length();
    const lookAhead = THREE.MathUtils.lerp(
      cfg.ai.lookAheadNear, cfg.ai.lookAheadFar, Math.min(1, speed / 30)
    );
    const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
    const px = b.pos.x + fx * lookAhead, pz = b.pos.z + fz * lookAhead;
    const near = game.world.obstaclesNear(px, pz, 7);
    for (const ob of near) {
      if (ob.kind !== 'solid' || ob.consumed) continue;
      // Side of the obstacle relative to travel direction decides dodge direction.
      const relX = (ob.x - b.pos.x) * fz - (ob.z - b.pos.z) * fx;
      const dist = Math.hypot(ob.x - px, ob.z - pz);
      const urgency = Math.max(0, 1 - dist / 8);
      steer += (relX > 0 ? -1 : 1) * urgency * cfg.ai.avoidStrength * this.skill;
    }
    steer = THREE.MathUtils.clamp(steer, -1, 1);

    // --- mistakes ---
    this.mistakeTimer -= dt;
    if (this.mistakeTimer <= 0) {
      this.mistakeActive = 0.5 + this.rng() * 0.7;
      this.mistakeTimer = this.nextMistakeDelay();
    }
    if (this.mistakeActive > 0) {
      this.mistakeActive -= dt;
      steer += Math.sin(game.elapsed * 9 + this.index) * (1 - this.skill) * 1.4;
      steer = THREE.MathUtils.clamp(steer, -1, 1);
    }

    this.steerSmooth += (steer - this.steerSmooth) * Math.min(1, dt * 6);

    // --- rubber-banding vs player ---
    let boost = false;
    let tuck = speed > 12 && Math.abs(this.steerSmooth) < 0.4;
    const player = game.player;
    if (player && game.mode && game.mode.race) {
      const gap = player.body.pos.z - b.pos.z;
      if (gap > cfg.ai.rubberBandRange * 0.4) boost = this.rng() < 0.6;
      else if (gap < -cfg.ai.rubberBandRange) tuck = false;
    }

    // --- jumps off ramps for style ---
    let jumpImpulse = 0;
    if (b.grounded && this.rng() < 0.002 * this.aggression && speed > 14) {
      jumpImpulse = 5 + this.rng() * 3;
    }

    const wasGrounded = b.grounded;
    const events = game.physics.integrateRider(b, {
      steer: b.grounded ? this.steerSmooth : 0,
      tuck, brake: false,
      boost,
      jumpImpulse,
      cruiseScale: this.cruiseScale,
      airControl: 0
    }, dt);

    // Simple trick flair in the air.
    if (!b.grounded) {
      if (wasGrounded) this.flipVisual = 0;
      if (b.airTime > 0.4 && this.aggression > 0.6) {
        this.flipVisual += dt * 5.2;
      }
    } else {
      this.flipVisual *= Math.max(0, 1 - dt * 10);
    }

    if (events.landed && events.impact > 16 && this.rng() < 0.4 * (1 - this.skill)) {
      this.crashTimer = 1.2;
    }
    if (events.hitSolid && events.impactSpeed > cfg.rider.crashImpactSpeed) {
      this.crashTimer = 1.4;
    }

    // Ramp triggers help AI keep pace with airborne routes.
    for (const ob of events.triggers) {
      if (ob.def.effect === 'ramp' && b.grounded && speed > 8) {
        b.vel.y += speed * ob.def.kick * 0.8;
        b.grounded = false;
        b.airTime = 0;
      }
    }

    // --- checkpoint progress ---
    const world = game.world;
    if (world.checkpoints.length && this.checkpointIndex < world.checkpoints.length) {
      const cp = world.checkpoints[this.checkpointIndex];
      if (Math.hypot(b.pos.x - cp.x, b.pos.z - cp.z) < cp.radius + 6 || b.pos.z > cp.z + 12) {
        this.checkpointIndex++;
        if (this.checkpointIndex >= world.checkpoints.length) {
          this.finished = true;
          this.finishTime = game.session ? game.session.time : 0;
          game.bus.emit('ai-finished', { name: this.name, time: this.finishTime });
        }
      }
    }

    // Void safety: teleport back onto the corridor.
    if (b.pos.y < world.voidY(b.pos.z)) {
      const z = b.pos.z + 20;
      this.spawn(corridorX(z), z);
    }
  }

  update(dt) {
    const b = this.body;
    this.mesh.position.copy(b.pos);
    const targetQ = _q.setFromUnitVectors(_up, b.grounded ? b.groundNormal : _up)
      .multiply(_q2.setFromAxisAngle(_up, b.heading));
    this.mesh.quaternion.slerp(targetQ, Math.min(1, dt * 12));
    this.refs.flip.rotation.x = this.flipVisual;
    this.refs.tilt.rotation.z += ((-this.steerSmooth * 0.45) - this.refs.tilt.rotation.z) * Math.min(1, dt * 8);
    if (this.crashTimer > 0) {
      this.refs.armL.rotation.z = 1.8;
      this.refs.armR.rotation.z = -1.8;
    }
  }

  /** Race progress metric — bigger is further along. */
  progress() {
    return this.checkpointIndex * 10000 + this.body.pos.z;
  }

  dispose() {
    this.game.scene.remove(this.mesh);
    this.mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
  }
}

const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

/** Replays a recorded run as a translucent rider. */
export class GhostRider {
  constructor(game, samples) {
    this.game = game;
    this.samples = samples; // packed [t, x, y, z, heading] * n
    const { group, refs } = buildRider({
      suit: '#9fd8f0', accent: '#ffffff', board: '#9fd8f0', glow: '#ffffff'
    });
    this.mesh = group;
    this.refs = refs;
    this.mesh.traverse((o) => {
      if (o.material) {
        o.material.transparent = true;
        o.material.opacity = 0.35;
        o.material.depthWrite = false;
      }
    });
    game.scene.add(this.mesh);
    this.cursor = 0;
  }

  update(time) {
    const s = this.samples;
    const stride = 5;
    const count = Math.floor(s.length / stride);
    if (count < 2) return;
    // Advance cursor to bracket `time`.
    while (this.cursor < count - 2 && s[(this.cursor + 1) * stride] < time) this.cursor++;
    while (this.cursor > 0 && s[this.cursor * stride] > time) this.cursor--;
    const i0 = this.cursor * stride, i1 = Math.min(count - 1, this.cursor + 1) * stride;
    const t0 = s[i0], t1 = s[i1];
    const f = t1 > t0 ? THREE.MathUtils.clamp((time - t0) / (t1 - t0), 0, 1) : 0;
    this.mesh.position.set(
      THREE.MathUtils.lerp(s[i0 + 1], s[i1 + 1], f),
      THREE.MathUtils.lerp(s[i0 + 2], s[i1 + 2], f),
      THREE.MathUtils.lerp(s[i0 + 3], s[i1 + 3], f)
    );
    const h0 = s[i0 + 4], h1 = s[i1 + 4];
    this.mesh.rotation.y = h0 + wrapAngle(h1 - h0) * f;
  }

  dispose() {
    this.game.scene.remove(this.mesh);
    this.mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
}

export class AIManager {
  constructor(game) {
    this.game = game;
    this.riders = [];
    this.ghost = null;
  }

  spawnForSession(mode) {
    this.clear();
    let count = mode.aiRiders || 0;
    // Harder difficulties field more rivals (only in modes that have any).
    if (count > 0 && this.game.difficulty) count += this.game.difficulty.aiExtra;
    count = Math.min(count, 10);
    const spawn = this.game.world.spawnPoint();
    for (let i = 0; i < count; i++) {
      const rider = new AIRider(this.game, i);
      const offset = (i % 2 === 0 ? 1 : -1) * (4 + Math.floor(i / 2) * 4);
      rider.spawn(spawn.x + offset, spawn.z - 4 - (i % 3) * 3);
      this.riders.push(rider);
    }
  }

  async loadGhost(mapId) {
    const record = await this.game.save.loadGhost(mapId);
    if (record && record.samples && record.samples.length >= 10) {
      this.ghost = new GhostRider(this.game, record.samples);
      this.ghost.bestTime = record.time;
      return record.time;
    }
    return null;
  }

  fixedUpdate(dt) {
    for (const r of this.riders) r.fixedUpdate(dt);
  }

  update(dt) {
    for (const r of this.riders) r.update(dt);
    if (this.ghost && this.game.session) this.ghost.update(this.game.session.time);
  }

  /** Sorted standings including the player. */
  standings() {
    const session = this.game.session;
    const player = this.game.player;
    const rows = this.riders.map((r) => ({
      name: r.name, ai: true,
      finished: r.finished, finishTime: r.finishTime,
      progress: r.progress()
    }));
    rows.push({
      name: 'YOU', ai: false,
      finished: !!(session && session.finished), finishTime: session ? session.time : 0,
      progress: session ? session.checkpointIndex * 10000 + player.body.pos.z : 0
    });
    rows.sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    return rows;
  }

  clear() {
    for (const r of this.riders) r.dispose();
    this.riders = [];
    if (this.ghost) { this.ghost.dispose(); this.ghost = null; }
  }
}

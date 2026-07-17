/**
 * physics.js — Bespoke deterministic rider physics for ice surfing.
 *
 * A purpose-built arcade-simulation hybrid tuned for carving feel:
 * heightfield ground contact, per-surface friction & edge grip, slope
 * acceleration, momentum-preserving carve model, air phase with wind,
 * landing impact evaluation and obstacle collision.
 *
 * The engine is shared by the player and every AI rider so all riders
 * obey identical rules. It is deterministic for a fixed timestep, which
 * keeps ghost replays honest. (See docs/architecture.md for why this
 * project uses a custom integrator rather than a general-purpose WASM
 * physics engine like Rapier.)
 */

import * as THREE from 'three';
import { corridorX } from '../workers/terrainWorker.js';

const _fwd = new THREE.Vector3();
const _flat = new THREE.Vector3();
const _n = new THREE.Vector3();
const _tmp = new THREE.Vector3();

export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Create a fresh rider body. Heading 0 faces +Z (downhill). */
export function createRiderBody() {
  return {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    heading: 0,
    grounded: true,
    airTime: 0,
    groundNormal: new THREE.Vector3(0, 1, 0),
    surface: 0,        // iciness at contact (0..1, >1.1 lake)
    slopeSpeed: 0,
    crashed: false,
    boardOffset: 0.12
  };
}

export class PhysicsEngine {
  constructor(game) {
    this.game = game;
    this.cfg = game.config.physics;
    this.wind = new THREE.Vector2(0, 0); // world XZ, set by WeatherSystem
  }

  get world() { return this.game.world; }

  /** Map continuous iciness to blended surface parameters. */
  surfaceParams(icy) {
    const surfaces = this.cfg.surfaces;
    if (icy > 1.1) {
      const s = surfaces[4];
      return { friction: s.friction, grip: s.grip, name: s.name, audio: s.audio };
    }
    // Piecewise blend across powder -> packed -> blue ice -> black ice.
    const t = Math.min(0.999, Math.max(0, icy)) * 3;
    const i = Math.floor(t);
    const f = t - i;
    const a = surfaces[i], b = surfaces[Math.min(3, i + 1)];
    return {
      friction: a.friction + (b.friction - a.friction) * f,
      grip: a.grip + (b.grip - a.grip) * f,
      name: (f < 0.5 ? a : b).name,
      audio: (f < 0.5 ? a : b).audio
    };
  }

  /**
   * Advance one rider body by dt.
   *
   * @param {object} body    rider body from createRiderBody()
   * @param {object} input   { steer, tuck, brake, boost, jumpImpulse, airControl }
   * @param {number} dt      fixed timestep (s)
   * @returns {object} events { landed, impact, hitSolid, impactSpeed, triggers[] }
   */
  integrateRider(body, input, dt) {
    const cfg = this.cfg.rider;
    const g = this.cfg.gravity;
    const world = this.world;
    const events = { landed: false, impact: 0, hitSolid: null, impactSpeed: 0, triggers: [] };

    const groundH = world.sampleHeight(body.pos.x, body.pos.z);
    world.sampleNormal(body.pos.x, body.pos.z, _n);

    if (body.grounded) {
      const icy = world.surfaceAt(body.pos.x, body.pos.z);
      body.surface = icy;
      const surf = this.surfaceParams(icy);
      body.groundNormal.copy(_n);

      // --- difficulty-scaled speed envelope ---
      const diff = this.game.difficulty;
      const cruiseScale = input.cruiseScale || 1;
      const cruise = (diff ? diff.cruise : 32) * cruiseScale
        * (input.tuck ? this.game.config.gameplay.autoRide.tuckCruiseBonus : 1);
      const maxSpeed = (diff ? diff.maxSpeed : cfg.maxSpeed) * cruiseScale;

      // --- steering ---
      const speed = body.vel.length();
      const speedT = Math.min(1, speed / maxSpeed);
      const turnRate = cfg.turnSpeed + (cfg.turnSpeedAtMax - cfg.turnSpeed) * speedT;
      body.heading = wrapAngle(body.heading + input.steer * turnRate * dt);

      _fwd.set(Math.sin(body.heading), 0, Math.cos(body.heading));

      // --- auto-ride engine: the board carries the rider forward on its
      // own, holding full thrust until ~80% of the difficulty's cruise
      // speed and tapering after, so the rider actually reaches cruise
      // against friction and drag. No throttle button needed.
      if (!input.brake) {
        const deficit = Math.max(0, 1 - speed / cruise);
        const thrust = Math.min(1, deficit * 5);
        body.vel.addScaledVector(_fwd, this.game.config.gameplay.autoRide.accel * thrust * dt);
      }

      // --- gravity along slope ---
      // Slope tangent acceleration: g projected onto surface plane.
      _tmp.set(0, -g, 0);
      const nDot = _tmp.dot(_n);
      _tmp.addScaledVector(_n, -nDot); // tangential component
      body.vel.addScaledVector(_tmp, dt);

      // --- carve: rotate velocity toward board heading ---
      _flat.set(body.vel.x, 0, body.vel.z);
      const flatSpeed = _flat.length();
      if (flatSpeed > 0.4) {
        const velAngle = Math.atan2(_flat.x, _flat.z);
        let diff = wrapAngle(body.heading - velAngle);
        // Riding switch (backwards) carves toward the reversed heading.
        if (Math.abs(diff) > Math.PI / 2) diff = wrapAngle(diff + Math.PI);
        const gripRate = surf.grip * (input.brake ? 1.35 : 1);
        const rot = THREE.MathUtils.clamp(diff, -1, 1) * Math.min(1, gripRate * dt);
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const vx = _flat.x * cos + _flat.z * sin;
        const vz = -_flat.x * sin + _flat.z * cos;
        body.vel.x = vx; body.vel.z = vz;
        // Scrubbing speed off while carving hard.
        const scrub = Math.abs(diff) * cfg.carveScrub * flatSpeed * dt;
        this.scaleHorizontal(body.vel, Math.max(0, 1 - scrub / Math.max(flatSpeed, 0.001)));
      }

      // --- friction & braking ---
      let mu = surf.friction;
      if (input.brake) mu += cfg.brakeFriction;
      // Friction grows only mildly with speed so downhill runs keep building
      // pace — top-end is governed by aero drag and maxSpeed instead.
      const fr = mu * g * Math.max(0.2, _n.y) * dt;
      const sp2 = body.vel.length();
      if (sp2 > 0.001) {
        const newSpeed = Math.max(0, sp2 - fr * (1 + sp2 * 0.018));
        body.vel.multiplyScalar(newSpeed / sp2);
      }

      // --- aerodynamic drag: only bites above cruise, relaxing speed back
      // toward it, so every difficulty actually reaches its target pace.
      // Tucking raises the ceiling; boost ignores it entirely.
      const sp3 = body.vel.length();
      const ceiling = cruise * (input.tuck ? 1.06 : 1.0);
      if (sp3 > ceiling && !input.boost) {
        const dragScale = input.tuck ? cfg.tuckDragScale : 1;
        const newSpeed = sp3 - (sp3 - ceiling) * 1.25 * dragScale * dt;
        body.vel.multiplyScalar(newSpeed / sp3);
      }

      // --- boost thrust ---
      if (input.boost) {
        const boostAccel = diff ? diff.boostAccel : this.game.config.gameplay.boost.accel;
        body.vel.addScaledVector(_fwd, boostAccel * dt);
      }

      // --- speed cap ---
      const spd = body.vel.length();
      const cap = maxSpeed * (input.boost ? 1.15 : 1);
      if (spd > cap) body.vel.multiplyScalar(cap / spd);

      // --- jump ---
      if (input.jumpImpulse > 0) {
        // Launch along a blend of straight-up and the surface normal, with a
        // small assist when popping off downhill slopes at speed.
        body.vel.y += input.jumpImpulse * (0.75 + _n.y * 0.25);
        body.vel.y += Math.max(0, 1 - _n.y) * Math.min(10, body.vel.length()) * cfg.slopeJumpAssist;
        body.grounded = false;
        body.airTime = 0;
      }
    } else {
      // --- airborne ---
      if (input.wingsuit) {
        // Wingsuit: most of gravity becomes lift, the suit drives forward,
        // and air steering sharpens — a glide, not a fall.
        body.vel.y -= g * 0.22 * dt;
        _fwd.set(Math.sin(body.heading), 0, Math.cos(body.heading));
        body.vel.addScaledVector(_fwd, 9.5 * dt);
        const wcap = (this.game.difficulty ? this.game.difficulty.maxSpeed : 60) * 1.1;
        const wspd = body.vel.length();
        if (wspd > wcap) body.vel.multiplyScalar(wcap / wspd);
      } else {
        body.vel.y -= g * dt;
      }
      body.airTime += dt;
      // Wind pushes harder in the air.
      const windMul = this.cfg.wind.airborneMultiplier * dt;
      body.vel.x += this.wind.x * windMul;
      body.vel.z += this.wind.y * windMul;
      // Air steering (weak drift control; strong in a wingsuit).
      if (input.airControl) {
        _fwd.set(Math.sin(body.heading), 0, Math.cos(body.heading));
        body.vel.addScaledVector(_fwd, input.airControl * (input.wingsuit ? 6 : 2) * dt);
      }
    }

    // Ground-level wind (weak).
    if (body.grounded) {
      body.vel.x += this.wind.x * dt * 0.35;
      body.vel.z += this.wind.y * dt * 0.35;
    }

    // --- integrate position ---
    body.pos.addScaledVector(body.vel, dt);

    // --- ground clamp / landing ---
    const newH = this.world.sampleHeight(body.pos.x, body.pos.z) + body.boardOffset;
    if (body.grounded) {
      if (body.pos.y < newH + 0.6) {
        body.pos.y = newH;
        // Remove velocity into the ground.
        this.world.sampleNormal(body.pos.x, body.pos.z, _n);
        const vDotN = body.vel.dot(_n);
        if (vDotN < 0) body.vel.addScaledVector(_n, -vDotN);
      } else {
        // Ran off an edge.
        body.grounded = false;
        body.airTime = 0;
      }
    } else if (body.pos.y <= newH && body.vel.y <= 0.01) {
      body.pos.y = newH;
      this.world.sampleNormal(body.pos.x, body.pos.z, _n);
      events.landed = true;
      events.impact = Math.max(0, -body.vel.dot(_n));
      const vDotN = body.vel.dot(_n);
      if (vDotN < 0) body.vel.addScaledVector(_n, -vDotN);
      body.grounded = true;
    }

    // --- valley boundary: nobody rides out over the walls ---
    if (this.world.map) {
      const t = this.world.map.terrain;
      const limit = (t.floorWidth || 16) + (t.wallSpan || 95) * 0.85;
      const cor = corridorX(body.pos.z);
      const dxc = body.pos.x - cor;
      if (Math.abs(dxc) > limit) {
        body.pos.x = cor + Math.sign(dxc) * limit;
        if (body.vel.x * Math.sign(dxc) > 0) body.vel.x *= -0.25;
      }
    }

    // Track downhill component for HUD/jump assist.
    body.slopeSpeed = body.vel.z;

    // --- obstacles ---
    this.collideObstacles(body, events);

    return events;
  }

  scaleHorizontal(vel, s) {
    vel.x *= s; vel.z *= s;
  }

  collideObstacles(body, events) {
    const nearby = this.world.obstaclesNear(body.pos.x, body.pos.z, 6);
    if (!nearby.length) return;
    const rr = this.cfg.rider.radius;
    for (const ob of nearby) {
      if (ob.consumed) continue;
      const dx = body.pos.x - ob.x;
      const dz = body.pos.z - ob.z;
      const d2 = dx * dx + dz * dz;
      const reach = (ob.radius * ob.scale + rr);
      if (ob.kind === 'solid') {
        if (d2 >= reach * reach) continue;
        // Vertical overlap check (can fly over rocks & under rings).
        const top = ob.y + (ob.height || 6) * ob.scale;
        if (body.pos.y > top) continue;
        const d = Math.sqrt(d2) || 0.001;
        const push = (reach - d);
        const nx = dx / d, nz = dz / d;
        body.pos.x += nx * push;
        body.pos.z += nz * push;
        // Impact = velocity into the obstacle.
        const into = -(body.vel.x * nx + body.vel.z * nz);
        if (into > 0) {
          body.vel.x += nx * into * 1.4; // slight bounce
          body.vel.z += nz * into * 1.4;
          // Deflect sideways so riders slide off instead of pinning head-on.
          const side = (body.vel.x * nz - body.vel.z * nx) >= 0 ? 1 : -1;
          body.vel.x += nz * side * into * 0.45;
          body.vel.z += -nx * side * into * 0.45;
          this.scaleHorizontal(body.vel, 0.72);
          if (into > events.impactSpeed) {
            events.impactSpeed = into;
            events.hitSolid = ob;
          }
        }
      } else {
        // Trigger volumes: full 3D distance (rings hover above ground).
        const dy = body.pos.y - ob.y;
        const trigReach = ob.radius * ob.scale + rr;
        if (d2 + dy * dy < trigReach * trigReach) {
          events.triggers.push(ob);
        }
      }
    }
  }

  /**
   * Evaluate landing quality from rotation remainder and slope alignment.
   * @returns {'perfect'|'good'|'sketchy'|'crash'}
   */
  landingQuality(flipDeg, impact, normal) {
    const cfg = this.cfg.rider;
    // How far from a clean 360-multiple the flip rotation ended.
    const rem = Math.abs(wrapAngle((flipDeg * Math.PI) / 180));
    const remDeg = (rem * 180) / Math.PI;
    if (remDeg > cfg.landingCrashAngle || impact > 21) return 'crash';
    if (remDeg > cfg.landingGoodAngle) return 'sketchy';
    if (remDeg <= cfg.landingPerfectAngle && impact < 15) return 'perfect';
    return 'good';
  }
}

/**
 * player.js — Player controller: rider rig, skating input model, trick
 * detection & scoring, landings, crashes, boost, ghost recording and
 * snow-spray VFX. AI riders reuse buildRider() and the same physics.
 */

import * as THREE from 'three';
import { createRiderBody, wrapAngle } from './physics.js';

const _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();

/**
 * Build a stylised low-poly rider + board rig from a color set.
 * @param {{suit:string, accent:string, board:string, glow:string}} colors
 */
export function buildRider(colors) {
  const mat = (c, opts = {}) => new THREE.MeshStandardMaterial({
    color: new THREE.Color(c), roughness: 0.7, ...opts
  });
  const suit = mat(colors.suit);
  const accent = mat(colors.accent, { roughness: 0.5 });
  const boardMat = mat(colors.board, { roughness: 0.35, metalness: 0.25 });
  const glowMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(colors.glow),
    emissive: new THREE.Color(colors.glow),
    emissiveIntensity: 1.8
  });

  const root = new THREE.Group();
  root.scale.setScalar(1.22); // riders read larger against the big valley
  const tilt = new THREE.Group();   // slope alignment + carve lean
  const flip = new THREE.Group();   // airborne flip rotation
  root.add(tilt);
  tilt.add(flip);

  // --- board ---
  const board = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.08, 1.92), boardMat);
  deck.castShadow = true;
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 1.7), glowMat);
  stripe.position.y = 0.05;
  const underglow = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 1.75), glowMat);
  underglow.position.y = -0.05;
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.07, 0.3), boardMat);
  nose.position.set(0, 0.07, 1.02);
  nose.rotation.x = -0.5;
  board.add(deck, stripe, underglow, nose);
  flip.add(board);

  // --- body (slight surf stance) ---
  const body = new THREE.Group();
  body.position.y = 0.06;
  body.rotation.y = 0.32;
  flip.add(body);

  const legGeo = new THREE.BoxGeometry(0.17, 0.58, 0.17);
  const legL = new THREE.Mesh(legGeo, suit);
  legL.position.set(-0.17, 0.32, 0.18);
  const legR = new THREE.Mesh(legGeo, suit);
  legR.position.set(0.17, 0.32, -0.18);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.56, 0.26), suit);
  torso.position.y = 0.92;
  torso.castShadow = true;
  const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.36, 0.16), accent);
  backpack.position.set(0, 0.95, -0.22);

  const armGeo = new THREE.BoxGeometry(0.13, 0.52, 0.13);
  const armMeshL = new THREE.Mesh(armGeo, suit);
  armMeshL.position.y = -0.24;
  const armL = new THREE.Group();
  armL.position.set(-0.3, 1.16, 0);
  armL.rotation.z = 0.5;
  armL.add(armMeshL);
  const armMeshR = new THREE.Mesh(armGeo, suit);
  armMeshR.position.y = -0.24;
  const armR = new THREE.Group();
  armR.position.set(0.3, 1.16, 0);
  armR.rotation.z = -0.5;
  armR.add(armMeshR);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 10), mat('#e8c39e'));
  head.position.y = 1.38;
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.175, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), accent
  );
  helmet.position.y = 1.4;
  const goggles = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.08, 0.06), glowMat);
  goggles.position.set(0, 1.38, 0.13);

  body.add(legL, legR, torso, backpack, armL, armR, head, helmet, goggles);

  return {
    group: root,
    refs: { tilt, flip, board, body, armL, armR, legL, legR, torso, head }
  };
}

/** Lightweight recyclable snow-spray particle system. */
export class SprayEmitter {
  constructor(scene, color, count = 220) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.cursor = 0;
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    this.points = new THREE.Points(geo, new THREE.PointsMaterial({
      color: new THREE.Color(color), size: 0.22, transparent: true,
      opacity: 0.85, depthWrite: false, sizeAttenuation: true
    }));
    this.points.frustumCulled = false;
    for (let i = 0; i < count; i++) this.positions[i * 3 + 1] = -9999;
    scene.add(this.points);
  }

  spawn(pos, baseVel, count, spread = 1.6) {
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.count;
      this.positions[i * 3] = pos.x + (Math.random() - 0.5) * 0.3;
      this.positions[i * 3 + 1] = pos.y + Math.random() * 0.15;
      this.positions[i * 3 + 2] = pos.z + (Math.random() - 0.5) * 0.3;
      this.velocities[i * 3] = baseVel.x * 0.25 + (Math.random() - 0.5) * spread;
      this.velocities[i * 3 + 1] = 1.2 + Math.random() * 2.2;
      this.velocities[i * 3 + 2] = baseVel.z * 0.25 + (Math.random() - 0.5) * spread;
      this.life[i] = 0.5 + Math.random() * 0.4;
    }
  }

  update(dt) {
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.positions[i * 3 + 1] = -9999; continue; }
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      this.velocities[i * 3 + 1] -= 9.8 * dt;
    }
    this.posAttr.needsUpdate = true;
  }

  dispose(scene) {
    scene.remove(this.points);
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}

/**
 * Fading ribbon left in the snow behind the board — a cheap dynamic
 * strip mesh (ring buffer of cross-sections, alpha fades with age).
 */
export class BoardTrail {
  constructor(scene, color, maxPoints = 70) {
    this.max = maxPoints;
    this.points = [];      // { l:Vector3, r:Vector3, age:0 }
    this.timer = 0;
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(maxPoints * 2 * 3);
    this.alphas = new Float32Array(maxPoints * 2);
    this.posAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr = new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aA', this.alphaAttr);
    const idx = [];
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) } },
      vertexShader: `attribute float aA; varying float vA;
        void main(){ vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uColor; varying float vA;
        void main(){ if (vA < 0.01) discard; gl_FragColor = vec4(uColor, vA * 0.5); }`,
      transparent: true,
      depthWrite: false
    }));
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  push(pos, heading) {
    const px = Math.cos(heading) * 0.28, pz = -Math.sin(heading) * 0.28;
    this.points.push({
      lx: pos.x - px, ly: pos.y + 0.06, lz: pos.z - pz,
      rx: pos.x + px, ry: pos.y + 0.06, rz: pos.z + pz,
      age: 0
    });
    if (this.points.length > this.max) this.points.shift();
  }

  update(dt, body, grounded, speed) {
    this.timer -= dt;
    if (grounded && speed > 7 && this.timer <= 0) {
      this.timer = 0.035;
      this.push(body.pos, body.heading);
    }
    const n = this.points.length;
    for (let i = 0; i < this.max; i++) {
      const p = this.points[i];
      if (!p) {
        this.alphas[i * 2] = this.alphas[i * 2 + 1] = 0;
        continue;
      }
      p.age += dt;
      const a = Math.max(0, 1 - p.age / 1.6) * (i / Math.max(1, n));
      this.positions[i * 6] = p.lx; this.positions[i * 6 + 1] = p.ly; this.positions[i * 6 + 2] = p.lz;
      this.positions[i * 6 + 3] = p.rx; this.positions[i * 6 + 4] = p.ry; this.positions[i * 6 + 5] = p.rz;
      this.alphas[i * 2] = a;
      this.alphas[i * 2 + 1] = a;
    }
    this.posAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

export class Player {
  constructor(game) {
    this.game = game;
    this.body = createRiderBody();
    this.mesh = null;
    this.refs = null;
    this.spray = null;

    // Control state
    this.jumpCharge = 0;
    this.chargingJump = false;
    this.boosting = false;

    // Air trick state
    this.spinAccum = 0;      // radians of yaw in air
    this.flipAccum = 0;      // radians of pitch in air
    this.flipVisual = 0;
    this.grabTime = 0;
    this.grabName = null;
    this.airStartY = 0;

    // Combo
    this.comboCount = 0;
    this.comboTimer = 0;
    this.comboScore = 0;

    // Crash / recovery
    this.crashTimer = 0;
    this.tumbleSpin = new THREE.Vector3();

    this.lastSafe = { x: 0, z: 0, heading: 0 };
    this.safeTimer = 0;
    this.rampCooldowns = new Map();

    // Active power-up timers (seconds remaining).
    this.effects = { magnet: 0, shield: 0, nitro: 0, multiplier: 0, wingsuit: 0 };
    this.shieldMesh = null;
    this.wingMesh = null;
    this.trail = null;
    this.shockwaves = [];
    this.nearMissCooldowns = new Map();

    // Activatable powers (keys 1-5): id -> cooldown seconds remaining.
    this.powerCooldowns = {};

    // Ghost recording
    this.recording = [];
    this.recordTimer = 0;

    this.carveIntensity = 0;
    this.currentSurfaceAudio = 'packed';
  }

  buildMesh() {
    if (this.mesh) this.disposeMesh();
    const prog = this.game.config.progression;
    const profile = this.game.save.profile;
    const char = prog.characters.find((c) => c.id === profile.selectedCharacter) || prog.characters[0];
    const board = prog.boards.find((b) => b.id === profile.selectedBoard) || prog.boards[0];
    const { group, refs } = buildRider({
      suit: char.suit, accent: char.accent, board: board.color, glow: board.glow
    });
    this.mesh = group;
    this.refs = refs;
    this.game.scene.add(this.mesh);
    this.spray = new SprayEmitter(this.game.scene, '#eef4ff');

    // Shield bubble shown while the Ice Shield power-up is active.
    this.shieldMesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.5, 18, 12),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color('#5cd7ff'), transparent: true, opacity: 0.16,
        depthWrite: false, side: THREE.DoubleSide
      })
    );
    this.shieldMesh.position.y = 0.9;
    this.shieldMesh.visible = false;
    this.mesh.add(this.shieldMesh);

    // Wingsuit membrane, shown only while gliding.
    const wingGeo = new THREE.PlaneGeometry(2.3, 0.9, 4, 1);
    const wpos = wingGeo.attributes.position;
    for (let i = 0; i < wpos.count; i++) {
      // Sweep the wing tips back for a delta silhouette.
      const wx = wpos.getX(i);
      wpos.setZ(i, -Math.abs(wx) * 0.4);
    }
    wingGeo.computeVertexNormals();
    this.wingMesh = new THREE.Mesh(wingGeo, new THREE.MeshStandardMaterial({
      color: new THREE.Color('#ff9d3c'),
      emissive: new THREE.Color('#ff9d3c'),
      emissiveIntensity: 0.6,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.92
    }));
    this.wingMesh.rotation.x = -Math.PI / 2 + 0.25;
    this.wingMesh.position.set(0, 1.05, -0.15);
    this.wingMesh.visible = false;
    this.refs.flip.add(this.wingMesh);

    // Carving trail ribbon left in the snow behind the board.
    this.trail = new BoardTrail(this.game.scene, '#eafaff');
  }

  disposeMesh() {
    if (!this.mesh) return;
    this.game.scene.remove(this.mesh);
    this.mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    if (this.spray) this.spray.dispose(this.game.scene);
    if (this.trail) this.trail.dispose(this.game.scene);
    for (const sw of this.shockwaves) {
      this.game.scene.remove(sw.mesh);
      sw.mesh.geometry.dispose();
      sw.mesh.material.dispose();
    }
    this.shockwaves = [];
    this.mesh = null;
    this.spray = null;
    this.trail = null;
    this.wingMesh = null;
  }

  /** Expanding snow ring on solid landings. */
  spawnShockwave(pos, strength) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 1.0, 24),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0.55,
        side: THREE.DoubleSide, depthWrite: false
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(pos.x, pos.y + 0.1, pos.z);
    this.game.scene.add(mesh);
    this.shockwaves.push({ mesh, life: 0.5, strength });
  }

  spawn(x, z, heading = 0) {
    const b = this.body;
    const h = this.game.world.sampleHeight(x, z);
    b.pos.set(x, h + b.boardOffset, z);
    b.vel.set(0, 0, 0);
    b.heading = heading;
    b.grounded = true;
    b.airTime = 0;
    this.crashTimer = 0;
    this.spinAccum = 0;
    this.flipAccum = 0;
    this.flipVisual = 0;
    this.grabTime = 0;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.jumpCharge = 0;
    this.recording = [];
    this.recordTimer = 0;
    this.lastSafe = { x, z, heading };
    this.effects.magnet = 0;
    this.effects.shield = 0;
    this.effects.nitro = 0;
    this.effects.multiplier = 0;
    this.effects.wingsuit = 0;
    this.powerCooldowns = {};
    this.nearMissCooldowns.clear();
    if (this.mesh) {
      this.mesh.position.copy(b.pos);
      this.mesh.rotation.set(0, heading, 0);
    }
  }

  respawn() {
    const s = this.lastSafe;
    this.spawn(s.x, s.z, s.heading);
    this.game.bus.emit('respawn', {});
  }

  get speed() { return this.body.vel.length(); }
  get speedKmh() { return this.speed * 3.6; }

  /* ---------------- fixed-step simulation ---------------- */

  fixedUpdate(dt) {
    const game = this.game;
    const input = game.input;
    const cfg = game.config.physics.rider;
    const b = this.body;

    if (this.crashTimer > 0) {
      this.crashTimer -= dt;
      // Tumble along the ground, bleeding speed.
      b.vel.multiplyScalar(Math.max(0, 1 - 2.2 * dt));
      game.physics.integrateRider(b, {
        steer: 0, tuck: false, brake: true, boost: false, jumpImpulse: 0, airControl: 0
      }, dt);
      if (this.crashTimer <= 0) this.game.bus.emit('recovered', {});
      return;
    }

    const invert = game.save.profile.settings.invertFlip ? -1 : 1;
    const steer = input.axis('steer');
    const pitchAxis = input.axis('pitch') * invert;

    // --- jump charge / release ---
    let jumpImpulse = 0;
    if (b.grounded) {
      if (input.isDown('jump')) {
        this.chargingJump = true;
        this.jumpCharge = Math.min(1, this.jumpCharge + dt / cfg.jumpChargeTime);
      } else if (this.chargingJump) {
        jumpImpulse = cfg.jumpBase + this.jumpCharge * cfg.jumpCharged;
        this.chargingJump = false;
        this.jumpCharge = 0;
        game.bus.emit('jump', { charge: this.jumpCharge });
        game.save.recordStat('jumps', 1);
      }
    } else {
      this.chargingJump = false;
      this.jumpCharge = 0;
    }

    // --- power-up timers & power cooldowns ---
    for (const k of Object.keys(this.effects)) {
      if (this.effects[k] > 0) this.effects[k] = Math.max(0, this.effects[k] - dt);
    }
    for (const k of Object.keys(this.powerCooldowns)) {
      if (this.powerCooldowns[k] > 0) {
        this.powerCooldowns[k] = Math.max(0, this.powerCooldowns[k] - dt);
      }
    }

    // --- boost (nitro power-up boosts for free) ---
    const boostCfg = game.config.gameplay.boost;
    const session = game.session;
    this.boosting = false;
    if (this.effects.nitro > 0 && b.grounded) {
      this.boosting = true;
    } else if (input.isDown('boost') && session && session.boost > 1 && b.grounded) {
      this.boosting = true;
      const drainScale = game.difficulty ? game.difficulty.boostDrainScale : 1;
      session.boost = Math.max(0, session.boost - boostCfg.drainPerSecond * drainScale * dt);
    }

    const wasGrounded = b.grounded;

    const gliding = this.effects.wingsuit > 0 && !b.grounded;

    const events = game.physics.integrateRider(b, {
      steer: b.grounded ? steer : 0,
      tuck: input.isDown('tuck'),
      brake: input.isDown('brake'),
      boost: this.boosting,
      jumpImpulse,
      wingsuit: gliding,
      airControl: b.grounded ? 0 : steer * (gliding ? 1 : 0.4)
    }, dt);

    // --- airborne trick accumulation ---
    if (!b.grounded) {
      if (wasGrounded) {
        // Just left the ground.
        this.spinAccum = 0;
        this.flipAccum = 0;
        this.flipVisual = 0;
        this.grabTime = 0;
        this.grabName = null;
        this.airStartY = b.pos.y;
      }
      if (gliding) {
        // Wingsuit: steering banks the glide instead of spinning tricks,
        // and any pending flip levels back out.
        b.heading = wrapAngle(b.heading + steer * 1.9 * dt);
        this.flipAccum *= Math.max(0, 1 - dt * 3);
        this.flipVisual = this.flipAccum;
      } else {
        const spinRate = steer * cfg.airYawRate;
        b.heading = wrapAngle(b.heading + spinRate * dt);
        this.spinAccum += spinRate * dt;
        const flipRate = pitchAxis * cfg.airPitchRate;
        this.flipAccum += flipRate * dt;
        this.flipVisual = this.flipAccum;
      }

      if (input.isDown('grab') && !gliding) {
        if (!this.grabName) {
          const grabs = game.config.tricks.names.grabs;
          this.grabName = grabs[Math.floor(Math.random() * grabs.length)];
        }
        this.grabTime += dt;
      }
    }

    // --- landing ---
    if (events.landed) {
      this.effects.wingsuit = 0; // touching down folds the wingsuit
      this.handleLanding(events);
      if (events.impact > 6) this.spawnShockwave(b.pos, events.impact);
    }

    // --- solid obstacle impact ---
    if (events.hitSolid && events.impactSpeed > cfg.crashImpactSpeed) {
      this.crash('obstacle');
    } else if (events.hitSolid && events.impactSpeed > 3) {
      game.bus.emit('bump', { speed: events.impactSpeed });
    }

    // --- triggers ---
    for (const ob of events.triggers) this.handleTrigger(ob, dt);

    // --- crystal magnet: hoover nearby crystals ---
    if (this.effects.magnet > 0) {
      const near = game.world.obstaclesNear(b.pos.x, b.pos.z, 12);
      for (const ob of near) {
        if (ob.type === 'crystal' && !ob.consumed) this.handleTrigger(ob, dt);
      }
    }

    // --- cinematic near-miss detection (solid obstacles skimmed at speed) ---
    const speedNow = this.speed;
    if (b.grounded && speedNow > 17 && this.crashTimer <= 0) {
      const near = game.world.obstaclesNear(b.pos.x, b.pos.z, 4.5);
      for (const ob of near) {
        if (ob.kind !== 'solid' || ob.consumed) continue;
        const gap = Math.hypot(b.pos.x - ob.x, b.pos.z - ob.z) - ob.radius * ob.scale - 0.55;
        if (gap > 0 && gap < 1.0) {
          const last = this.nearMissCooldowns.get(ob) || -10;
          if (game.elapsed - last > 4) {
            this.nearMissCooldowns.set(ob, game.elapsed);
            this.addScore(50, 'Near Miss');
            game.bus.emit('nearmiss', {});
          }
        }
      }
      // Close passes on rival riders.
      for (const rider of game.ai.riders) {
        const d = b.pos.distanceTo(rider.body.pos);
        if (d < 2.6) {
          const last = this.nearMissCooldowns.get(rider) || -10;
          if (game.elapsed - last > 5) {
            this.nearMissCooldowns.set(rider, game.elapsed);
            this.addScore(75, 'Close Pass');
            game.bus.emit('closepass', { name: rider.name });
          }
        }
      }
    }

    // --- combo timer ---
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0 && this.comboCount > 0) {
        game.bus.emit('combo-end', { count: this.comboCount, score: this.comboScore });
        this.comboCount = 0;
        this.comboScore = 0;
      }
    }

    // --- safe point ---
    this.safeTimer -= dt;
    if (b.grounded && this.safeTimer <= 0 && this.speed > 2) {
      this.lastSafe = { x: b.pos.x, z: b.pos.z, heading: b.heading };
      this.safeTimer = game.config.gameplay.session.safePointInterval;
    }

    // --- void / fall respawn ---
    if (b.pos.y < game.world.voidY(b.pos.z)) {
      game.bus.emit('fell', {});
      this.respawn();
    }

    // --- session stats ---
    if (session) {
      const sp = this.speed;
      session.distance += Math.sqrt(b.vel.x * b.vel.x + b.vel.z * b.vel.z) * dt;
      if (sp * 3.6 > session.topSpeed) session.topSpeed = sp * 3.6;
      if (!b.grounded) session.airTime += dt;
    }

    // --- carve intensity for audio/VFX ---
    this.carveIntensity = b.grounded
      ? Math.min(1, Math.abs(steer) * this.speed / 18)
      : 0;
    this.currentSurfaceAudio = game.physics.surfaceParams(b.surface).audio;

    // --- ghost recording ---
    if (session && session.recordGhost) {
      this.recordTimer -= dt;
      if (this.recordTimer <= 0) {
        this.recordTimer = 0.1;
        this.recording.push(session.time, b.pos.x, b.pos.y, b.pos.z, b.heading);
      }
    }
  }

  handleLanding(events) {
    const game = this.game;
    const tricksCfg = game.config.tricks.scoring;
    const names = game.config.tricks.names;
    const b = this.body;

    const flipDeg = (this.flipAccum * 180) / Math.PI;
    const spinDeg = Math.abs((this.spinAccum * 180) / Math.PI);
    const quality = game.physics.landingQuality(flipDeg, events.impact, b.groundNormal);

    game.bus.emit('landing', { quality, impact: events.impact, airTime: b.airTime });

    if (quality === 'crash') {
      this.crash('landing');
      return;
    }

    // Speed retention by landing quality.
    const keep = quality === 'perfect'
      ? game.config.physics.rider.softLandingSpeedKeep
      : quality === 'sketchy'
        ? game.config.physics.rider.hardLandingSpeedKeep
        : 0.88;
    b.vel.x *= keep; b.vel.z *= keep;

    if (b.airTime < tricksCfg.minAirTimeForTrick) return;

    // --- build the trick ---
    const parts = [];
    let points = 0;

    const fullFlips = Math.floor((Math.abs(flipDeg) + 60) / 360);
    if (fullFlips > 0) {
      const dir = flipDeg > 0 ? 'flipForward' : 'flipBackward';
      const name = names[dir][Math.min(fullFlips - 1, names[dir].length - 1)];
      parts.push(name);
      points += tricksCfg.flipPer180 * fullFlips * 2;
      game.save.recordStat('flipsLanded', fullFlips);
    }

    const spinSteps = Math.floor((spinDeg + 25) / 180);
    if (spinSteps >= 1) {
      const deg = spinSteps * 180;
      parts.push(names.spins[String(Math.min(deg, 1440))] || `${deg}`);
      points += tricksCfg.spinPer180 * spinSteps;
      if (spinSteps >= 2) game.save.recordStat('spinsLanded', 1);
    }

    if (this.grabTime > 0.15 && this.grabName) {
      parts.push(this.grabName);
      points += Math.round(this.grabTime * tricksCfg.grabPerSecond);
    }

    if (fullFlips > 0 && spinSteps >= 2) parts.unshift(names.combined.flipSpin);
    if (b.airTime > 2.4) {
      parts.push(names.combined.bigAir);
      points += Math.round(b.airTime * tricksCfg.airTimePerSecond);
    }

    if (!parts.length) {
      // A clean plain jump still scores a little air time.
      if (b.airTime > 0.8) points += Math.round(b.airTime * tricksCfg.airTimePerSecond * 0.5);
      if (points === 0) return;
      parts.push('Air');
    }

    const qualityMult = quality === 'perfect'
      ? tricksCfg.perfectLandingMultiplier
      : quality === 'sketchy'
        ? tricksCfg.sketchyLandingMultiplier
        : tricksCfg.goodLandingMultiplier;

    // --- combo ---
    this.comboCount++;
    this.comboTimer = tricksCfg.comboTimeout;
    const comboMult = Math.min(
      tricksCfg.comboMaxMultiplier, 1 + (this.comboCount - 1) * tricksCfg.comboStepMultiplier
    );

    const total = Math.round(points * qualityMult * comboMult);
    this.comboScore += total;

    this.addScore(total, parts.join(' + '));
    game.save.recordStat('tricksLanded', 1);
    game.save.recordStat('bestCombo', this.comboScore, 'max');
    game.save.recordStat('bestAirTime', b.airTime, 'max');

    const boostCfg = game.config.gameplay.boost;
    this.addBoost(total * boostCfg.fromTrickPerPoint);
    if (quality === 'perfect') {
      this.addBoost(boostCfg.fromPerfectLanding);
      game.save.recordStat('perfectLandings', 1);
      game.bus.emit('perfect', {});
    }

    game.bus.emit('trick', {
      name: parts.join(' + '),
      points: total,
      combo: this.comboCount,
      multiplier: comboMult,
      quality
    });

    this.flipAccum = 0;
    this.flipVisual = 0;
    this.spinAccum = 0;
    this.grabTime = 0;
    this.grabName = null;
  }

  handleTrigger(ob, dt) {
    const game = this.game;
    const boostCfg = game.config.gameplay.boost;
    const b = this.body;
    switch (ob.def.effect) {
      case 'collect':
        game.world.consumeObstacle(ob);
        this.addScore(ob.def.points, 'Crystal');
        this.addBoost(boostCfg.fromCrystal);
        if (game.session) game.session.crystals++;
        game.save.recordStat('crystals', 1);
        game.bus.emit('collect', { total: game.session ? game.session.crystals : 0 });
        break;
      case 'boostRing':
        game.world.consumeObstacle(ob);
        this.addScore(ob.def.points, 'Boost Ring');
        this.addBoost(boostCfg.fromRing);
        game.bus.emit('ring', {});
        break;
      case 'ramp': {
        const last = this.rampCooldowns.get(ob) || -10;
        const now = game.elapsed;
        if (b.grounded && now - last > 1.5 && this.speed > 6) {
          this.rampCooldowns.set(ob, now);
          b.vel.y += this.speed * ob.def.kick;
          b.grounded = false;
          b.airTime = 0;
          this.spinAccum = 0; this.flipAccum = 0; this.grabTime = 0;
          game.bus.emit('ramp', { speed: this.speed });
        }
        break;
      }
      case 'bounce': {
        const last = this.rampCooldowns.get(ob) || -10;
        if (game.elapsed - last > 1.0) {
          this.rampCooldowns.set(ob, game.elapsed);
          b.vel.y = Math.max(b.vel.y, ob.def.bounce);
          b.grounded = false;
          b.airTime = 0;
          this.spinAccum = 0; this.flipAccum = 0;
          this.addScore(ob.def.points, 'Bounce Pad');
          game.bus.emit('bounce', {});
        }
        break;
      }
      case 'arch':
        game.world.consumeObstacle(ob);
        this.addScore(ob.def.points, 'Ice Arch');
        this.addBoost(10);
        game.bus.emit('arch', {});
        break;
      case 'powerup': {
        game.world.consumeObstacle(ob);
        const power = ob.def.power;
        if (power === 'time') {
          if (game.mode && game.mode.timeLimit > 0 && game.session) {
            game.session.timeLeft += ob.def.amount;
          } else {
            this.addScore(500, 'Time Bonus');
          }
        } else if (power === 'nitro') {
          this.effects.nitro = ob.def.duration;
          if (game.session) game.session.boost = boostCfg.max;
        } else {
          this.effects[power] = ob.def.duration;
        }
        this.addScore(ob.def.points, ob.def.name);
        game.bus.emit('powerup', { power, name: ob.def.name, duration: ob.def.duration || 0 });
        break;
      }
    }
  }

  /**
   * Activate a keyed power (1-5). Powers are always available on cooldown —
   * they are the rider's "special features", independent of world pickups.
   */
  activatePower(slot) {
    const game = this.game;
    const def = (game.config.gameplay.powers || []).find((p) => p.slot === slot);
    if (!def || this.crashTimer > 0 || !game.session) return;
    if ((this.powerCooldowns[def.id] || 0) > 0) {
      game.bus.emit('power-denied', def);
      return;
    }
    const b = this.body;
    if (def.airOnly && b.grounded) {
      game.bus.emit('power-denied', { ...def, reason: 'air' });
      return;
    }
    switch (def.id) {
      case 'nitro':
        this.effects.nitro = def.duration;
        break;
      case 'leap':
        // Works on the ground AND mid-air (double jump).
        b.vel.y = Math.max(b.vel.y, 0) + 10.5;
        if (b.grounded) {
          b.grounded = false;
          b.airTime = 0;
          this.spinAccum = 0; this.flipAccum = 0; this.grabTime = 0;
        }
        game.save.recordStat('jumps', 1);
        break;
      case 'shield':
        this.effects.shield = def.duration;
        break;
      case 'slowmo':
        game.setTimeScale(0.45, def.duration);
        break;
      case 'magnet':
        this.effects.magnet = def.duration;
        break;
      case 'wingsuit':
        this.effects.wingsuit = def.duration;
        // Deploying gives a small upward pop as the suit catches air.
        b.vel.y = Math.max(b.vel.y, 2.5);
        break;
      default:
        return;
    }
    const cdScale = game.difficulty ? game.difficulty.powerCooldownScale : 1;
    this.powerCooldowns[def.id] = def.cooldown * cdScale;
    game.bus.emit('power-used', def);
  }

  addScore(points, label) {
    const game = this.game;
    if (!game.session || !game.mode || !game.mode.scoring) return;
    if (this.effects.multiplier > 0) points *= 2;
    game.session.trickScore += points;
    game.bus.emit('score', { points, label, total: game.session.trickScore });
  }

  addBoost(amount) {
    const game = this.game;
    if (!game.session) return;
    game.session.boost = Math.min(game.config.gameplay.boost.max, game.session.boost + amount);
  }

  crash(reason) {
    const game = this.game;
    if (this.crashTimer > 0) return;
    // The Ice Shield eats one crash (avalanche excepted — nothing stops that).
    if (this.effects.shield > 0 && reason !== 'avalanche') {
      this.effects.shield = 0;
      this.body.vel.multiplyScalar(0.8);
      game.bus.emit('shield-save', {});
      return;
    }
    this.crashTimer = game.config.physics.rider.crashRecoveryTime;
    this.body.vel.multiplyScalar(0.35);
    this.tumbleSpin.set(
      (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 7, (Math.random() - 0.5) * 9
    );
    if (this.comboCount > 0) {
      game.bus.emit('combo-end', { count: this.comboCount, score: 0, dropped: true });
    }
    this.comboCount = 0;
    this.comboScore = 0;
    this.flipAccum = 0;
    this.flipVisual = 0;
    this.spinAccum = 0;
    game.save.recordStat('crashes', 1);
    game.bus.emit('crash', { reason });
  }

  /* ---------------- per-frame visuals ---------------- */

  update(dt) {
    if (!this.mesh) return;
    const b = this.body;
    const refs = this.refs;
    const input = this.game.input;

    this.mesh.position.copy(b.pos);

    if (this.crashTimer > 0) {
      // Ragdoll-ish tumble.
      refs.flip.rotation.x += this.tumbleSpin.x * dt;
      refs.flip.rotation.z += this.tumbleSpin.z * dt;
      this.tumbleSpin.multiplyScalar(Math.max(0, 1 - 2.5 * dt));
      refs.armL.rotation.z = 1.8;
      refs.armR.rotation.z = -1.8;
      return;
    }

    if (b.grounded) {
      // Smoothly align to slope + heading yaw.
      _q.setFromUnitVectors(_up, b.groundNormal);
      _q.multiply(_q2.setFromAxisAngle(_up, b.heading));
      this.mesh.quaternion.slerp(_q, Math.min(1, dt * 14));
      const steer = input.axis('steer');
      const leanTarget = -steer * Math.min(1, this.speed / 16) * 0.5;
      refs.tilt.rotation.z += (leanTarget - refs.tilt.rotation.z) * Math.min(1, dt * 10);
      refs.flip.rotation.x += (0 - refs.flip.rotation.x) * Math.min(1, dt * 12);
      refs.flip.rotation.z *= Math.max(0, 1 - dt * 10);

      // Crouch: jump charge + tuck.
      const crouch = this.jumpCharge * 0.28 + (input.isDown('tuck') ? 0.15 : 0);
      refs.body.position.y += ((0.06 - crouch) - refs.body.position.y) * Math.min(1, dt * 12);
      refs.body.rotation.x += ((crouch * 0.8) - refs.body.rotation.x) * Math.min(1, dt * 12);

      // Arms follow the carve.
      refs.armL.rotation.z += ((0.5 + steer * 0.6) - refs.armL.rotation.z) * Math.min(1, dt * 8);
      refs.armR.rotation.z += ((-0.5 + steer * 0.6) - refs.armR.rotation.z) * Math.min(1, dt * 8);

      // Snow spray while carving (denser on snow than ice).
      const icy = Math.min(1, Math.max(0, b.surface));
      if (this.carveIntensity > 0.25 && this.spray) {
        const rate = this.carveIntensity * (1.2 - icy) * 60 * dt;
        if (Math.random() < rate) {
          this.spray.spawn(b.pos, b.vel, Math.ceil(this.carveIntensity * 4), 2.2);
        }
      }
    } else {
      // Airborne: flips + grab pose (or wingsuit glide pose).
      const gliding = this.effects.wingsuit > 0;
      _q.setFromAxisAngle(_up, b.heading);
      this.mesh.quaternion.slerp(_q, Math.min(1, dt * 18));
      refs.flip.rotation.x = gliding ? 0.5 : this.flipVisual;
      const bank = gliding ? -input.axis('steer') * 0.7 : refs.tilt.rotation.z * Math.max(0, 1 - dt * 4);
      refs.tilt.rotation.z += (bank - refs.tilt.rotation.z) * Math.min(1, dt * 8);
      const grabbing = input.isDown('grab') && !gliding;
      const armLT = gliding ? 1.55 : grabbing ? 2.4 : 0.9;
      const armRT = gliding ? -1.55 : grabbing ? -0.2 : -0.9;
      refs.armL.rotation.z += (armLT - refs.armL.rotation.z) * Math.min(1, dt * 10);
      refs.armR.rotation.z += (armRT - refs.armR.rotation.z) * Math.min(1, dt * 10);
      refs.body.position.y += ((grabbing ? -0.12 : 0.06) - refs.body.position.y) * Math.min(1, dt * 10);
    }
    if (this.wingMesh) this.wingMesh.visible = this.effects.wingsuit > 0 && !b.grounded;

    // Shield bubble pulse.
    if (this.shieldMesh) {
      const active = this.effects.shield > 0;
      this.shieldMesh.visible = active;
      if (active) {
        const t = this.game.elapsed;
        this.shieldMesh.material.opacity = 0.12 + Math.sin(t * 5) * 0.05
          + (this.effects.shield < 3 ? Math.sin(t * 18) * 0.08 : 0);
        this.shieldMesh.scale.setScalar(1 + Math.sin(t * 3) * 0.05);
      }
    }

    if (this.spray) this.spray.update(dt);
    if (this.trail) this.trail.update(dt, b, b.grounded && this.crashTimer <= 0, this.speed);

    // Landing shockwaves expand and fade.
    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const sw = this.shockwaves[i];
      sw.life -= dt;
      const t = 1 - sw.life / 0.5;
      sw.mesh.scale.setScalar(1 + t * (2 + sw.strength * 0.25));
      sw.mesh.material.opacity = 0.55 * (1 - t);
      if (sw.life <= 0) {
        this.game.scene.remove(sw.mesh);
        sw.mesh.geometry.dispose();
        sw.mesh.material.dispose();
        this.shockwaves.splice(i, 1);
      }
    }
  }
}

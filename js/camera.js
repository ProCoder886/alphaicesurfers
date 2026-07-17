/**
 * camera.js — CameraManager: follow, first-person, drone orbit, photo
 * (free-fly), menu flyover and replay cameras, with speed-reactive FOV,
 * impact shake and terrain collision avoidance.
 */

import * as THREE from 'three';
import { damp } from '../libs/tween.js';

const _target = new THREE.Vector3();
const _ideal = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fwd = new THREE.Vector3();

const MODES = ['follow', 'first', 'drone'];

export class CameraManager {
  constructor(game) {
    this.game = game;
    this.camera = game.camera;
    this.mode = 'menu';
    this.userMode = game.save.profile.settings.cameraMode || 'follow';
    if (!MODES.includes(this.userMode)) this.userMode = 'follow';

    this.shake = 0;
    this.dronePhase = 0;
    this.menuPhase = 0;
    this.smoothPos = new THREE.Vector3(0, 30, -40);
    this.smoothLook = new THREE.Vector3();
    this.currentFov = game.config.gameplay.camera.baseFov;

    // Photo mode free-fly state
    this.photoYaw = 0;
    this.photoPitch = -0.2;
    this.photoPos = new THREE.Vector3();
    this.dragging = false;

    game.bus.on('landing', (e) => { this.shake = Math.min(1, this.shake + e.impact * 0.03); });
    game.bus.on('crash', () => { this.shake = Math.min(1.4, this.shake + 0.8); });
    game.bus.on('bump', () => { this.shake = Math.min(1, this.shake + 0.25); });

    this.bindPhotoControls();
  }

  bindPhotoControls() {
    const canvas = this.game.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'photo') return;
      this.dragging = true;
      this.lastX = e.clientX; this.lastY = e.clientY;
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging || this.mode !== 'photo') return;
      this.photoYaw -= (e.clientX - this.lastX) * 0.004;
      this.photoPitch = THREE.MathUtils.clamp(
        this.photoPitch - (e.clientY - this.lastY) * 0.004, -1.4, 1.4
      );
      this.lastX = e.clientX; this.lastY = e.clientY;
    });
    window.addEventListener('pointerup', () => { this.dragging = false; });
  }

  cycleMode() {
    const i = MODES.indexOf(this.userMode);
    this.userMode = MODES[(i + 1) % MODES.length];
    this.game.save.profile.settings.cameraMode = this.userMode;
    this.game.save.persist();
    this.game.bus.emit('camera-mode', { mode: this.userMode });
  }

  enterPhotoMode() {
    this.mode = 'photo';
    const p = this.game.player.body.pos;
    this.photoPos.copy(p).add(new THREE.Vector3(-4, 2.5, -5));
    _look.copy(p).sub(this.photoPos);
    this.photoYaw = Math.atan2(_look.x, _look.z);
    this.photoPitch = -0.15;
  }

  exitPhotoMode() {
    this.mode = this.userMode;
  }

  update(dt) {
    const game = this.game;
    const cfg = game.config.gameplay.camera;

    switch (game.state) {
      case 'menu':
        this.updateMenu(dt);
        break;
      case 'photo':
        this.updatePhoto(dt);
        break;
      case 'playing':
      case 'paused':
      case 'results':
        if (this.mode === 'photo') this.mode = this.userMode;
        else this.mode = this.userMode;
        this.updatePlay(dt, cfg);
        break;
    }

    // Shake decay + application.
    if (this.shake > 0.002) {
      const s = this.shake * 0.12;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s * 0.6;
      this.camera.rotation.z += (Math.random() - 0.5) * s * 0.02;
      this.shake = damp(this.shake, 0, 6, dt);
    }
  }

  updateMenu(dt) {
    // Slow cinematic drift down the mountain behind the menu.
    this.menuPhase += dt;
    const world = this.game.world;
    if (!world.map) return;
    const z = 40 + this.menuPhase * 3.5;
    const x = Math.sin(this.menuPhase * 0.08) * 60;
    const groundY = world.sampleHeightIfLoaded(x, z);
    const y = (groundY === null ? -z * world.map.terrain.slope : groundY) + 26;
    this.smoothPos.set(x, y, z - 55);
    this.camera.position.lerp(this.smoothPos, Math.min(1, dt * 0.7));
    const aheadY = world.sampleHeightIfLoaded(0, z + 80);
    _look.set(0, (aheadY === null ? y - 40 : aheadY + 8), z + 80);
    this.smoothLook.lerp(_look, Math.min(1, dt * 1.2));
    this.camera.lookAt(this.smoothLook);
    this.setFov(62, dt);
  }

  updatePhoto(dt) {
    const input = this.game.input;
    const speed = (input.isDown('boost') ? 26 : 10) * dt;
    _fwd.set(
      Math.sin(this.photoYaw) * Math.cos(this.photoPitch),
      Math.sin(this.photoPitch),
      Math.cos(this.photoYaw) * Math.cos(this.photoPitch)
    );
    const right = _look.set(_fwd.z, 0, -_fwd.x).normalize();
    if (input.isDown('tuck')) this.photoPos.addScaledVector(_fwd, speed);
    if (input.isDown('brake')) this.photoPos.addScaledVector(_fwd, -speed);
    if (input.isDown('steerLeft')) this.photoPos.addScaledVector(right, speed);
    if (input.isDown('steerRight')) this.photoPos.addScaledVector(right, -speed);
    if (input.isDown('jump')) this.photoPos.y += speed;
    if (input.isDown('grab')) this.photoPos.y -= speed;
    this.camera.position.copy(this.photoPos);
    _target.copy(this.photoPos).add(_fwd);
    this.camera.lookAt(_target);
    this.setFov(55, dt);
  }

  updatePlay(dt, cfg) {
    const player = this.game.player;
    if (!player || !player.mesh) return;
    const b = player.body;
    const speed = b.vel.length();
    _fwd.set(Math.sin(b.heading), 0, Math.cos(b.heading));

    if (this.mode === 'first') {
      _ideal.copy(b.pos).addScaledVector(_fwd, 0.25);
      _ideal.y += 1.45;
      this.camera.position.lerp(_ideal, Math.min(1, dt * 30));
      _look.copy(this.camera.position).addScaledVector(_fwd, 10);
      _look.y -= 0.6;
      this.camera.lookAt(_look);
      // Lean the horizon with carving.
      this.camera.rotation.z += -this.game.input.axis('steer') * 0.08;
    } else if (this.mode === 'drone') {
      this.dronePhase += dt * 0.25;
      _ideal.set(
        b.pos.x + Math.cos(this.dronePhase) * 11,
        b.pos.y + 5,
        b.pos.z + Math.sin(this.dronePhase) * 11
      );
      this.clampAboveTerrain(_ideal, 1.2);
      this.camera.position.lerp(_ideal, Math.min(1, dt * 4));
      this.camera.lookAt(b.pos.x, b.pos.y + 1, b.pos.z);
    } else {
      // Third-person follow.
      _ideal.copy(b.pos)
        .addScaledVector(_fwd, -cfg.followDistance)
        .add(_target.set(0, cfg.followHeight, 0));
      this.clampAboveTerrain(_ideal, 0.8);
      const lerp = Math.min(1, dt * cfg.positionLerp);
      this.smoothPos.lerp(_ideal, lerp);
      this.camera.position.copy(this.smoothPos);

      _look.copy(b.pos).addScaledVector(_fwd, cfg.lookAhead);
      _look.y += 1.2;
      // Look slightly into the velocity direction for drift readability.
      _look.addScaledVector(b.vel, 0.06);
      this.smoothLook.lerp(_look, Math.min(1, dt * 8));
      this.camera.lookAt(this.smoothLook);
    }

    // Speed & boost reactive FOV.
    const speedT = Math.min(1, speed / this.game.config.physics.rider.maxSpeed);
    let fov = cfg.baseFov + speedT * speedT * cfg.speedFovGain;
    if (player.boosting) fov += cfg.boostFovKick;
    this.setFov(fov, dt);

    // High-speed rumble.
    if (speed > cfg.shakeSpeedThreshold && b.grounded) {
      this.shake = Math.max(this.shake, (speed - cfg.shakeSpeedThreshold) * 0.006);
    }
  }

  clampAboveTerrain(pos, margin) {
    const h = this.game.world.sampleHeightIfLoaded(pos.x, pos.z);
    if (h !== null && pos.y < h + margin) pos.y = h + margin;
  }

  setFov(target, dt) {
    this.currentFov = damp(this.currentFov, target, 5, dt);
    if (Math.abs(this.camera.fov - this.currentFov) > 0.01) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }
  }
}

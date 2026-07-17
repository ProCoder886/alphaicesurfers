/**
 * weather.js — Dynamic weather, day/night cycle and atmosphere.
 *
 * Blends between data-driven weather states (config/weather.json):
 * fog density/color, sun & ambient intensity, GPU snowfall, cloud cover,
 * aurora curtains and a wind vector that feeds back into rider physics
 * and audio. Time of day continuously animates the sun, sky colors and
 * the starfield.
 */

import * as THREE from 'three';

const _sunDir = new THREE.Vector3();
const _colA = new THREE.Color();
const _colB = new THREE.Color();

export class WeatherSystem {
  constructor(game) {
    this.game = game;
    this.cfg = game.config.weather;
    this.states = new Map(this.cfg.states.map((s) => [s.id, s]));

    this.current = null;
    this.previous = null;
    this.blend = 1;           // 0 -> previous, 1 -> current
    this.dynamicTimer = 0;
    this.dynamic = false;

    this.timeOfDay = 0.3;     // 0..1, 0 = midnight
    this.timeMode = 'cycle';

    this.wind = new THREE.Vector2();
    this.windTarget = new THREE.Vector2();
    this.windStrength = 1;
    this.gustPhase = 0;

    this.group = null;
    this.snow = null;
    this.aurora = null;
    this.clouds = [];
  }

  /* ---------------- construction per map ---------------- */

  setupForMap(map, mode) {
    this.teardown();
    const pal = map.palette;
    this.map = map;
    this.group = new THREE.Group();
    this.group.name = 'weather';
    this.game.scene.add(this.group);

    this.buildSnow();
    this.buildAurora(pal);
    this.buildClouds(pal);

    this.timeMode = map.timeOfDay;
    this.timeOfDay = map.startTime !== undefined ? map.startTime : 0.3;
    this.dynamic = !!(mode && mode.weatherDynamic);
    this.dynamicTimer = this.nextDynamicDelay();

    const startId = map.startWeather || map.weatherSet[0];
    this.setState(startId, true);
  }

  teardown() {
    if (!this.group) return;
    this.game.scene.remove(this.group);
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.group = null;
    this.snow = null;
    this.aurora = null;
    this.clouds = [];
  }

  buildSnow() {
    const sh = this.game.assets.shaders.snow;
    const count = this.game.quality.snowParticles;
    const geo = new THREE.BufferGeometry();
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) seeds[i] = Math.random();
    // Positions are computed in-shader; the attribute just needs to exist.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    this.snowUniforms = {
      uTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uWind: { value: new THREE.Vector2() },
      uRange: { value: 55 },
      uFallSpeed: { value: 6 },
      uSize: { value: 2.6 },
      uOpacity: { value: 0 }
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: sh.VERTEX,
      fragmentShader: sh.FRAGMENT,
      uniforms: this.snowUniforms,
      transparent: true,
      depthWrite: false
    });
    this.snow = new THREE.Points(geo, mat);
    this.snow.frustumCulled = false;
    this.snow.renderOrder = 5;
    this.group.add(this.snow);
  }

  buildAurora(pal) {
    const sh = this.game.assets.shaders.aurora;
    // A huge curved band high in the sky.
    const geo = new THREE.CylinderGeometry(700, 700, 260, 48, 1, true, 0, Math.PI * 1.4);
    this.auroraUniforms = {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uColorA: { value: new THREE.Color('#37ff9c') },
      uColorB: { value: new THREE.Color(pal.neon || '#c86bff') }
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: sh.VERTEX,
      fragmentShader: sh.FRAGMENT,
      uniforms: this.auroraUniforms,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.aurora = new THREE.Mesh(geo, mat);
    this.aurora.position.y = 320;
    this.aurora.rotation.y = 0.6;
    this.aurora.frustumCulled = false;
    this.group.add(this.aurora);
  }

  buildClouds(pal) {
    const sh = this.game.assets.shaders.clouds;
    for (let i = 0; i < 6; i++) {
      const uniforms = {
        uTime: { value: 0 },
        uOpacity: { value: 0.4 },
        uColor: { value: new THREE.Color(pal.skyHorizon).lerp(new THREE.Color('#ffffff'), 0.6) },
        uSeed: { value: i * 13.7 }
      };
      const mat = new THREE.ShaderMaterial({
        vertexShader: sh.VERTEX,
        fragmentShader: sh.FRAGMENT,
        uniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(420, 160), mat);
      mesh.rotation.x = -Math.PI / 2 + 0.35;
      mesh.userData.angle = (i / 6) * Math.PI * 2;
      mesh.userData.radius = 380 + (i % 3) * 120;
      mesh.userData.height = 250 + (i % 2) * 70;
      mesh.userData.uniforms = uniforms;
      this.clouds.push(mesh);
      this.group.add(mesh);
    }
  }

  /* ---------------- state control ---------------- */

  setState(id, instant = false) {
    const state = this.states.get(id) || this.cfg.states[0];
    if (this.current && this.current.id === state.id) return;
    this.previous = this.current || state;
    this.current = state;
    this.blend = instant ? 1 : 0;
    this.windStrength = state.wind[0] + Math.random() * (state.wind[1] - state.wind[0]);
    this.game.bus.emit('weather', { id: state.id, name: state.name });
  }

  nextDynamicDelay() {
    const [lo, hi] = this.cfg.dynamicIntervalRange;
    return lo + Math.random() * (hi - lo);
  }

  pickNextState() {
    const set = this.map.weatherSet.filter((id) => this.states.has(id));
    const pool = [];
    for (const id of set) {
      if (this.current && id === this.current.id) continue;
      const w = this.states.get(id).weight || 1;
      for (let i = 0; i < w; i++) pool.push(id);
    }
    if (pool.length) this.setState(pool[Math.floor(Math.random() * pool.length)]);
  }

  /** Interpolated numeric property between previous and current states. */
  prop(name) {
    const a = this.previous ? (this.previous[name] ?? 0) : 0;
    const b = this.current ? (this.current[name] ?? 0) : 0;
    return a + (b - a) * this.blend;
  }

  /* ---------------- frame update ---------------- */

  update(dt) {
    if (!this.group || !this.map) return;
    const game = this.game;
    const world = game.world;
    if (!world.map) return;

    // Blend into the current state.
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / this.cfg.transitionSeconds);
    }

    // Dynamic weather changes.
    if (this.dynamic) {
      this.dynamicTimer -= dt;
      if (this.dynamicTimer <= 0) {
        this.dynamicTimer = this.nextDynamicDelay();
        this.pickNextState();
      }
    }

    // Time of day.
    if (this.timeMode === 'cycle') {
      this.timeOfDay = (this.timeOfDay + dt / this.cfg.dayLengthSeconds) % 1;
    }
    let tod = this.timeOfDay;
    if (this.current && this.current.forceNight) tod = 0.9;

    // Sun position: angle around the sky; elevation from time of day.
    const ang = (tod - 0.25) * Math.PI * 2;
    const elev = Math.sin(ang);
    _sunDir.set(Math.cos(ang) * 0.8, Math.max(-0.25, elev), 0.45).normalize();
    const dayFactor = THREE.MathUtils.clamp(elev * 2.4 + 0.35, 0.04, 1);
    const night = THREE.MathUtils.clamp(1 - (elev * 3 + 0.55), 0, 1);

    // --- sun & ambient ---
    const pal = this.map.palette;
    if (world.sun) {
      world.sun.intensity = 2.9 * this.prop('lightScale') * dayFactor;
      // Warm the sun near the horizon.
      _colA.set(pal.sunColor);
      _colB.set('#ff9d5c');
      const warm = THREE.MathUtils.clamp(1 - Math.abs(elev) * 2.6, 0, 1) * 0.6;
      world.sun.color.copy(_colA).lerp(_colB, warm);
      world.hemi.intensity = 0.9 * this.prop('ambientScale') * (0.35 + dayFactor * 0.65);
      const focus = game.player && game.state === 'playing'
        ? game.player.body.pos : game.camera.position;
      world.placeSun(_sunDir, focus);
    }

    // --- sky ---
    if (world.sky) {
      const u = world.sky.material.uniforms;
      u.uNight.value = night;
      _colA.set(pal.skyTop);
      _colB.set(pal.skyHorizon);
      // Dim sky colors through the fog/cloud amount.
      const gloom = 1 - this.prop('cloudOpacity') * 0.35;
      u.uTopColor.value.copy(_colA).multiplyScalar(gloom);
      u.uHorizonColor.value.copy(_colB).multiplyScalar(gloom);
    }

    // --- fog ---
    if (game.scene.fog) {
      game.scene.fog.density = this.prop('fogDensity');
      _colA.set(pal.fog);
      // Darken fog at night.
      game.scene.fog.color.copy(_colA).multiplyScalar(1 - night * 0.72);
    }

    // --- wind (gusty, slowly wandering direction) ---
    this.gustPhase += dt * this.game.config.physics.wind.gustFrequency * Math.PI * 2;
    const gust = 0.7 + 0.3 * Math.sin(this.gustPhase) * Math.sin(this.gustPhase * 0.37 + 1.3);
    const windAngle = Math.sin(game.elapsed * 0.03) * Math.PI;
    const targetStrength = this.windStrength * gust * (this.prop('windPhysics') > 0 ? 2.2 : 1);
    this.windTarget.set(Math.cos(windAngle), Math.sin(windAngle)).multiplyScalar(targetStrength);
    this.wind.lerp(this.windTarget, Math.min(1, dt * 0.8));
    game.physics.wind.copy(this.wind);

    // --- snowfall ---
    const snowRate = this.prop('snowRate');
    this.snowUniforms.uTime.value += dt;
    this.snowUniforms.uOpacity.value = snowRate * 0.9;
    this.snowUniforms.uWind.value.copy(this.wind).multiplyScalar(2.5);
    this.snowUniforms.uCamPos.value.copy(game.camera.position);
    this.snowUniforms.uFallSpeed.value = 5 + snowRate * 6;
    this.snow.visible = snowRate > 0.01;

    // --- aurora ---
    const wantsAurora = (this.current && this.current.aurora) ? 1 : 0;
    const auroraLevel = Math.max(wantsAurora * this.blend, night * 0.25 * wantsAurora);
    this.auroraUniforms.uTime.value += dt;
    this.auroraUniforms.uIntensity.value +=
      ((auroraLevel * 0.85) - this.auroraUniforms.uIntensity.value) * Math.min(1, dt * 0.5);
    this.aurora.visible = this.auroraUniforms.uIntensity.value > 0.01;
    this.aurora.position.x = game.camera.position.x;
    this.aurora.position.z = game.camera.position.z - 250;

    // --- clouds ---
    const cloudOp = this.prop('cloudOpacity');
    for (const c of this.clouds) {
      c.userData.angle += dt * 0.004;
      const a = c.userData.angle;
      c.position.set(
        game.camera.position.x + Math.cos(a) * c.userData.radius,
        c.userData.height,
        game.camera.position.z + Math.sin(a) * c.userData.radius
      );
      c.lookAt(game.camera.position.x, c.userData.height * 0.6, game.camera.position.z);
      c.userData.uniforms.uTime.value += dt;
      c.userData.uniforms.uOpacity.value = cloudOp * 0.55 * (1 - night * 0.6);
      c.visible = cloudOp > 0.03;
    }
  }

  /** Visibility factor 0..1 for AI (blizzard/fog reduce it). */
  visibility() {
    return THREE.MathUtils.clamp(1 - this.prop('fogDensity') * 60, 0.25, 1);
  }
}

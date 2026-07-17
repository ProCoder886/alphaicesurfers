# Architecture

Alpha Ice Surfers 3D is a modular, data-driven ES-module game with one system
per file and a central `Game` orchestrator. There is no bundler and no
framework: the browser's module graph *is* the architecture.

```
                 ┌────────────────────────────────────────────┐
                 │                 Game (game.js)             │
                 │  state machine · fixed-step loop · session │
                 └──┬─────┬─────┬─────┬─────┬─────┬─────┬────┘
                    │     │     │     │     │     │     │
      ┌─────────┐ ┌─┴──┐ ┌┴───┐ ┌┴───┐ ┌┴──────┐ ┌┴───┐ ┌┴────┐
      │EventBus │ │World│ │Phys│ │Play│ │Weather│ │ AI │ │ UI  │
      └─────────┘ └─┬──┘ └────┘ └────┘ └───────┘ └────┘ └─────┘
                    │
          ┌─────────┴──────────┐
          │ terrainWorker.js   │  (Web Worker + importable module)
          │ seeded generation  │
          └────────────────────┘
```

## Core principles

1. **Data-driven** — every tunable lives in `config/*.json`: physics surfaces,
   trick scoring, weather states, map palettes/terrain params, obstacle rules,
   progression curves. Systems read config; they do not hardcode balance.
2. **Single source of truth for terrain** — `workers/terrainWorker.js` exports
   `TerrainGenerator` and *also* runs as a module worker. The main thread
   imports the same class for synchronous fallback and spawn prewarming, so
   the physics heightfield and the rendered meshes are bit-identical.
3. **One physics for everyone** — `PhysicsEngine.integrateRider()` advances a
   plain body struct from an input struct. The player, every AI rider and
   (in the future) remote players run the exact same function.
4. **Events out, calls in** — gameplay systems emit facts on the `EventBus`
   (`trick`, `crash`, `checkpoint`, `weather`, `levelup`…). UI and audio are
   pure listeners; nothing in the simulation knows the DOM exists.
5. **Deterministic simulation** — fixed 120 Hz timestep, seeded terrain and
   seeded AI personalities. Ghost replays stay honest and multiplayer state
   sync is feasible later.

## The main loop

`Game.frame()` (via `renderer.setAnimationLoop`):

```
input.update            → smooth analog axes, poll gamepad
[state == playing]
  countdown OR fixed-step loop:
      player.fixedUpdate(1/120)   → input → PhysicsEngine → trick/trigger events
      ai.fixedUpdate(1/120)       → AI brains → same PhysicsEngine
  updateModeLogic       → checkpoints, timers, avalanche, standings
world.update            → chunk streaming, LOD swaps, gate/obstacle animation
weather.update          → sun/fog/snow/aurora/wind blending
player.update / ai.update → visual rigs (slope align, lean, flips, ragdoll)
cameras.update          → follow/first/drone/photo, FOV, shake
audio.update            → continuous synth layers (wind/carve/edge/music)
ui.update               → HUD, minimap, combo timers
renderer.render
```

Rendering is decoupled from simulation: at low frame rates the accumulator
clamps sub-steps (no spiral of death); at high refresh rates (120 Hz+) the
simulation stays identical.

## Terrain pipeline

- World space is divided into **140 m chunks** at 64×64 cells.
- `World.update` requests missing chunks in rings around the focus point from
  the worker; results arrive as transferable `Float32Array`s (heights, surface
  iciness, seamless normals from an apron grid, obstacle placements).
- Physics queries (`sampleHeight`/`sampleNormal`/`surfaceAt`) bilinearly sample
  the cached grids. If physics needs ground the worker hasn't delivered yet,
  the same generator runs synchronously — correctness is never racy.
- Meshes are built max 2 per frame (no frame spikes), full-res near the
  player and ¼-res beyond `detailRadius`, sharing static index buffers.
- Obstacles are per-chunk `InstancedMesh`es; collectibles are "consumed" by
  zeroing their instance matrix.
- The **racing corridor** (`corridorX(z)`) is a deterministic meander line:
  solid obstacles keep clear of it, triggers (rings/ramps/pads/crystals) hug
  it, checkpoints ride along it. Level design emerges from one function.

## Surfaces & feel

Iciness is a continuous 0..1 field (plus a frozen-lake sentinel). The physics
blends friction/grip across powder → packed → blue ice → black ice, the
terrain shader blends PBR roughness/metalness/tint per-vertex from the same
data, and the audio crossfades hiss → whine from it. One scalar drives feel,
look and sound — they can't disagree.

## Why a bespoke physics engine (not Rapier/Ammo)?

The design calls for a *carving feel*: velocity progressively rotating toward
board heading with surface-dependent grip, scrub losses, landing-quality
evaluation, trick rotation bookkeeping. That is a specialised character
controller, not rigid-body dynamics. A WASM engine would add ~2 MB, cross the
JS/WASM boundary every step, and still require all of this logic on top. The
bespoke integrator is ~300 lines, deterministic, and identical for AI and
player. The architecture keeps `PhysicsEngine` behind a narrow interface
(`integrateRider`, `surfaceParams`, `landingQuality`) so a Rapier-backed
implementation could be swapped in for rigid-body debris/ragdolls later.

## Workers

- `terrainWorker.js` — active. Generation is the only sustained CPU burst and
  parallelises perfectly.
- Physics and AI intentionally stay on the main thread: they must respond to
  input inside the same 8 ms step, the rider count is small (≤8), and a
  worker round-trip would add latency for zero gain at this scale. The
  documented seam for scaling AI out (`AIManager.fixedUpdate`) exists if
  rider counts ever grow by an order of magnitude.

## Persistence

- **localStorage** — profile: XP, unlocks, settings, statistics, achievements,
  best times/scores, daily streak (merged over defaults on load so saves
  survive schema growth).
- **IndexedDB** — ghost recordings (packed `Float32Array` of
  `[t, x, y, z, heading]` at 10 Hz).
- Export/import — the profile round-trips as a JSON file from Settings.

## Rendering & performance

- three.js r164, WebGL2, ACES tone mapping, sRGB output, PCF soft shadows
  following the rider, PMREM environment reflections from a per-map gradient.
- GPU-only snowfall (motion fully in the vertex shader), additive aurora
  curtains, fbm cloud billboards, view-dependent glitter sparkle injected
  into the terrain's standard material.
- Quality presets scale pixel ratio, shadow map size, particle counts and
  chunk radii; **auto mode** downgrades/upgrades from measured FPS.
- Budget on `medium`: ~100–150 draw calls, ~250 k triangles.

## Extending

| Want to add… | Touch |
| --- | --- |
| A new map | `config/maps.json` (palette + terrain params + densities) |
| A new mode | `config/gameplay.json` + a branch in `Game.updateModeLogic` |
| A new obstacle | `config/obstacles.json` + a template in `World.buildObstacleAssets` |
| A new trick | `config/tricks.json` + detection in `Player.handleLanding` |
| A new weather state | `config/weather.json` |
| Multiplayer | serialise the rider input struct + body state; the sim is already deterministic |

# Module API Reference

A quick reference to the public surface of each module. `game` refers to the
central `Game` instance (exposed as `window.AIS` for console debugging).

## game.js

### `Game`
| Member | Description |
| --- | --- |
| `state` | `'boot' \| 'menu' \| 'playing' \| 'paused' \| 'photo' \| 'results'` |
| `session` | Live session data: `time, score, trickScore, distance, topSpeed, boost, crystals, checkpointIndex, splits, avalancheZ, medal, xpEarned…` |
| `config` | All parsed configs: `gameplay, physics, weather, maps, obstacles, tricks, progression` |
| `startSession(mapId, modeId)` | Load a map + mode and begin (with countdown) |
| `restartSession()` / `returnToMenu()` | Session lifecycle |
| `pause()` / `resume()` / `togglePhotoMode()` | State transitions |
| `applyQuality('low'\|'medium'\|'high')` | Apply a quality preset |
| `captureScreenshot()` | Download the current frame as PNG |
| `unlockedMaps()` | Maps available at the current player level |

### `EventBus` — `on(event, fn) → off`, `off`, `emit(event, payload)`

Events: `action, score, trick, combo-end, landing, perfect, crash, recovered,
bump, jump, collect, ring, ramp, bounce, checkpoint, countdown, respawn, fell,
weather, xp, levelup, achievement, quality, camera-mode, ai-finished,
session-start, session-end, ui-click, ui-open`.

### `AssetManager` — `loadAll(onProgress)`, `loadJSON`, `loadText`,
`parseSections(glsl)` (splits on `// #SECTION` markers).

### `InputManager`
| Member | Description |
| --- | --- |
| `isDown(action)` | Keyboard + touch + gamepad union for a config action |
| `axis('steer' \| 'pitch')` | Smoothed analog −1..1 |
| `setTouchAxis(x, y)` / `setTouchButton(action, down)` | Called by the touch UI |

## physics.js

| Export | Description |
| --- | --- |
| `createRiderBody()` | `{ pos, vel, heading, grounded, airTime, groundNormal, surface … }` |
| `wrapAngle(a)` | Wrap to (−π, π] |
| `PhysicsEngine.integrateRider(body, input, dt)` | Advance one rider. `input = { steer, tuck, brake, boost, jumpImpulse, airControl }`. Returns `{ landed, impact, hitSolid, impactSpeed, triggers[] }` |
| `PhysicsEngine.surfaceParams(icy)` | Blended `{ friction, grip, name, audio }` |
| `PhysicsEngine.landingQuality(flipDeg, impact)` | `'perfect' \| 'good' \| 'sketchy' \| 'crash'` |
| `PhysicsEngine.wind` | `Vector2` set by WeatherSystem each frame |

## world.js

| Member | Description |
| --- | --- |
| `loadMap(mapDef)` / `disposeMap()` | Full environment lifecycle |
| `update(dt, focus)` | Chunk streaming + LOD + animation |
| `sampleHeight(x, z)` | Ground height (generates the chunk synchronously if needed) |
| `sampleHeightIfLoaded(x, z)` | Same but returns `null` instead of generating |
| `sampleNormal(x, z, outV3)` / `surfaceAt(x, z)` | Terrain queries |
| `obstaclesNear(x, z, r)` / `consumeObstacle(ob)` | Obstacle queries |
| `buildCheckpoints(n)` / `checkpoints` | Gate placement along the corridor |
| `createAvalanche(z)` / `updateAvalanche(dt, z)` | Avalanche wall |
| `spawnPoint()` / `voidY(z)` | Spawn + kill-plane |
| `placeSun(dir, focus)` | Reposition sun light + shadow frustum |

## workers/terrainWorker.js

| Export | Description |
| --- | --- |
| `TerrainGenerator(seed, terrainParams)` | `height(x,z)`, `surface(x,z)`, `normal(x,z)`, `generateChunk(cx, cz, density, types, rules)` |
| `corridorX(z)` | The racing-corridor meander line |
| `CHUNK_SIZE` / `CHUNK_RES` / `LAKE_SURF` | Grid constants |
| `mulberry32(seed)` | Deterministic PRNG |

Worker protocol: post `{ id, cx, cz, seed, terrain, density, obstacleTypes,
rules }`, receive `{ id, cx, cz, heights, surf, normals, obstacles }` with
transferred buffers.

## player.js

| Export | Description |
| --- | --- |
| `buildRider(colors)` | `{ group, refs }` low-poly rig (shared with AI/ghosts) |
| `SprayEmitter` | Recyclable snow-spray particles |
| `Player.fixedUpdate(dt)` | Input → physics → tricks/triggers/combo/safety |
| `Player.update(dt)` | Visual rig: slope align, lean, flips, grabs, tumble |
| `Player.spawn(x, z)` / `respawn()` / `crash(reason)` | Lifecycle |
| `Player.recording` | Ghost samples `[t, x, y, z, heading]` at 10 Hz |

## ai.js

`AIRider` (per-rider brain + body), `GhostRider` (replay), `AIManager`
(`spawnForSession(mode)`, `loadGhost(mapId)`, `standings()`, `clear()`).

## weather.js

`setupForMap(map, mode)`, `setState(id, instant)`, `update(dt)`,
`visibility()`, `wind` (Vector2), `timeOfDay` (0..1).

## camera.js

`userMode` (`follow | first | drone`), `cycleMode()`, `enterPhotoMode()` /
`exitPhotoMode()`, per-state update with FOV/shake handled internally.

## audio.js

`unlock()` (first user gesture), `applyVolumes()`, `blip/noiseBurst/chime`
synth helpers, continuous wind/carve/edge layers + generative music in
`update(dt)`. Everything else is EventBus-driven.

## ui.js

`build()`, `showScreen(id)`, `showHUD()`, `showResults(session, mode, map)`,
`showSessionLoading(map, mode)`, `showPhotoUI(bool)`, `toast(html, kind, ms)`,
`trickToast(html, kind)`, per-frame `update(dt)` (HUD + minimap).

## save.js

| Member | Description |
| --- | --- |
| `profile` | Full persisted profile (see `defaultProfile()`) |
| `addXP(n)` / `xpProgress()` / `level` | Leveling |
| `recordStat(name, value, 'add'\|'max')` | Statistics |
| `checkAchievements()` | Evaluates and emits unlocks |
| `dailyStatus()` / `claimDaily()` | Login streak rewards |
| `submitScore(map, mode, s)` / `submitTime(map, t)` | Local leaderboards |
| `saveGhost(map, time, Float32Array)` / `loadGhost(map)` | IndexedDB ghosts |
| `exportSave()` / `importSave(json)` / `resetSave()` | Portability |

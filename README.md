# Alpha Ice Surfers 3D 🏔️

A AAA-quality HTML5 open-world ice surfing game. Carve, jump, flip and grind your
way down endless procedurally generated frozen mountains — in your browser, with
zero build step and zero downloaded assets.

![Made with Three.js](https://img.shields.io/badge/Three.js-r164-blue)
![WebGL2](https://img.shields.io/badge/WebGL2-required-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

## ▶ Play

The game is a static site — serve the folder over HTTP and open it:

```bash
# any of these:
python3 -m http.server 8080
npx serve .
```

Then visit `http://localhost:8080`. That's it — no build, no npm install, no CDN.
Three.js is vendored in `libs/`, every sound is synthesised at runtime, and every
mountain is generated from a seed.

**Requirements:** a WebGL2-capable browser (Chrome, Edge, Firefox, Safari 15+,
Opera, Brave, Samsung Internet). On phones and tablets the game runs in
**landscape only** and shows touch controls automatically.

## 🎮 Controls

| Input | On the ground | In the air |
| --- | --- | --- |
| `A`/`D` or `←`/`→` | Carve left / right | Spin (360s!) |
| `W` / `S` or `↑`/`↓` | Tuck (speed) / brake | Frontflip / backflip |
| `SPACE` (hold + release) | Charge & pop a jump | — |
| `SHIFT` | Boost (earn it with tricks) | — |
| `E` | — | Grab (hold for style points) |
| `C` / `P` / `R` / `ESC` | Camera / photo mode / respawn / pause | |

Gamepads work too (left stick + A jump, X boost, B grab), and mobile gets a
virtual stick + buttons. Full details in [docs/controls.md](docs/controls.md).

## ✨ Features

- **Endless glacial valley runs** — a natural half-pipe that builds ahead of
  you as you ride: a clean, steadily descending racing groove (steep drops,
  never a hole or uphill), concave tree-lined walls on both sides to launch
  360s off, and background peaks beyond — all seeded, deterministic and
  streamed chunk-by-chunk from a Web Worker.
- **Random pastel skies** — every run rolls a new sky theme (rose, mint,
  violet, gold, peach, aqua…) that recolors the sky dome, fog, reflections
  and lighting.
- **Auto-ride** — the board carries you forward on its own at your
  difficulty's cruise speed; you steer, jump and trick.
- **Active powers on keys 1–6** — Nitro Burst, Super Jump (works mid-air),
  Ice Shield, Time Warp slow-motion, Magnet Pulse and the mid-air
  **Wingsuit** glide, each on its own cooldown, with an on-screen power
  bar showing names, keys and charge.
- **Four difficulties** — Amateur, Pro, Elite and Legendary scale cruise
  speed, boost power, stamina drain, power cooldowns, rival skill and
  count, hazard density, sky-attack frequency and XP.
- **Sky attacks** — flaming ice meteors rain in at intervals with warning
  rings, impact shockwaves and camera shake (Pro difficulty and up).
- **Cinematic slow-motion** — automatic brief slow-mo on big stunts,
  near-missed obstacles and close passes on rivals, plus the manual
  Time Warp power.
- **A living sky** — sun and crescent moon, drifting cumulus and high
  cirrus, flapping bird flocks, a hot-air balloon, shooting stars and
  aurora nights; snow-capped forests, board trails and landing
  shockwaves on the ground.
- **On-path ice hazards** — ice fangs, jumpable ice ridges, boulders and
  scoring ice arches spawn ON the racing line and get denser the further
  you ride.
- **8 hand-tuned locations** — Swiss Alps, Arctic Circle (aurora nights),
  Crystal Glacier Kingdom, Neon Ice City, Ice Volcano, Floating Glaciers,
  Sky Glacier Islands and the Cyber Ice Metropolis.
- **7 game modes** — Free Roam, Time Trial (with ghost racing), Endless Ice Run,
  Combo Rush, Avalanche Escape, Championship Race vs AI, and Zen Mode.
- **Physics-driven trick system** — flips, spins, grabs, combo multipliers,
  perfect landings, momentum-true carving with per-surface grip and friction.
- **Dynamic weather & day/night** — bluebird days, blizzards, freezing fog and
  aurora borealis, all affecting visibility, wind physics and audio.
- **AI riders** — up to 7 opponents running the same physics as the player,
  with racing lines, obstacle avoidance, mistakes, and rubber-banding.
- **Power-ups** — 🧲 Crystal Magnet, 🛡️ Ice Shield (eats one crash),
  🔥 Nitro Surge, ✖️2 Score Star and ⏳ Time Extend, floating and spinning
  along the racing line.
- **Progression** — XP, 50 levels, unlockable riders and boards, 18
  achievements, daily login rewards, local leaderboards and statistics.
- **Ghost racing & replays** — best Time Trial runs are recorded to IndexedDB
  and race alongside you as a translucent ghost.
- **Photo mode** — free-fly camera with one-click PNG capture.
- **Procedural audio** — wind, carving, ice whine, impacts and a generative
  ambient soundtrack, all synthesised with WebAudio. No audio files.
- **Adaptive quality** — automatic pixel-ratio/shadow/draw-distance scaling to
  hold 60 FPS, plus manual low/medium/high presets.

## 🗂 Project structure

```
├── index.html          # entry point (import map + boot loading screen)
├── css/                # style, ui, animations, responsive (landscape lock)
├── js/                 # game, player, world, physics, weather, ai,
│                       # camera, ui, audio, save — one system per module
├── config/             # data-driven JSON: gameplay, physics, weather, maps,
│                       # obstacles, tricks, progression
├── shaders/            # GLSL: sky, aurora, snow, ice, clouds
├── workers/            # terrainWorker.js — seeded terrain generation
├── libs/               # vendored three.module.min.js + tiny tween lib
├── maps/               # per-location asset staging (future streaming)
├── assets/             # asset staging (models/textures/audio for future DLC)
└── docs/               # architecture, controls, API reference
```

See [docs/architecture.md](docs/architecture.md) for the systems design,
[docs/api.md](docs/api.md) for module APIs, and
[docs/controls.md](docs/controls.md) for input reference.

## 🛠 Development notes

- Plain ES modules, no bundler. `package.json` is `"type": "module"` so
  `node --check js/*.js` validates syntax.
- All tuning lives in `config/*.json` — friction tables, trick scoring, weather
  states, map palettes, progression curves. Balance without touching code.
- The terrain generator is a single source of truth
  (`workers/terrainWorker.js`) imported by both the worker *and* the main
  thread, so physics ground and rendered ground can never diverge.
- Multiplayer-ready: rider simulation is deterministic at a fixed 120 Hz step
  and fully driven by an input struct, so state sync / rollback can be layered
  on later without touching the physics.

## 📄 License

MIT. Three.js © its authors (MIT), vendored unmodified in `libs/`.

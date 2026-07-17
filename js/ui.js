/**
 * ui.js — UIManager: animated menus, HUD, minimap, toasts, touch
 * controls, results, garage, settings, achievements and photo mode UI.
 *
 * All UI is DOM-based (GPU-composited CSS animations) layered over the
 * WebGL canvas, driven by EventBus events from the simulation.
 */

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function fmtTime(s) {
  if (s === null || s === undefined) return '--:--.--';
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
}

function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US');
}

const MEDAL_ICONS = { gold: '🥇', silver: '🥈', bronze: '🥉' };
const POWERUP_ICONS = { magnet: '🧲', shield: '🛡️', nitro: '🔥', multiplier: '✖️2', time: '⏳' };

export class UIManager {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('ui-root');
    this.screens = {};
    this.el = {};
    this.minimapTimer = 0;
    this.comboFlash = 0;
    this.rideSelection = { mapId: null, modeId: null };
    this.isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  }

  /* ============================================================ */
  /* Construction                                                  */
  /* ============================================================ */

  build() {
    this.buildMainMenu();
    this.buildRideScreen();
    this.buildGarage();
    this.buildProfileScreen();
    this.buildSettings();
    this.buildHelp();
    this.buildPause();
    this.buildResults();
    this.buildHUD();
    this.buildOverlays();
    if (this.isTouch) this.buildTouchControls();
    this.bindEvents();
  }

  addScreen(id, node) {
    node.classList.add('screen', 'hidden');
    node.id = `screen-${id}`;
    this.root.appendChild(node);
    this.screens[id] = node;
    return node;
  }

  showScreen(id) {
    for (const [key, node] of Object.entries(this.screens)) {
      node.classList.toggle('hidden', key !== id);
    }
    this.el.hud.classList.add('hidden');
    if (this.el.touch) this.el.touch.classList.add('hidden');
    if (id === 'main') this.refreshMainMenu();
    if (id === 'ride') this.refreshRideScreen();
    if (id === 'garage') this.refreshGarage();
    if (id === 'profile') this.refreshProfile();
    if (id === 'settings') this.refreshSettings();
    this.game.bus.emit('ui-open', { screen: id });
  }

  hideAllScreens() {
    for (const node of Object.values(this.screens)) node.classList.add('hidden');
  }

  showHUD() {
    this.hideAllScreens();
    this.el.sessionLoading.classList.add('hidden');
    const zen = this.game.mode && this.game.mode.zen;
    this.el.hud.classList.remove('hidden');
    this.el.hud.classList.toggle('zen', !!zen);
    if (this.el.touch) this.el.touch.classList.remove('hidden');
  }

  /* ---------------- main menu ---------------- */

  buildMainMenu() {
    const s = el('div', 'menu-screen');
    s.innerHTML = `
      <div class="menu-gradient"></div>
      <header class="menu-header">
        <h1 class="game-title">ALPHA <span>ICE SURFERS</span> 3D</h1>
        <p class="game-subtitle">Carve the frozen frontier</p>
      </header>
      <div class="player-card panel">
        <div class="player-card-row">
          <div class="player-level-badge" id="menu-level">1</div>
          <div class="player-card-info">
            <div class="player-card-name">Rider Profile</div>
            <div class="xp-bar"><div class="xp-bar-fill" id="menu-xp-fill"></div></div>
            <div class="xp-label" id="menu-xp-label"></div>
          </div>
        </div>
        <button class="btn btn-small btn-accent hidden" id="btn-daily">🎁 Claim Daily Reward</button>
      </div>
      <nav class="menu-nav">
        <button class="btn btn-big" data-nav="ride">▶&nbsp; RIDE</button>
        <button class="btn" data-nav="garage">🛹&nbsp; Garage</button>
        <button class="btn" data-nav="profile">🏆&nbsp; Profile &amp; Records</button>
        <button class="btn" data-nav="settings">⚙️&nbsp; Settings</button>
        <button class="btn" data-nav="help">🎮&nbsp; How To Play</button>
      </nav>
      <footer class="menu-footer">
        <button class="btn btn-small" id="btn-fullscreen">⛶ Fullscreen</button>
        <span class="version">v1.4.0 · WebGL2</span>
      </footer>`;
    this.addScreen('main', s);

    s.querySelectorAll('[data-nav]').forEach((b) => {
      b.addEventListener('click', () => {
        this.click();
        this.showScreen(b.dataset.nav);
      });
    });
    s.querySelector('#btn-fullscreen').addEventListener('click', () => {
      this.click();
      this.requestFullscreen();
    });
    s.querySelector('#btn-daily').addEventListener('click', () => {
      this.click();
      const r = this.game.save.claimDaily();
      if (r) this.toast(`🎁 Daily reward: +${r.xp} XP (day ${r.streak})`, 'accent');
      this.refreshMainMenu();
    });
  }

  refreshMainMenu() {
    const save = this.game.save;
    const prog = save.xpProgress();
    const lvlEl = this.screens.main.querySelector('#menu-level');
    lvlEl.textContent = prog.level;
    this.screens.main.querySelector('#menu-xp-fill').style.width =
      `${Math.round((prog.into / prog.need) * 100)}%`;
    this.screens.main.querySelector('#menu-xp-label').textContent =
      `Level ${prog.level} · ${fmtInt(prog.into)} / ${fmtInt(prog.need)} XP`;
    const daily = this.screens.main.querySelector('#btn-daily');
    daily.classList.toggle('hidden', !save.dailyStatus().claimable);
  }

  requestFullscreen() {
    const app = document.getElementById('app');
    const fs = app.requestFullscreen || app.webkitRequestFullscreen;
    if (fs) {
      fs.call(app).then(() => {
        if (screen.orientation && screen.orientation.lock) {
          screen.orientation.lock('landscape').catch(() => {});
        }
      }).catch(() => {});
    }
  }

  /* ---------------- ride (map + mode select) ---------------- */

  buildRideScreen() {
    const s = el('div', 'menu-screen');
    s.innerHTML = `
      <div class="menu-gradient"></div>
      <header class="screen-header">
        <button class="btn btn-back" data-back>←</button>
        <h2>Choose Your Ride</h2>
      </header>
      <div class="ride-layout">
        <section class="ride-col">
          <h3>Mode</h3>
          <div class="card-list" id="mode-list"></div>
        </section>
        <section class="ride-col">
          <h3>Location</h3>
          <div class="card-list" id="map-list"></div>
        </section>
        <section class="ride-col ride-summary panel">
          <h3 id="ride-title">—</h3>
          <p id="ride-desc"></p>
          <div class="diff-label">DIFFICULTY</div>
          <div class="diff-row" id="diff-row"></div>
          <p class="diff-desc" id="diff-desc"></p>
          <div class="diff-label">WEATHER</div>
          <div class="diff-row" id="weather-row"></div>
          <div id="ride-best" class="ride-best"></div>
          <button class="btn btn-big btn-accent" id="btn-start" disabled>START</button>
        </section>
      </div>`;
    this.addScreen('ride', s);
    s.querySelector('[data-back]').addEventListener('click', () => {
      this.click(); this.showScreen('main');
    });
    s.querySelector('#btn-start').addEventListener('click', () => {
      this.click();
      const { mapId, modeId, weatherId } = this.rideSelection;
      if (mapId && modeId) this.game.startSession(mapId, modeId, weatherId || 'random');
    });
  }

  refreshRideScreen() {
    const game = this.game;
    const level = game.save.level;
    const modeList = this.screens.ride.querySelector('#mode-list');
    const mapList = this.screens.ride.querySelector('#map-list');
    modeList.innerHTML = '';
    mapList.innerHTML = '';

    for (const mode of game.config.gameplay.modes) {
      const locked = mode.unlockLevel > level;
      const card = el('button', `card ${locked ? 'locked' : ''}`,
        `<span class="card-icon">${mode.icon}</span>
         <span class="card-name">${mode.name}</span>
         ${locked ? `<span class="card-lock">🔒 Lv ${mode.unlockLevel}</span>` : ''}`);
      if (!locked) {
        card.addEventListener('click', () => {
          this.click();
          this.rideSelection.modeId = mode.id;
          this.refreshRideSelection();
        });
      }
      card.dataset.id = mode.id;
      modeList.appendChild(card);
    }

    for (const map of game.config.maps.maps) {
      const locked = map.unlockLevel > level;
      const card = el('button', `card ${locked ? 'locked' : ''}`,
        `<span class="card-swatch" style="background:linear-gradient(135deg, ${map.palette.skyTop}, ${map.palette.skyHorizon})"></span>
         <span class="card-name">${map.name}</span>
         ${locked ? `<span class="card-lock">🔒 Lv ${map.unlockLevel}</span>` : ''}`);
      if (!locked) {
        card.addEventListener('click', () => {
          this.click();
          this.rideSelection.mapId = map.id;
          this.refreshRideSelection();
        });
      }
      card.dataset.id = map.id;
      mapList.appendChild(card);
    }

    // Difficulty picker.
    const diffRow = this.screens.ride.querySelector('#diff-row');
    diffRow.innerHTML = '';
    const selected = game.save.profile.settings.difficulty || 'pro';
    for (const d of game.config.gameplay.difficulties) {
      const b = el('button', `diff-chip ${d.id === selected ? 'selected' : ''}`,
        `${d.icon}<span>${d.name}</span>`);
      b.addEventListener('click', () => {
        this.click();
        game.save.profile.settings.difficulty = d.id;
        game.save.persist();
        this.refreshRideScreen();
      });
      diffRow.appendChild(b);
    }
    const diffDef = game.config.gameplay.difficulties.find((d) => d.id === selected);
    this.screens.ride.querySelector('#diff-desc').textContent = diffDef ? diffDef.desc : '';

    // Weather picker: Random or any state from the full catalogue.
    if (!this.rideSelection.weatherId) this.rideSelection.weatherId = 'random';
    const weatherRow = this.screens.ride.querySelector('#weather-row');
    weatherRow.innerHTML = '';
    const weatherOptions = [
      { id: 'random', icon: '🎲', name: 'Random' },
      ...game.config.weather.states.map((s) => ({ id: s.id, icon: s.icon || '❔', name: s.name }))
    ];
    for (const w of weatherOptions) {
      const b = el('button',
        `diff-chip weather-chip ${w.id === this.rideSelection.weatherId ? 'selected' : ''}`,
        `${w.icon}<span>${w.name}</span>`);
      b.title = w.name;
      b.addEventListener('click', () => {
        this.click();
        this.rideSelection.weatherId = w.id;
        this.refreshRideScreen();
      });
      weatherRow.appendChild(b);
    }

    if (!this.rideSelection.modeId) this.rideSelection.modeId = 'freeroam';
    if (!this.rideSelection.mapId) this.rideSelection.mapId = game.unlockedMaps()[0].id;
    this.refreshRideSelection();
  }

  refreshRideSelection() {
    const game = this.game;
    const { mapId, modeId } = this.rideSelection;
    const mode = game.config.gameplay.modes.find((m) => m.id === modeId);
    const map = game.config.maps.maps.find((m) => m.id === mapId);
    this.screens.ride.querySelectorAll('.card').forEach((c) => {
      c.classList.toggle('selected', c.dataset.id === mapId || c.dataset.id === modeId);
    });
    const title = this.screens.ride.querySelector('#ride-title');
    const desc = this.screens.ride.querySelector('#ride-desc');
    const best = this.screens.ride.querySelector('#ride-best');
    const start = this.screens.ride.querySelector('#btn-start');
    if (mode && map) {
      title.textContent = `${mode.name} · ${map.name}`;
      desc.textContent = `${mode.desc} ${map.desc}`;
      const bestScore = game.save.profile.bestScores[`${map.id}:${mode.id}`];
      const bestTime = game.save.profile.bestTimes[map.id];
      let html = '';
      if (mode.id === 'timetrial') {
        html += `<div>⏱️ Best time: <b>${bestTime !== undefined ? fmtTime(bestTime) : '—'}</b></div>`;
        html += `<div>🥇 ${fmtTime(map.medals.gold)} · 🥈 ${fmtTime(map.medals.silver)} · 🥉 ${fmtTime(map.medals.bronze)}</div>`;
      }
      if (mode.scoring) {
        html += `<div>⭐ Best score: <b>${bestScore !== undefined ? fmtInt(bestScore) : '—'}</b></div>`;
      }
      best.innerHTML = html;
      start.disabled = false;
    } else {
      start.disabled = true;
    }
  }

  /* ---------------- garage ---------------- */

  buildGarage() {
    const s = el('div', 'menu-screen');
    s.innerHTML = `
      <div class="menu-gradient"></div>
      <header class="screen-header">
        <button class="btn btn-back" data-back>←</button>
        <h2>Garage</h2>
      </header>
      <div class="garage-layout">
        <section><h3>Riders</h3><div class="card-list horizontal" id="char-list"></div></section>
        <section><h3>Boards</h3><div class="card-list horizontal" id="board-list"></div></section>
      </div>`;
    this.addScreen('garage', s);
    s.querySelector('[data-back]').addEventListener('click', () => {
      this.click(); this.showScreen('main');
    });
  }

  refreshGarage() {
    const game = this.game;
    const level = game.save.level;
    const profile = game.save.profile;
    const charList = this.screens.garage.querySelector('#char-list');
    const boardList = this.screens.garage.querySelector('#board-list');
    charList.innerHTML = '';
    boardList.innerHTML = '';

    for (const c of game.config.progression.characters) {
      const locked = c.unlockLevel > level;
      const sel = profile.selectedCharacter === c.id;
      const card = el('button', `card garage-card ${locked ? 'locked' : ''} ${sel ? 'selected' : ''}`,
        `<span class="rider-preview">
           <span class="rp-helmet" style="background:${c.accent}"></span>
           <span class="rp-suit" style="background:${c.suit}"></span>
         </span>
         <span class="card-name">${c.name}</span>
         ${locked ? `<span class="card-lock">🔒 Lv ${c.unlockLevel}</span>` : sel ? '<span class="card-sel">✓</span>' : ''}`);
      if (!locked) {
        card.addEventListener('click', () => {
          this.click();
          profile.selectedCharacter = c.id;
          game.save.persist();
          this.refreshGarage();
        });
      }
      charList.appendChild(card);
    }

    for (const b of game.config.progression.boards) {
      const locked = b.unlockLevel > level;
      const sel = profile.selectedBoard === b.id;
      const card = el('button', `card garage-card ${locked ? 'locked' : ''} ${sel ? 'selected' : ''}`,
        `<span class="board-preview" style="background:${b.color}; box-shadow:0 0 14px ${b.glow}"></span>
         <span class="card-name">${b.name}</span>
         <span class="card-stat">${b.stat}</span>
         ${locked ? `<span class="card-lock">🔒 Lv ${b.unlockLevel}</span>` : sel ? '<span class="card-sel">✓</span>' : ''}`);
      if (!locked) {
        card.addEventListener('click', () => {
          this.click();
          profile.selectedBoard = b.id;
          game.save.persist();
          this.refreshGarage();
        });
      }
      boardList.appendChild(card);
    }
  }

  /* ---------------- profile: achievements / stats / records ---------------- */

  buildProfileScreen() {
    const s = el('div', 'menu-screen');
    s.innerHTML = `
      <div class="menu-gradient"></div>
      <header class="screen-header">
        <button class="btn btn-back" data-back>←</button>
        <h2>Profile</h2>
        <div class="tabs">
          <button class="tab selected" data-tab="achievements">Achievements</button>
          <button class="tab" data-tab="stats">Statistics</button>
          <button class="tab" data-tab="records">Records</button>
        </div>
      </header>
      <div class="profile-body" id="profile-body"></div>`;
    this.addScreen('profile', s);
    s.querySelector('[data-back]').addEventListener('click', () => {
      this.click(); this.showScreen('main');
    });
    s.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => {
        this.click();
        s.querySelectorAll('.tab').forEach((x) => x.classList.remove('selected'));
        t.classList.add('selected');
        this.profileTab = t.dataset.tab;
        this.refreshProfile();
      });
    });
    this.profileTab = 'achievements';
  }

  refreshProfile() {
    const body = this.screens.profile.querySelector('#profile-body');
    const save = this.game.save;
    const tab = this.profileTab || 'achievements';

    if (tab === 'achievements') {
      body.innerHTML = '';
      const grid = el('div', 'ach-grid');
      for (const a of this.game.config.progression.achievements) {
        const done = !!save.profile.achievements[a.id];
        const value = save.profile.stats[a.stat] || 0;
        const pct = Math.min(100, Math.round((value / a.target) * 100));
        grid.appendChild(el('div', `ach-card panel ${done ? 'done' : ''}`,
          `<div class="ach-head">${done ? '🏆' : '🔸'} <b>${a.name}</b> <span class="ach-xp">+${a.xp} XP</span></div>
           <div class="ach-desc">${a.desc}</div>
           <div class="ach-bar"><div class="ach-bar-fill" style="width:${pct}%"></div></div>`));
      }
      body.appendChild(grid);
    } else if (tab === 'stats') {
      const st = save.profile.stats;
      const rows = [
        ['Sessions', fmtInt(st.sessions)],
        ['Play time', `${Math.floor(st.playTime / 60)} min`],
        ['Total distance', `${(st.totalDistance / 1000).toFixed(1)} km`],
        ['Top speed', `${Math.round(st.topSpeedKmh)} km/h`],
        ['Tricks landed', fmtInt(st.tricksLanded)],
        ['Flips landed', fmtInt(st.flipsLanded)],
        ['Best combo', fmtInt(st.bestCombo)],
        ['Best air time', `${st.bestAirTime.toFixed(1)} s`],
        ['Perfect landings', fmtInt(st.perfectLandings)],
        ['Crystals collected', fmtInt(st.crystals)],
        ['Crashes', fmtInt(st.crashes)],
        ['Jumps', fmtInt(st.jumps)],
        ['Medals', `🥇${st.goldMedals} 🥈${st.silverMedals} 🥉${st.bronzeMedals}`],
        ['Races won', fmtInt(st.racesWon)]
      ];
      body.innerHTML = `<div class="stats-table panel">${rows.map(
        ([k, v]) => `<div class="stats-row"><span>${k}</span><b>${v}</b></div>`
      ).join('')}</div>`;
    } else {
      const maps = this.game.config.maps.maps;
      let html = '<div class="stats-table panel">';
      html += '<div class="stats-row stats-head"><span>Location</span><b>Best Time · Best Scores</b></div>';
      for (const m of maps) {
        const t = save.profile.bestTimes[m.id];
        const scores = Object.entries(save.profile.bestScores)
          .filter(([k]) => k.startsWith(`${m.id}:`))
          .map(([k, v]) => `${k.split(':')[1]}: ${fmtInt(v)}`)
          .join(' · ');
        html += `<div class="stats-row"><span>${m.name}</span><b>${t !== undefined ? fmtTime(t) : '—'}${scores ? ' · ' + scores : ''}</b></div>`;
      }
      body.innerHTML = html + '</div>';
    }
  }

  /* ---------------- settings ---------------- */

  buildSettings() {
    const s = el('div', 'menu-screen');
    s.innerHTML = `
      <div class="menu-gradient"></div>
      <header class="screen-header">
        <button class="btn btn-back" data-back>←</button>
        <h2>Settings</h2>
      </header>
      <div class="settings-body panel">
        <label class="setting-row">Quality
          <select id="set-quality">
            <option value="auto">Auto (adaptive)</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <label class="setting-row">Master volume <input type="range" id="set-master" min="0" max="1" step="0.05"></label>
        <label class="setting-row">Music volume <input type="range" id="set-music" min="0" max="1" step="0.05"></label>
        <label class="setting-row">SFX volume <input type="range" id="set-sfx" min="0" max="1" step="0.05"></label>
        <label class="setting-row">Show FPS <input type="checkbox" id="set-fps"></label>
        <label class="setting-row">Invert flip axis <input type="checkbox" id="set-invert"></label>
        <div class="setting-actions">
          <button class="btn btn-small" id="btn-export">⬇ Export Save</button>
          <button class="btn btn-small" id="btn-import">⬆ Import Save</button>
          <button class="btn btn-small btn-danger" id="btn-reset">🗑 Reset Save</button>
          <input type="file" id="import-file" accept=".json" class="hidden">
        </div>
      </div>`;
    this.addScreen('settings', s);
    s.querySelector('[data-back]').addEventListener('click', () => {
      this.click(); this.showScreen('main');
    });

    const save = this.game.save;
    const bind = (id, key, isCheck = false) => {
      const input = s.querySelector(id);
      input.addEventListener('change', () => {
        save.profile.settings[key] = isCheck ? input.checked
          : (id === '#set-quality' ? input.value : parseFloat(input.value));
        save.persist();
        this.game.audio.applyVolumes();
        if (key === 'quality' && input.value !== 'auto') this.game.applyQuality(input.value);
        this.click();
      });
    };
    bind('#set-quality', 'quality');
    bind('#set-master', 'master');
    bind('#set-music', 'music');
    bind('#set-sfx', 'sfx');
    bind('#set-fps', 'showFps', true);
    bind('#set-invert', 'invertFlip', true);

    s.querySelector('#btn-export').addEventListener('click', () => {
      this.click(); save.exportSave();
    });
    s.querySelector('#btn-import').addEventListener('click', () => {
      this.click(); s.querySelector('#import-file').click();
    });
    s.querySelector('#import-file').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      file.text().then((text) => {
        try {
          save.importSave(text);
          this.toast('✅ Save imported', 'accent');
          this.refreshSettings();
        } catch (err) {
          this.toast(`⚠️ ${err.message}`, 'danger');
        }
      });
    });
    s.querySelector('#btn-reset').addEventListener('click', () => {
      this.click();
      if (confirm('Reset ALL progress? This cannot be undone.')) {
        save.resetSave();
        this.toast('Save reset', 'danger');
        this.refreshSettings();
      }
    });
  }

  refreshSettings() {
    const s = this.screens.settings;
    const set = this.game.save.profile.settings;
    s.querySelector('#set-quality').value = set.quality;
    s.querySelector('#set-master').value = set.master;
    s.querySelector('#set-music').value = set.music;
    s.querySelector('#set-sfx').value = set.sfx;
    s.querySelector('#set-fps').checked = set.showFps;
    s.querySelector('#set-invert').checked = set.invertFlip;
  }

  /* ---------------- help ---------------- */

  buildHelp() {
    const s = el('div', 'menu-screen');
    s.innerHTML = `
      <div class="menu-gradient"></div>
      <header class="screen-header">
        <button class="btn btn-back" data-back>←</button>
        <h2>How To Play</h2>
      </header>
      <div class="help-body panel">
        <div class="help-grid">
          <div><b>Auto-ride</b> Your board accelerates on its own — steer, jump, trick!</div>
          <div><b>A / D or ← →</b> Carve left / right (spin in the air)</div>
          <div><b>W / S or ↑ ↓</b> Extra tuck speed / brake (flip in the air)</div>
          <div><b>1–6</b> Powers · <b>6</b> deploys the Wingsuit mid-air to glide</div>
          <div><b>SPACE</b> Hold to charge, release to jump</div>
          <div><b>SHIFT</b> Boost (fill the meter with tricks)</div>
          <div><b>E</b> Grab (hold in the air for style points)</div>
          <div><b>C</b> Camera · <b>P</b> Photo mode · <b>R</b> Respawn</div>
          <div><b>ESC</b> Pause</div>
          <div><b>Gamepad</b> Left stick + A jump, X boost, B grab</div>
        </div>
        <p class="help-tip">💡 Land clean for <b>Perfect Landing</b> bonuses. Ice is fast but slippery —
        powder snow grips. Chain tricks quickly to grow your combo multiplier, and thread the
        glowing rings for boost.</p>
        <p class="help-tip">✨ Grab the floating power-ups on the racing line:
        🧲 <b>Crystal Magnet</b> hoovers crystals, 🛡️ <b>Ice Shield</b> eats one crash,
        🔥 <b>Nitro Surge</b> is free full boost, ✖️2 <b>Score Star</b> doubles points and
        ⏳ <b>Time Extend</b> adds seconds in timed modes.</p>
      </div>`;
    this.addScreen('help', s);
    s.querySelector('[data-back]').addEventListener('click', () => {
      this.click(); this.showScreen('main');
    });
  }

  /* ---------------- pause ---------------- */

  buildPause() {
    const s = el('div', 'overlay-screen');
    s.innerHTML = `
      <div class="pause-panel panel">
        <h2>PAUSED</h2>
        <button class="btn btn-big" id="btn-resume">Resume</button>
        <button class="btn" id="btn-restart">Restart</button>
        <button class="btn" id="btn-quit">Quit to Menu</button>
      </div>`;
    this.addScreen('pause', s);
    s.querySelector('#btn-resume').addEventListener('click', () => { this.click(); this.game.resume(); });
    s.querySelector('#btn-restart').addEventListener('click', () => { this.click(); this.game.restartSession(); });
    s.querySelector('#btn-quit').addEventListener('click', () => { this.click(); this.game.returnToMenu(); });
  }

  /* ---------------- results ---------------- */

  buildResults() {
    const s = el('div', 'overlay-screen');
    s.innerHTML = `
      <div class="results-panel panel">
        <h2 id="results-title">RUN COMPLETE</h2>
        <div id="results-medal" class="results-medal"></div>
        <div id="results-rows" class="results-rows"></div>
        <div class="results-xp">
          <div class="xp-bar"><div class="xp-bar-fill" id="results-xp-fill"></div></div>
          <div id="results-xp-label" class="xp-label"></div>
        </div>
        <div class="results-buttons">
          <button class="btn btn-accent" id="btn-retry">↻ Retry</button>
          <button class="btn" id="btn-results-menu">Menu</button>
        </div>
      </div>`;
    this.addScreen('results', s);
    s.querySelector('#btn-retry').addEventListener('click', () => { this.click(); this.game.restartSession(); });
    s.querySelector('#btn-results-menu').addEventListener('click', () => { this.click(); this.game.returnToMenu(); });
  }

  showResults(session, mode, map) {
    const s = this.screens.results;
    const titles = {
      finished: mode.race ? `FINISHED P${session.position}` : 'RUN COMPLETE',
      timeup: "TIME'S UP!",
      caught: 'BURIED BY THE AVALANCHE',
      quit: 'RUN ENDED'
    };
    s.querySelector('#results-title').textContent = titles[session.outcome] || 'RUN COMPLETE';
    s.querySelector('#results-medal').innerHTML = session.medal
      ? `<span class="medal-big">${MEDAL_ICONS[session.medal]}</span>` : '';

    const rows = [];
    if (mode.scoring) rows.push(['Score', `${fmtInt(session.score)}${session.newBestScore ? ' ✨ NEW BEST' : ''}`]);
    if (mode.id === 'timetrial' || mode.race) rows.push(['Time', `${fmtTime(session.time)}${session.newBestTime ? ' ✨ NEW BEST' : ''}`]);
    rows.push(['Distance', `${(session.distance / 1000).toFixed(2)} km`]);
    rows.push(['Top speed', `${Math.round(session.topSpeed)} km/h`]);
    rows.push(['Air time', `${session.airTime.toFixed(1)} s`]);
    if (session.crystals) rows.push(['Crystals', fmtInt(session.crystals)]);
    if (mode.race && session.standings) {
      rows.push(['Standings', session.standings.map((r, i) =>
        `${i + 1}. ${r.name}`).join('&nbsp;&nbsp;')]);
    }
    s.querySelector('#results-rows').innerHTML = rows.map(
      ([k, v]) => `<div class="results-row"><span>${k}</span><b>${v}</b></div>`
    ).join('');

    const prog = this.game.save.xpProgress();
    const fill = s.querySelector('#results-xp-fill');
    fill.style.width = `${Math.round((prog.into / prog.need) * 100)}%`;
    s.querySelector('#results-xp-label').textContent =
      `+${fmtInt(session.xpEarned)} XP · Level ${prog.level}` +
      (session.leveledUp ? ' · LEVEL UP! 🎉' : '');

    this.hideAllScreens();
    this.el.hud.classList.add('hidden');
    if (this.el.touch) this.el.touch.classList.add('hidden');
    s.classList.remove('hidden');
  }

  /* ---------------- HUD ---------------- */

  buildHUD() {
    const hud = el('div', 'hidden');
    hud.id = 'hud';
    hud.innerHTML = `
      <div class="hud-topleft">
        <div class="hud-mode" id="hud-mode"></div>
        <div class="hud-timer" id="hud-timer">0:00.00</div>
        <div class="hud-objective" id="hud-objective"></div>
      </div>
      <div class="hud-topcenter">
        <div class="hud-score" id="hud-score"></div>
        <div class="hud-combo hidden" id="hud-combo">
          <span id="hud-combo-mult">x1</span>
          <span id="hud-combo-score">0</span>
        </div>
      </div>
      <div class="hud-topright">
        <canvas id="minimap" width="150" height="150"></canvas>
        <div class="hud-weather" id="hud-weather"></div>
        <div class="hud-fps hidden" id="hud-fps"></div>
      </div>
      <div class="hud-bottomleft">
        <div class="hud-speed"><span id="hud-speed">0</span><small> km/h</small></div>
        <div class="hud-alt" id="hud-alt"></div>
      </div>
      <div class="hud-bottomright">
        <div class="boost-label">BOOST</div>
        <div class="boost-bar"><div class="boost-bar-fill" id="hud-boost"></div></div>
      </div>
      <div class="hud-powerups" id="hud-powerups"></div>
      <div class="hud-powerbar" id="hud-powerbar"></div>
      <div class="hud-hint" id="hud-hint">AUTO-RIDE · A / D CARVE · SPACE JUMP · IN AIR: A / D SPIN · W / S FLIP · E GRAB · 1-6 POWERS · 6 = WINGSUIT</div>
      <div class="hud-center">
        <div class="hud-countdown hidden" id="hud-countdown"></div>
        <div class="hud-tricks" id="hud-tricks"></div>
      </div>
      <div class="vignette" id="vignette"></div>
      <div class="speedlines" id="speedlines"></div>`;
    this.root.appendChild(hud);
    this.el.hud = hud;
    this.el.minimap = hud.querySelector('#minimap');
    this.minimapCtx = this.el.minimap.getContext('2d');
    this.buildPowerBar();
  }

  /** Power bar: names + keys for the 1-5 special powers, tap-to-use. */
  buildPowerBar() {
    const bar = this.el.hud.querySelector('#hud-powerbar');
    this.powerChips = new Map();
    for (const p of this.game.config.gameplay.powers || []) {
      const chip = el('button', 'power-chip',
        `<span class="pc-key">${p.slot}</span>
         <span class="pc-icon">${p.icon}</span>
         <span class="pc-name">${p.name.toUpperCase()}</span>
         <span class="pc-cd"></span>`);
      chip.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.game.bus.emit('action', { action: 'power', slot: p.slot });
      });
      bar.appendChild(chip);
      this.powerChips.set(p.id, { chip, def: p, cd: chip.querySelector('.pc-cd') });
    }
  }

  buildOverlays() {
    const loading = el('div', 'overlay-screen hidden');
    loading.id = 'session-loading';
    loading.innerHTML = `
      <div class="session-loading-inner">
        <h2 id="sl-title">Loading</h2>
        <p id="sl-desc"></p>
        <div class="spinner"></div>
        <p class="sl-tip" id="sl-tip"></p>
      </div>`;
    this.root.appendChild(loading);
    this.el.sessionLoading = loading;

    const toasts = el('div', '');
    toasts.id = 'toasts';
    this.root.appendChild(toasts);
    this.el.toasts = toasts;

    const photo = el('div', 'hidden');
    photo.id = 'photo-ui';
    photo.innerHTML = `
      <div class="photo-hint">📷 Photo Mode — drag to look · WASD to fly · SPACE/E up-down</div>
      <div class="photo-buttons">
        <button class="btn btn-accent" id="btn-capture">📸 Capture</button>
        <button class="btn" id="btn-photo-exit">✕ Exit</button>
      </div>`;
    this.root.appendChild(photo);
    this.el.photo = photo;
    photo.querySelector('#btn-capture').addEventListener('click', () => {
      this.click(); this.game.captureScreenshot();
      this.toast('📸 Screenshot saved', 'accent');
    });
    photo.querySelector('#btn-photo-exit').addEventListener('click', () => {
      this.click(); this.game.togglePhotoMode();
    });
  }

  showSessionLoading(map, mode) {
    this.hideAllScreens();
    const tips = [
      'Hold SPACE to charge bigger jumps.',
      'Perfect landings refill your boost.',
      'Black ice is the fastest surface — and the slipperiest.',
      'Spin with A/D in the air. Flip with W/S.',
      'Thread the glowing rings for a huge boost.',
      'Grabs (hold E) multiply your air-time points.',
      'Brake before hairpins — carving scrubs speed.',
      'A 🛡️ shield eats one crash. Spend it on a risky line.',
      'The 🧲 magnet hoovers every crystal near the racing line.',
      'Stack ✖️2 with a big combo for absurd scores.'
    ];
    this.el.sessionLoading.querySelector('#sl-title').textContent = `${mode.name} · ${map.name}`;
    this.el.sessionLoading.querySelector('#sl-desc').textContent = map.desc;
    // Sky theme is chosen right after this overlay shows.
    const once = this.game.bus.on('sky-theme', (t) => {
      once();
      const descEl = this.el.sessionLoading.querySelector('#sl-desc');
      if (descEl) descEl.textContent = `${map.desc} — Sky: ${t.name}`;
    });
    this.el.sessionLoading.querySelector('#sl-tip').textContent =
      `💡 ${tips[Math.floor(Math.random() * tips.length)]}`;
    this.el.sessionLoading.classList.remove('hidden');
  }

  showPhotoUI(show) {
    this.el.photo.classList.toggle('hidden', !show);
    this.el.hud.classList.toggle('hidden', show);
    if (this.el.touch) this.el.touch.classList.toggle('hidden', show);
  }

  /* ---------------- touch controls ---------------- */

  buildTouchControls() {
    const t = el('div', 'hidden');
    t.id = 'touch-controls';
    t.innerHTML = `
      <div class="touch-stick" id="touch-stick">
        <div class="touch-stick-knob" id="touch-knob"></div>
      </div>
      <div class="touch-buttons">
        <button class="touch-btn" id="tb-grab">GRAB</button>
        <button class="touch-btn" id="tb-boost">BOOST</button>
        <button class="touch-btn touch-btn-big" id="tb-jump">JUMP</button>
      </div>
      <div class="touch-top">
        <button class="touch-btn touch-btn-small" id="tb-cam">🎥</button>
        <button class="touch-btn touch-btn-small" id="tb-fs">⛶</button>
        <button class="touch-btn touch-btn-small" id="tb-pause">⏸</button>
      </div>`;
    this.root.appendChild(t);
    this.el.touch = t;

    const input = this.game.input;
    const stick = t.querySelector('#touch-stick');
    const knob = t.querySelector('#touch-knob');
    let stickId = null;

    const setStick = (e) => {
      const rect = stick.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const dx = (e.clientX - cx) / (rect.width / 2);
      const dy = (e.clientY - cy) / (rect.height / 2);
      input.setTouchAxis(dx, -dy);
      knob.style.transform = `translate(${Math.max(-1, Math.min(1, dx)) * 30}px, ${Math.max(-1, Math.min(1, dy)) * 30}px)`;
    };
    stick.addEventListener('pointerdown', (e) => {
      stickId = e.pointerId;
      stick.setPointerCapture(e.pointerId);
      setStick(e);
    });
    stick.addEventListener('pointermove', (e) => {
      if (e.pointerId === stickId) setStick(e);
    });
    const endStick = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      input.setTouchAxis(0, 0);
      knob.style.transform = 'translate(0,0)';
    };
    stick.addEventListener('pointerup', endStick);
    stick.addEventListener('pointercancel', endStick);

    const bindBtn = (id, action) => {
      const b = t.querySelector(id);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        input.setTouchButton(action, true);
      });
      const up = () => input.setTouchButton(action, false);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('pointerleave', up);
    };
    bindBtn('#tb-jump', 'jump');
    bindBtn('#tb-boost', 'boost');
    bindBtn('#tb-grab', 'grab');
    t.querySelector('#tb-cam').addEventListener('click', () => this.game.bus.emit('action', { action: 'camera' }));
    t.querySelector('#tb-fs').addEventListener('click', () => this.requestFullscreen());
    t.querySelector('#tb-pause').addEventListener('click', () => this.game.bus.emit('action', { action: 'pause' }));
  }

  /* ---------------- events / toasts ---------------- */

  bindEvents() {
    const bus = this.game.bus;

    bus.on('trick', (e) => {
      this.trickToast(`${e.name} <b>+${fmtInt(e.points)}</b>${e.multiplier > 1 ? ` <i>x${e.multiplier.toFixed(2)}</i>` : ''}`,
        e.quality === 'perfect' ? 'perfect' : '');
      this.comboFlash = 1;
    });
    bus.on('perfect', () => this.trickToast('PERFECT LANDING!', 'perfect'));
    bus.on('crash', () => {
      this.flashVignette();
      this.trickToast('WIPEOUT!', 'crash');
    });
    bus.on('combo-end', (e) => {
      if (!e.dropped && e.score > 0) this.trickToast(`COMBO BANKED +${fmtInt(e.score)}`, 'combo');
    });
    bus.on('checkpoint', (e) => {
      this.trickToast(`CHECKPOINT ${e.index}/${e.total} · ${fmtTime(e.time)}`, 'checkpoint');
    });
    bus.on('collect', () => { /* subtle — score popup handles it */ });
    bus.on('ring', () => this.trickToast('BOOST RING!', 'ring'));
    bus.on('powerup', (e) => this.trickToast(`${POWERUP_ICONS[e.power] || '✨'} ${e.name.toUpperCase()}!`, 'powerup'));
    bus.on('shield-save', () => this.trickToast('🛡️ SHIELD SAVED YOU!', 'perfect'));
    bus.on('arch', () => this.trickToast('❄️ ICE ARCH!', 'ring'));
    bus.on('power-used', (p) => this.trickToast(`${p.icon} ${p.name.toUpperCase()}!`, 'powerup'));
    bus.on('power-denied', (p) => this.toast(
      p.reason === 'air' ? `${p.icon} ${p.name} only works mid-air — jump first!`
        : `${p.icon} ${p.name} recharging…`, '', 1400));
    bus.on('meteor-warning', () => this.trickToast('☄️ INCOMING!', 'crash'));
    bus.on('nearmiss', () => this.trickToast('NEAR MISS +50', 'checkpoint'));
    bus.on('closepass', () => this.trickToast('CLOSE PASS +75', 'checkpoint'));
    bus.on('countdown', (e) => {
      const cd = this.el.hud.querySelector('#hud-countdown');
      cd.classList.remove('hidden');
      cd.textContent = e.n > 0 ? e.n : 'GO!';
      cd.classList.remove('pop');
      void cd.offsetWidth; // restart animation
      cd.classList.add('pop');
      if (e.n === 0) setTimeout(() => cd.classList.add('hidden'), 900);
    });
    bus.on('achievement', (a) => this.toast(`🏆 Achievement: <b>${a.name}</b>`, 'accent', 5000));
    bus.on('levelup', (e) => this.toast(`⬆️ LEVEL ${e.level}! New gear may be unlocked.`, 'accent', 5000));
    bus.on('weather', (e) => {
      const w = this.el.hud.querySelector('#hud-weather');
      if (w) w.textContent = e.name;
    });
    bus.on('fell', () => this.toast('☁️ Into the void — respawning', 'danger'));
    bus.on('respawn', () => {});
    bus.on('quality', (e) => this.toast(`Graphics quality: ${e.level}`, '', 2500));
    bus.on('camera-mode', (e) => this.toast(`🎥 Camera: ${e.mode}`, '', 1800));
    bus.on('ai-finished', (e) => this.toast(`🏁 ${e.name} finished (${fmtTime(e.time)})`, '', 3000));
  }

  click() { this.game.bus.emit('ui-click', {}); }

  toast(html, kind = '', duration = 3200) {
    const node = el('div', `toast ${kind}`, html);
    this.el.toasts.appendChild(node);
    requestAnimationFrame(() => node.classList.add('show'));
    setTimeout(() => {
      node.classList.remove('show');
      setTimeout(() => node.remove(), 400);
    }, duration);
  }

  trickToast(html, kind = '') {
    const container = this.el.hud.querySelector('#hud-tricks');
    const node = el('div', `trick-toast ${kind}`, html);
    container.appendChild(node);
    while (container.children.length > 4) container.firstChild.remove();
    setTimeout(() => node.classList.add('fade'), 1400);
    setTimeout(() => node.remove(), 2100);
  }

  flashVignette() {
    const v = this.el.hud.querySelector('#vignette');
    v.classList.remove('flash');
    void v.offsetWidth;
    v.classList.add('flash');
  }

  /* ---------------- per-frame HUD update ---------------- */

  update(dt) {
    const game = this.game;
    const fpsEl = this.el.hud?.querySelector('#hud-fps');
    if (fpsEl) {
      const show = game.save.profile.settings.showFps;
      fpsEl.classList.toggle('hidden', !show);
      if (show) fpsEl.textContent = `${Math.round(game.profiler.fps)} FPS`;
    }

    if (game.state !== 'playing' || !game.session) return;
    const s = game.session;
    const mode = game.mode;
    const player = game.player;

    // Timer.
    const timerEl = this.el.hud.querySelector('#hud-timer');
    timerEl.textContent = mode.timeLimit > 0 ? fmtTime(s.timeLeft) : fmtTime(s.time);
    timerEl.classList.toggle('urgent', mode.timeLimit > 0 && s.timeLeft < 15);

    this.el.hud.querySelector('#hud-mode').textContent = `${mode.icon} ${mode.name}`;

    // Objective line.
    let objective = '';
    if (mode.checkpoints > 0) {
      objective = `Gate ${Math.min(s.checkpointIndex + 1, mode.checkpoints)} / ${mode.checkpoints}`;
      if (mode.race && s.position) objective += ` · P${s.position}`;
      if (s.ghostBestTime) objective += ` · Ghost ${fmtTime(s.ghostBestTime)}`;
    } else if (mode.avalanche) {
      objective = s.avalancheGap !== undefined
        ? `🌊 Avalanche ${Math.max(0, Math.round(s.avalancheGap))}m behind!` : '';
    } else if (mode.distanceScore) {
      objective = `${(s.distance / 1000).toFixed(2)} km`;
    } else if (mode.zen) {
      objective = '';
    } else {
      objective = `${(s.distance / 1000).toFixed(2)} km`;
    }
    this.el.hud.querySelector('#hud-objective').textContent = objective;

    // Score & combo.
    const scoreEl = this.el.hud.querySelector('#hud-score');
    scoreEl.textContent = mode.scoring ? fmtInt(s.score) : '';
    const comboEl = this.el.hud.querySelector('#hud-combo');
    if (player.comboCount > 1 && player.comboTimer > 0) {
      comboEl.classList.remove('hidden');
      const tricksCfg = game.config.tricks.scoring;
      const mult = Math.min(tricksCfg.comboMaxMultiplier,
        1 + (player.comboCount - 1) * tricksCfg.comboStepMultiplier);
      comboEl.querySelector('#hud-combo-mult').textContent = `x${mult.toFixed(2)}`;
      comboEl.querySelector('#hud-combo-score').textContent = fmtInt(player.comboScore);
      comboEl.style.opacity = Math.min(1, player.comboTimer / 1.5);
    } else {
      comboEl.classList.add('hidden');
    }

    // Speed / altitude / boost.
    this.el.hud.querySelector('#hud-speed').textContent = Math.round(player.speedKmh);
    this.el.hud.querySelector('#hud-alt').textContent =
      `⛰ ${Math.round(player.body.pos.y)} m · ${game.physics.surfaceParams(player.body.surface).name}`;
    this.el.hud.querySelector('#hud-boost').style.width =
      `${Math.round((s.boost / game.config.gameplay.boost.max) * 100)}%`;
    this.el.hud.querySelector('#hud-boost').classList.toggle('active', player.boosting);
    this.el.hud.querySelector('#speedlines').classList.toggle('active',
      player.boosting || player.speedKmh > 110);

    // Power bar cooldowns.
    if (this.powerChips) {
      for (const { chip, def, cd } of this.powerChips.values()) {
        const remaining = player.powerCooldowns[def.id] || 0;
        const ready = remaining <= 0;
        chip.classList.toggle('ready', ready);
        const active =
          (def.id === 'nitro' && player.effects.nitro > 0) ||
          (def.id === 'shield' && player.effects.shield > 0) ||
          (def.id === 'magnet' && player.effects.magnet > 0) ||
          (def.id === 'wingsuit' && player.effects.wingsuit > 0) ||
          (def.id === 'slowmo' && game.timeScale < 1);
        chip.classList.toggle('active', active);
        cd.textContent = ready ? '' : `${Math.ceil(remaining)}`;
        cd.style.height = ready ? '0%' : `${Math.min(100, (remaining / def.cooldown) * 100)}%`;
      }
    }

    // Active power-up indicators.
    const fx = player.effects;
    let puHtml = '';
    for (const [key, icon] of Object.entries(POWERUP_ICONS)) {
      if (key === 'time') continue;
      if (fx[key] > 0) {
        puHtml += `<span class="powerup-chip${fx[key] < 3 ? ' expiring' : ''}">${icon} ${Math.ceil(fx[key])}s</span>`;
      }
    }
    if (puHtml !== this.lastPowerupHtml) {
      this.lastPowerupHtml = puHtml;
      this.el.hud.querySelector('#hud-powerups').innerHTML = puHtml;
    }

    // Minimap (4x/sec).
    this.minimapTimer -= dt;
    if (this.minimapTimer <= 0) {
      this.minimapTimer = 0.25;
      this.drawMinimap();
    }
  }

  drawMinimap() {
    const ctx = this.minimapCtx;
    const game = this.game;
    const player = game.player;
    if (!ctx || !player.mesh) return;
    const size = 150, half = size / 2;
    const range = 260; // metres shown across the map
    const px = player.body.pos.x, pz = player.body.pos.z;
    // Screen-right is world -X (camera faces +Z), so mirror X to match.
    const toMap = (x, z) => [
      half - ((x - px) / range) * size,
      half - ((z - pz) / range) * size
    ];

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(8, 14, 26, 0.72)';
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.arc(half, half, half - 2, 0, Math.PI * 2);
    ctx.clip();

    // Terrain shading from loaded chunk heights.
    const step = 10;
    for (let my = 0; my < size; my += step) {
      for (let mx = 0; mx < size; mx += step) {
        const wx = px + ((mx + step / 2 - half) / size) * range;
        const wz = pz - ((my + step / 2 - half) / size) * range;
        const h = game.world.sampleHeightIfLoaded(wx, wz);
        if (h === null) continue;
        const rel = (h - player.body.pos.y) / 60;
        const l = Math.max(18, Math.min(80, 46 + rel * 40));
        ctx.fillStyle = `hsl(215, 35%, ${l}%)`;
        ctx.fillRect(mx, my, step, step);
      }
    }

    // Checkpoints.
    const s = game.session;
    if (s && game.world.checkpoints.length) {
      for (const cp of game.world.checkpoints) {
        if (cp.index < s.checkpointIndex) continue;
        const [mx, my] = toMap(cp.x, cp.z);
        ctx.fillStyle = cp.index === s.checkpointIndex ? '#ffd166' : 'rgba(255,255,255,0.5)';
        ctx.beginPath();
        ctx.arc(mx, my, cp.index === s.checkpointIndex ? 5 : 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Avalanche front.
    if (s && s.avalancheZ !== null && s.avalancheZ !== undefined) {
      const [, my] = toMap(px, s.avalancheZ);
      ctx.fillStyle = 'rgba(255, 80, 80, 0.35)';
      if (my < size) ctx.fillRect(0, Math.max(0, my), size, size - Math.max(0, my));
      ctx.fillStyle = 'rgba(255, 80, 80, 0.9)';
      ctx.fillRect(0, Math.max(0, Math.min(size - 3, my)), size, 3);
    }

    // AI riders.
    for (const r of game.ai.riders) {
      const [mx, my] = toMap(r.body.pos.x, r.body.pos.z);
      ctx.fillStyle = '#ff6b8a';
      ctx.beginPath();
      ctx.arc(mx, my, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Player arrow (up = +Z travel direction).
    ctx.translate(half, half);
    ctx.rotate(-player.body.heading);
    ctx.fillStyle = '#7fd4ff';
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 5);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/*
 * main.js — wires the DOM controls to the simulation and drives the frame loop.
 *
 * V2 architecture. There is exactly one notion of "running": `clock.running`.
 * This file holds no `playing` flag, and no component keeps its own timer.
 *
 * Each frame:
 *   1. Ask the Clock how much *simulated* time and how many whole rounds have
 *      elapsed. Paused ⇒ both are zero.
 *   2. Advance the simulation by that many rounds, and the dots by that much
 *      simulated time. Same number, same source, so they cannot drift.
 *   3. Repaint if anything changed, or if something asked for a repaint.
 *
 * Step 3 is deliberately separate from steps 1–2: the loop keeps running while
 * paused so that a resize or a theme change can repaint a frozen frame without
 * advancing it. "Frozen" is a property of the clock, never of the loop.
 *
 * V3 adds scenarios. Everything that varies between networks — nodes, edges,
 * routes, the free roads and their buttons, the chart's reference lines, the
 * legend and the walkthrough — is rebuilt from scenario data by `rebuild()`.
 * Switching network, changing N and pressing Reset all funnel through the same
 * synchronous `restart()`, because a half-swapped network is precisely the class
 * of desync this project already had to fix once.
 */

(() => {
  const { SCENARIOS, Graph, Simulation, Clock, NetworkView, ChartView, invalidatePalette, routeColor } =
    window.Braess;

  const el = {
    tabs: document.getElementById('tabs'),
    tagline: document.getElementById('tagline'),
    play: document.getElementById('play'),
    step: document.getElementById('step'),
    reset: document.getElementById('reset'),
    shortcutButtons: document.getElementById('shortcut-buttons'),
    speed: document.getElementById('speed'),
    speedValue: document.getElementById('speed-value'),
    population: document.getElementById('population'),
    populationValue: document.getElementById('population-value'),
    theme: document.getElementById('theme'),
    round: document.getElementById('round'),
    avgCost: document.getElementById('avg-cost'),
    badge: document.getElementById('eq-badge'),
    badgeText: document.getElementById('eq-text'),
    routeRows: document.getElementById('route-rows'),
    edgeLegend: document.getElementById('edge-legend'),
    scenarioNotes: document.getElementById('scenario-notes'),
  };

  // Every initial value is read from the DOM rather than duplicated here, so the
  // markup and the JS cannot disagree about what the controls start at.
  const graph = new Graph(SCENARIOS[0], Number(el.population.value));
  const sim = new Simulation(graph);
  const clock = new Clock({ speed: Number(el.speed.value) });
  const networkView = new NetworkView(document.getElementById('network'), graph, sim);
  const chartView = new ChartView(document.getElementById('chart'), graph, sim);

  let wasSettled = false;
  let needsDraw = true;
  let rows = []; // one per route, rebuilt when the scenario changes
  let roadButtons = []; // one per toggleable edge, likewise

  /** Ask for one repaint on the next frame. Safe to call while paused. */
  function requestDraw() {
    needsDraw = true;
  }

  // --- scenario tabs ---
  const tabs = SCENARIOS.map((scenario) => {
    const button = document.createElement('button');
    button.className = 'tab';
    button.textContent = scenario.name;
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => selectScenario(scenario));
    el.tabs.appendChild(button);
    return { scenario, button };
  });

  function selectScenario(scenario) {
    if (graph.scenario === scenario) return;
    // Pause before touching the topology: a frame landing mid-swap would render
    // the new network against the old population's route indices.
    setRunning(false);
    graph.load(scenario);
    rebuild();
    restart();
  }

  /**
   * Rebuild every piece of UI that is scenario-shaped. Idempotent, and safe to
   * call for the initial network as well as for a switch.
   */
  function rebuild() {
    const scenario = graph.scenario;

    for (const t of tabs) {
      const on = t.scenario === scenario;
      t.button.classList.toggle('active', on);
      t.button.setAttribute('aria-selected', String(on));
    }
    el.tagline.textContent = scenario.tagline;

    // --- one build/demolish button per free road ---
    el.shortcutButtons.innerHTML = '';
    roadButtons = graph.toggleableEdges().map(({ key, label }) => {
      const button = document.createElement('button');
      button.className = 'shortcut';
      button.dataset.edge = key;
      button.addEventListener('click', () => toggleRoad(key));
      el.shortcutButtons.appendChild(button);
      return { key, label, button };
    });

    // --- cost-function legend ---
    el.edgeLegend.innerHTML = '';
    for (const [key, e] of Object.entries(graph.edges)) {
      const li = document.createElement('li');
      const kind = e.congestible ? 'congestible' : e.toggleable ? 'free road' : 'fixed';
      li.innerHTML =
        `<strong>${e.from}→${e.to}</strong> = ${graph.edgeFormula(key)} <em>(${kind})</em>`;
      el.edgeLegend.appendChild(li);
    }

    // --- walkthrough ---
    el.scenarioNotes.innerHTML = '';
    for (const note of scenario.notes) {
      const li = document.createElement('li');
      li.innerHTML = note;
      el.scenarioNotes.appendChild(li);
    }

    // --- route table ---
    el.routeRows.innerHTML = '';
    rows = graph.routes.map((route) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><span class="swatch"></span>${route.name}</td>` +
        `<td class="num" data-count></td><td class="num" data-cost></td>`;
      el.routeRows.appendChild(tr);
      return {
        tr,
        swatch: tr.querySelector('.swatch'),
        count: tr.querySelector('[data-count]'),
        cost: tr.querySelector('[data-cost]'),
      };
    });
    paintSwatches();
  }

  /**
   * Series colours are per-theme, so the swatches are painted from the resolved
   * palette rather than baked into the row markup — otherwise a theme change
   * would leave the table showing the other theme's colours.
   */
  function paintSwatches() {
    rows.forEach((row, i) => {
      const color = routeColor(graph, i);
      row.swatch.style.background = color;
      row.swatch.style.color = color; // the swatch glow is currentColor
    });
  }

  function updateStats() {
    const costs = sim.routeCosts();
    el.round.textContent = sim.round;
    el.avgCost.textContent = sim.avgCost().toFixed(1);

    graph.routes.forEach((_, i) => {
      const active = graph.isRouteActive(i);
      rows[i].tr.classList.toggle('inactive', !active);
      rows[i].count.textContent = active ? sim.counts[i] : '—';
      rows[i].cost.textContent = active ? costs[i].toFixed(1) : '—';
    });

    const settled = sim.atEquilibrium();
    el.badge.classList.toggle('settled', settled);
    el.badgeText.textContent = settled
      ? 'Equilibrium — nobody wants to switch'
      : 'searching for equilibrium…';

    // Auto-pause the moment the system settles: it parks the chart on the
    // interesting picture instead of padding it with a flat line forever.
    // Only on the *transition* in, so pressing Play while already settled
    // (to show that nothing moves) still works.
    if (settled && !wasSettled && clock.running) setRunning(false);
    wasSettled = settled;
  }

  function syncControls() {
    // Every label is derived from the model, never tracked alongside it.
    el.play.textContent = clock.running ? '❚❚ Pause' : '▶ Play';
    el.play.setAttribute('aria-pressed', String(clock.running));
    for (const road of roadButtons) {
      const on = graph.enabled.has(road.key);
      road.button.classList.toggle('on', on);
      road.button.textContent = on ? `−  Remove ${road.label}` : `＋ Add ${road.label}`;
    }
    el.speedValue.textContent = clock.speed;
    el.populationValue.textContent = graph.population;
  }

  function setRunning(next) {
    if (next) clock.start();
    else clock.stop();
    syncControls();
    requestDraw();
  }

  /**
   * Full teardown to a cold start, used by Reset, by any change of N, and by a
   * scenario switch. The clock, the simulation and the dot arrays are rebuilt
   * together in one synchronous block — there is no frame in between for them to
   * disagree in.
   */
  function restart() {
    clock.reset();
    sim.reset();
    networkView.resetAgents();
    wasSettled = false;
    syncControls();
    updateStats();
    requestDraw();
  }

  function toggleRoad(key) {
    sim.toggleEdge(key);
    // Dots on a road that no longer exists snap to their fallback route now,
    // keeping their phase. Required while paused, where update() is a no-op.
    networkView.syncRoutes();
    wasSettled = false; // the equilibrium question is open again
    syncControls();
    updateStats();
    requestDraw();
  }

  el.play.addEventListener('click', () => setRunning(!clock.running));

  el.step.addEventListener('click', () => {
    // Credit exactly one round to the clock rather than calling sim.step()
    // directly: the round *and* the matching slice of dot motion are then
    // delivered by the normal frame path, so a step advances the picture the
    // same way playing does. V1 stepped the sim only and relied on the
    // runaway animation to make the dots catch up.
    setRunning(false);
    clock.step(1);
    requestDraw();
  });

  el.reset.addEventListener('click', restart);

  el.speed.addEventListener('input', () => {
    clock.speed = Number(el.speed.value);
    syncControls();
    requestDraw();
  });

  el.population.addEventListener('input', () => {
    // Changing N changes the game, so the run starts over. Pause first: leaving
    // the clock running across a reallocation would let a frame land between
    // graph.setPopulation() and sim.reset() on the arrays it invalidated.
    setRunning(false);
    graph.setPopulation(Number(el.population.value));
    rebuild(); // the legend quotes N in the congestible cost functions
    restart();
  });

  el.theme.addEventListener('change', () => applyTheme(el.theme.value));

  function applyTheme(value) {
    // 'auto' means "no override" — remove the attribute and let the
    // prefers-color-scheme media query decide.
    if (value === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
    el.theme.value = value;
    // The canvases paint with CSS variables they cache, and a paused canvas
    // gets no automatic repaint. Drop the cache and ask for one.
    invalidatePalette();
    paintSwatches();
    requestDraw();
  }

  // A theme flip while paused must still repaint, in auto mode too.
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    invalidatePalette();
    paintSwatches();
    requestDraw();
  });

  // Same for a resize: the canvas backing store is only refitted inside draw().
  const resizeObserver = new ResizeObserver(requestDraw);
  resizeObserver.observe(document.getElementById('network'));
  resizeObserver.observe(document.getElementById('chart'));

  function frame(now) {
    const { dt, rounds } = clock.tick(now);

    for (let i = 0; i < rounds; i++) sim.step();
    networkView.update(dt); // no-ops on dt === 0; that is what pause *is*

    if (dt > 0 || rounds > 0) {
      updateStats();
      requestDraw();
    }

    if (needsDraw) {
      needsDraw = false;
      networkView.draw();
      chartView.draw();
    }

    requestAnimationFrame(frame);
  }

  applyTheme(el.theme.value);
  rebuild();
  syncControls();
  updateStats();
  requestAnimationFrame(frame);

  /*
   * Test surface. The headless checks in tests/ drive the app through exactly
   * the state the UI does — no private copies, no separate code path — so a
   * passing test says something about the real thing.
   */
  window.Braess.app = {
    graph,
    sim,
    clock,
    networkView,
    chartView,
    setRunning,
    restart,
    applyTheme,
    selectScenario,
    scenarios: SCENARIOS,
    selectScenarioById: (id) => selectScenario(SCENARIOS.find((s) => s.id === id)),
    isRunning: () => clock.running,
    dotPositions: () => networkView.dotPositions(),
    snapshot: () => ({
      scenario: graph.scenario.id,
      running: clock.running,
      round: sim.round,
      simTime: clock.simTime,
      avgCost: sim.avgCost(),
      counts: Array.from(sim.counts),
      enabled: Array.from(graph.enabled),
      flows: graph.edgeFlows(sim.counts),
      historyLength: sim.history.length,
      settled: sim.atEquilibrium(),
      dots: networkView.dotPositions(),
    }),
  };
})();

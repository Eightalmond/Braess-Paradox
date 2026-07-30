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
 */

(() => {
  const { Graph, Simulation, Clock, NetworkView, ChartView, ROUTE_COLORS, invalidatePalette } =
    window.Braess;

  const el = {
    play: document.getElementById('play'),
    step: document.getElementById('step'),
    reset: document.getElementById('reset'),
    shortcut: document.getElementById('shortcut'),
    speed: document.getElementById('speed'),
    speedValue: document.getElementById('speed-value'),
    population: document.getElementById('population'),
    populationValue: document.getElementById('population-value'),
    theme: document.getElementById('theme'),
    round: document.getElementById('round'),
    avgCost: document.getElementById('avg-cost'),
    badge: document.getElementById('eq-badge'),
    routeRows: document.getElementById('route-rows'),
    edgeLegend: document.getElementById('edge-legend'),
  };

  // Every initial value is read from the DOM rather than duplicated here, so the
  // markup and the JS cannot disagree about what the controls start at.
  const graph = new Graph(Number(el.population.value));
  const sim = new Simulation(graph);
  const clock = new Clock({ speed: Number(el.speed.value) });
  const networkView = new NetworkView(document.getElementById('network'), graph, sim);
  const chartView = new ChartView(document.getElementById('chart'), graph, sim);

  let wasSettled = false;
  let needsDraw = true;

  /** Ask for one repaint on the next frame. Safe to call while paused. */
  function requestDraw() {
    needsDraw = true;
  }

  // --- static legend of the cost functions (rebuilt when N changes) ---
  function buildEdgeLegend() {
    el.edgeLegend.innerHTML = '';
    for (const [key, e] of Object.entries(graph.edges)) {
      const li = document.createElement('li');
      const label = `${e.from}→${e.to}`;
      const kind = e.congestible ? 'congestible' : e.shortcut ? 'shortcut' : 'fixed';
      li.innerHTML = `<strong>${label}</strong> = ${graph.edgeFormula(key)} <em>(${kind})</em>`;
      el.edgeLegend.appendChild(li);
    }
  }

  // --- route table skeleton, built once ---
  const rows = graph.routes.map((route, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><span class="swatch" style="background:${ROUTE_COLORS[i]}"></span>${route.name}</td>` +
      `<td class="num" data-count></td><td class="num" data-cost></td>`;
    el.routeRows.appendChild(tr);
    return { tr, count: tr.querySelector('[data-count]'), cost: tr.querySelector('[data-cost]') };
  });

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
    el.badge.textContent = settled
      ? '✓ Equilibrium — nobody wants to switch'
      : 'searching for equilibrium…';

    // Auto-pause the moment the system settles: it parks the chart on the
    // interesting picture instead of padding it with a flat line forever.
    // Only on the *transition* in, so pressing Play while already settled
    // (to show that nothing moves) still works.
    if (settled && !wasSettled && clock.running) setRunning(false);
    wasSettled = settled;
  }

  function syncControls() {
    // The button label is derived from the clock, never tracked alongside it.
    el.play.textContent = clock.running ? '❚❚ Pause' : '▶ Play';
    el.play.setAttribute('aria-pressed', String(clock.running));
    const on = graph.shortcutEnabled;
    el.shortcut.classList.toggle('on', on);
    el.shortcut.textContent = on ? '−  Remove shortcut A→B' : '＋ Add shortcut A→B';
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
   * Full teardown to a cold start, used by Reset and by any change of N.
   * The clock, the simulation and the dot arrays are rebuilt together in one
   * synchronous block — there is no frame in between for them to disagree in.
   */
  function restart() {
    clock.reset();
    sim.reset();
    networkView.resetAgents();
    wasSettled = false;
    buildEdgeLegend();
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

  el.shortcut.addEventListener('click', () => {
    sim.toggleShortcut();
    // Dots on a road that no longer exists snap to their fallback route now,
    // keeping their phase. Required while paused, where update() is a no-op.
    networkView.syncRoutes();
    wasSettled = false; // the equilibrium question is open again
    syncControls();
    updateStats();
    requestDraw();
  });

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
    restart();
  });

  el.theme.addEventListener('change', () => {
    applyTheme(el.theme.value);
  });

  function applyTheme(value) {
    // 'auto' means "no override" — remove the attribute and let the
    // prefers-color-scheme media query decide.
    if (value === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = value;
    el.theme.value = value;
    // The canvases paint with CSS variables they cache, and a paused canvas
    // gets no automatic repaint. Drop the cache and ask for one.
    invalidatePalette();
    requestDraw();
  }

  // A theme flip while paused must still repaint, in auto mode too.
  const schemeQuery = window.matchMedia('(prefers-color-scheme: light)');
  schemeQuery.addEventListener('change', () => {
    invalidatePalette();
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
  buildEdgeLegend();
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
    isRunning: () => clock.running,
    dotPositions: () => networkView.dotPositions(),
    snapshot: () => ({
      running: clock.running,
      round: sim.round,
      simTime: clock.simTime,
      avgCost: sim.avgCost(),
      counts: Array.from(sim.counts),
      historyLength: sim.history.length,
      settled: sim.atEquilibrium(),
      dots: networkView.dotPositions(),
    }),
  };
})();

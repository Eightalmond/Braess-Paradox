/*
 * main.js — wires the DOM controls to the simulation and drives the render loop.
 *
 * Two clocks run independently: discrete best-response rounds tick at the rate
 * set by the slider, while the dot animation runs every frame off wall time.
 */

(() => {
  const { Graph, Simulation, NetworkView, ChartView, ROUTE_COLORS } = window.Braess;

  // 100 drivers: one visible dot each (no sampling), clean 50/50 equilibrium
  // counts, and dots stay individually distinguishable even when all 100 pile
  // onto the shortcut route.
  const POPULATION = 100;

  const graph = new Graph(POPULATION);
  const sim = new Simulation(graph);
  const networkView = new NetworkView(document.getElementById('network'), graph, sim);
  const chartView = new ChartView(document.getElementById('chart'), graph, sim);

  const el = {
    play: document.getElementById('play'),
    step: document.getElementById('step'),
    reset: document.getElementById('reset'),
    shortcut: document.getElementById('shortcut'),
    speed: document.getElementById('speed'),
    speedValue: document.getElementById('speed-value'),
    round: document.getElementById('round'),
    avgCost: document.getElementById('avg-cost'),
    badge: document.getElementById('eq-badge'),
    routeRows: document.getElementById('route-rows'),
    edgeLegend: document.getElementById('edge-legend'),
  };

  let playing = false;
  let wasSettled = false;
  let roundsPerSecond = Number(el.speed.value);
  let roundAccumulator = 0;
  let lastFrame = performance.now();

  // --- static legend of the cost functions ---
  for (const [key, e] of Object.entries(graph.edges)) {
    const li = document.createElement('li');
    const label = `${e.from}→${e.to}`;
    const kind = e.congestible ? 'congestible' : e.shortcut ? 'shortcut' : 'fixed';
    li.innerHTML = `<strong>${label}</strong> = ${graph.edgeFormula(key)} <em>(${kind})</em>`;
    el.edgeLegend.appendChild(li);
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
    if (settled && !wasSettled && playing) setPlaying(false);
    wasSettled = settled;
  }

  function setShortcutButton() {
    const on = graph.shortcutEnabled;
    el.shortcut.classList.toggle('on', on);
    el.shortcut.textContent = on ? '−  Remove shortcut A→B' : '＋ Add shortcut A→B';
  }

  function setPlaying(next) {
    playing = next;
    el.play.textContent = playing ? '❚❚ Pause' : '▶ Play';
  }

  el.play.addEventListener('click', () => setPlaying(!playing));

  el.step.addEventListener('click', () => {
    setPlaying(false);
    sim.step();
    updateStats();
  });

  el.reset.addEventListener('click', () => {
    setPlaying(false);
    sim.reset();
    networkView.resetAgents();
    setShortcutButton();
    updateStats();
  });

  el.shortcut.addEventListener('click', () => {
    sim.toggleShortcut();
    setShortcutButton();
    updateStats();
  });

  el.speed.addEventListener('input', () => {
    roundsPerSecond = Number(el.speed.value);
    el.speedValue.textContent = roundsPerSecond;
  });

  function frame(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000); // clamp after tab switches
    lastFrame = now;

    if (playing) {
      roundAccumulator += dt * roundsPerSecond;
      let budget = 20; // never block a frame on a huge backlog of rounds
      while (roundAccumulator >= 1 && budget-- > 0) {
        roundAccumulator -= 1;
        sim.step();
      }
      updateStats();
    }

    networkView.update(dt);
    networkView.draw();
    chartView.draw();
    requestAnimationFrame(frame);
  }

  setShortcutButton();
  updateStats();
  requestAnimationFrame(frame);
})();

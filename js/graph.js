/*
 * graph.js — the road network model.
 *
 * A Graph is a loaded scenario (see scenarios.js) plus the runtime state that
 * goes with it: which toggleable roads currently exist, and how the congestion
 * coefficients scale to the current population.
 *
 * Edge travel time is affine in its load: cost(x) = base + coeff * x.
 *
 * The textbook Braess version uses 4000 cars with cost x/100 on the congestible
 * edges, giving 65 min per driver without the shortcut and 80 with it. We want
 * those same headline numbers for whatever population size animates nicely, so
 * each congestible edge's coefficient is normalized as congestionAtFull / N.
 * Then, in the classic network:
 *   - no shortcut, 50/50 split:  CONGESTION_AT_FULL/2 + CONSTANT_COST = 65
 *   - shortcut, everyone on it:  2 * CONGESTION_AT_FULL              = 80
 *
 * Two invariants callers must respect, both because they resize or reshape the
 * per-agent arrays that Simulation and NetworkView own:
 *   - after `load()`, call `sim.reset()` and `view.resetAgents()`
 *   - after `setPopulation()`, the same
 * main.js does both through a single synchronous `restart()`.
 */

class Graph {
  constructor(scenario, population) {
    this.load(scenario, population);
  }

  /** Swap in a different network. Discards all toggle state. */
  load(scenario, population = this.population) {
    this.scenario = scenario;
    this.nodes = scenario.nodes;
    // Deep-ish copy of the edges: `coeff` is per-population runtime state, and a
    // scenario object must stay reusable after being loaded and unloaded.
    this.edges = {};
    for (const [key, e] of Object.entries(scenario.edges)) {
      this.edges[key] = { ...e, coeff: 0 };
    }
    this.routes = scenario.routes;
    this.enabled = new Set(); // toggleable edges that currently exist
    this.setPopulation(population);
  }

  /**
   * Resize the population. Congestion coefficients are renormalized so the
   * scenario's analytical equilibria hold at any N — N changes how granular the
   * game is, never what it converges to.
   */
  setPopulation(population) {
    this.population = population;
    for (const e of Object.values(this.edges)) {
      if (e.congestible) e.coeff = e.congestionAtFull / population;
    }
  }

  /** Remove every toggleable road, i.e. back to the base network. */
  resetToggles() {
    this.enabled.clear();
  }

  /** The toggleable edges, in scenario order — one button each in the UI. */
  toggleableEdges() {
    return Object.entries(this.edges)
      .filter(([, e]) => e.toggleable)
      .map(([key, e]) => ({ key, label: e.label || `${e.from}→${e.to}` }));
  }

  isEdgeEnabled(key) {
    const e = this.edges[key];
    return !e.toggleable || this.enabled.has(key);
  }

  toggleEdge(key) {
    if (this.enabled.has(key)) this.enabled.delete(key);
    else this.enabled.add(key);
    return this.enabled.has(key);
  }

  /** A route exists only while every toggleable road it needs exists. */
  isRouteActive(i) {
    const requires = this.routes[i].requires;
    if (!requires) return true;
    return requires.every((key) => this.enabled.has(key));
  }

  /** Indices into this.routes that agents are currently allowed to use. */
  activeRouteIndices() {
    const active = [];
    for (let i = 0; i < this.routes.length; i++) {
      if (this.isRouteActive(i)) active.push(i);
    }
    return active;
  }

  /** Per-edge load implied by a per-route agent count. */
  edgeFlows(routeCounts) {
    const flows = {};
    for (const key of Object.keys(this.edges)) flows[key] = 0;
    for (let i = 0; i < this.routes.length; i++) {
      const n = routeCounts[i];
      if (!n) continue;
      for (const key of this.routes[i].edges) flows[key] += n;
    }
    return flows;
  }

  edgeCost(key, flow) {
    const e = this.edges[key];
    return e.base + e.coeff * flow;
  }

  /** Travel time along a route given the current per-route agent counts. */
  routeCost(routeIndex, routeCounts) {
    const flows = this.edgeFlows(routeCounts);
    let total = 0;
    for (const key of this.routes[routeIndex].edges) {
      total += this.edgeCost(key, flows[key]);
    }
    return total;
  }

  /** Analytical equilibrium costs, for reference lines on the chart. */
  get theory() {
    return this.scenario.theory;
  }

  /** Human-readable cost function, e.g. "45" or "40 · (load / 100)". */
  edgeFormula(key) {
    const e = this.edges[key];
    if (e.congestible) return `${e.congestionAtFull} · (load / ${this.population})`;
    return `${e.base}`;
  }
}

window.Braess = window.Braess || {};
window.Braess.Graph = Graph;

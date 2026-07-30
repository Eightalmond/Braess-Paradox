/*
 * graph.js — the road network model.
 *
 * Classic Braess network:
 *
 *            A
 *          /   \
 *   c*x  /       \  45
 *      /           \
 *     S ---(A→B)--- T        (A→B is the "shortcut", cost 0, toggleable)
 *      \           /
 *   45   \       /  c*x
 *          \   /
 *            B
 *
 * Edge travel time is affine in its load: cost(x) = base + coeff * x.
 *
 * The textbook version uses 4000 cars with cost x/100 on the congestible
 * edges, giving 65 min per driver without the shortcut and 80 with it. We want
 * those same headline numbers for whatever population size animates nicely, so
 * the congestion coefficient is normalized as coeff = CONGESTION_AT_FULL / N.
 * Then:
 *   - no shortcut, 50/50 split:  CONGESTION_AT_FULL/2 + CONSTANT_COST = 65
 *   - shortcut, everyone on it:  2 * CONGESTION_AT_FULL              = 80
 */

const CONSTANT_COST = 45; // travel time of the two fixed-cost edges
const CONGESTION_AT_FULL = 40; // travel time of a congestible edge at full load

const NODES = {
  S: { x: 0.07, y: 0.5 },
  A: { x: 0.5, y: 0.16 },
  B: { x: 0.5, y: 0.84 },
  T: { x: 0.93, y: 0.5 },
};

const ROUTE_DEFS = [
  { id: 'R1', name: 'S→A→T', edges: ['SA', 'AT'], path: ['S', 'A', 'T'] },
  { id: 'R2', name: 'S→B→T', edges: ['SB', 'BT'], path: ['S', 'B', 'T'] },
  {
    id: 'R3',
    name: 'S→A→B→T',
    edges: ['SA', 'AB', 'BT'],
    path: ['S', 'A', 'B', 'T'],
    needsShortcut: true,
  },
];

class Graph {
  constructor(population) {
    const coeff = CONGESTION_AT_FULL / population;
    this.population = population;
    this.shortcutEnabled = false;

    this.edges = {
      SA: { from: 'S', to: 'A', base: 0, coeff, congestible: true },
      AT: { from: 'A', to: 'T', base: CONSTANT_COST, coeff: 0, congestible: false },
      SB: { from: 'S', to: 'B', base: CONSTANT_COST, coeff: 0, congestible: false },
      BT: { from: 'B', to: 'T', base: 0, coeff, congestible: true },
      AB: { from: 'A', to: 'B', base: 0, coeff: 0, congestible: false, shortcut: true },
    };

    this.routes = ROUTE_DEFS;
  }

  /** Indices into this.routes that agents are currently allowed to use. */
  activeRouteIndices() {
    const active = [];
    for (let i = 0; i < this.routes.length; i++) {
      if (!this.routes[i].needsShortcut || this.shortcutEnabled) active.push(i);
    }
    return active;
  }

  isRouteActive(i) {
    return !this.routes[i].needsShortcut || this.shortcutEnabled;
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
    return {
      without: CONSTANT_COST + CONGESTION_AT_FULL / 2, // 65
      with: 2 * CONGESTION_AT_FULL, // 80
    };
  }

  /** Human-readable cost function, e.g. "45" or "x / 100 (0 → 40)". */
  edgeFormula(key) {
    const e = this.edges[key];
    if (e.congestible) return `${CONGESTION_AT_FULL} · (load / ${this.population})`;
    return `${e.base}`;
  }
}

window.Braess = window.Braess || {};
window.Braess.Graph = Graph;
window.Braess.NODES = NODES;

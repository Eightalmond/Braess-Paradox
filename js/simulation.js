/*
 * simulation.js — a population of selfish agents finding equilibrium by
 * repeated best response.
 *
 * Each round we sample a small batch of agents. Each sampled agent asks:
 * "given where everybody else is driving right now, which route would be
 * fastest *for me*?" and moves there if it beats its current route. Note the
 * agent excludes itself from the current load before adding itself to the
 * candidate route — that is what makes this a genuine best response in an
 * atomic game, and it keeps the process from thrashing around a near-tie.
 *
 * Repeat until nobody wants to move: that fixed point is the Nash equilibrium
 * (the discrete analogue of a Wardrop traffic equilibrium).
 */

const EPS = 1e-9;

class Simulation {
  constructor(graph, { switchFraction = 0.03 } = {}) {
    this.graph = graph;
    this.switchFraction = switchFraction;
    this.reset();
  }

  reset() {
    const N = this.graph.population;
    this.graph.shortcutEnabled = false;
    // Start everybody on route 1 so convergence is visible rather than instant.
    this.agents = new Int8Array(N); // agents[i] = route index
    this.counts = this.graph.routes.map((_, i) => (i === 0 ? N : 0));
    this.round = 0;
    this.history = []; // { round, avgCost, counts, shortcut }
    this.shortcutToggles = []; // rounds at which the shortcut was toggled
    this.record(0);
  }

  /**
   * Travel time this agent would experience on `candidate`, given that all the
   * *other* agents keep their current route.
   */
  perceivedCost(candidate, currentRoute) {
    const counts = this.counts.slice();
    counts[currentRoute] -= 1;
    counts[candidate] += 1;
    return this.graph.routeCost(candidate, counts);
  }

  /** Run one round of best-response updates. Returns the number of switches. */
  step() {
    const active = this.graph.activeRouteIndices();
    const batch = Math.max(1, Math.round(this.graph.population * this.switchFraction));
    let switches = 0;

    for (let k = 0; k < batch; k++) {
      const i = Math.floor(Math.random() * this.graph.population);
      const current = this.agents[i];

      let bestRoute = current;
      let bestCost = this.perceivedCost(current, current);

      for (const r of active) {
        if (r === current) continue;
        const cost = this.perceivedCost(r, current);
        if (cost < bestCost - EPS) {
          bestCost = cost;
          bestRoute = r;
        }
      }

      if (bestRoute !== current) {
        this.agents[i] = bestRoute;
        this.counts[current] -= 1;
        this.counts[bestRoute] += 1;
        switches++;
      }
    }

    this.round++;
    this.record(switches);
    return switches;
  }

  /** Average travel time across the whole population. */
  avgCost() {
    let total = 0;
    for (let i = 0; i < this.counts.length; i++) {
      if (this.counts[i]) total += this.counts[i] * this.graph.routeCost(i, this.counts);
    }
    return total / this.graph.population;
  }

  routeCosts() {
    return this.graph.routes.map((_, i) =>
      this.graph.isRouteActive(i) ? this.graph.routeCost(i, this.counts) : null
    );
  }

  /**
   * True when no agent has a profitable unilateral deviation. Agents on the
   * same route are interchangeable, so it is enough to test one representative
   * per occupied route.
   */
  atEquilibrium() {
    const active = this.graph.activeRouteIndices();
    for (let r = 0; r < this.counts.length; r++) {
      if (!this.counts[r]) continue;
      const stay = this.perceivedCost(r, r);
      for (const alt of active) {
        if (alt === r) continue;
        if (this.perceivedCost(alt, r) < stay - 1e-6) return false;
      }
    }
    return true;
  }

  toggleShortcut() {
    this.graph.shortcutEnabled = !this.graph.shortcutEnabled;

    if (!this.graph.shortcutEnabled) {
      // The road closed under them. Stranded agents all fall back to the first
      // remaining route — deliberately *not* a balanced split, so you can watch
      // best response find the new equilibrium instead of being handed it.
      const shortcutRoute = this.graph.routes.findIndex((r) => r.needsShortcut);
      const fallback = this.graph.activeRouteIndices()[0];
      for (let i = 0; i < this.agents.length; i++) {
        if (this.agents[i] !== shortcutRoute) continue;
        this.agents[i] = fallback;
        this.counts[shortcutRoute] -= 1;
        this.counts[fallback] += 1;
      }
    }

    this.shortcutToggles.push({ round: this.round, enabled: this.graph.shortcutEnabled });
    this.record(0);
  }

  record(switches) {
    this.history.push({
      round: this.round,
      avgCost: this.avgCost(),
      counts: this.counts.slice(),
      shortcut: this.graph.shortcutEnabled,
      switches,
    });
  }
}

window.Braess = window.Braess || {};
window.Braess.Simulation = Simulation;

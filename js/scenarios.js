/*
 * scenarios.js — the networks the simulator can load.
 *
 * A scenario is pure data: nodes with normalized positions, edges with affine
 * cost functions, the enumerated S→T routes, and the analytical equilibria to
 * draw as reference lines. `Graph` consumes one of these; nothing about a
 * particular network is hardcoded anywhere else.
 *
 * Two conventions the rest of the app relies on:
 *
 *   - A congestible edge declares `congestionAtFull`, its travel time when the
 *     entire population is on it. The per-car coefficient is derived as
 *     `congestionAtFull / N`, which is what keeps the headline numbers fixed as
 *     the population slider moves.
 *   - A `toggleable` edge is a road that can be built and demolished at runtime.
 *     Routes list the toggleable edges they depend on in `requires`, and a route
 *     is available only while all of them are enabled. There may be any number
 *     of toggleable edges; the classic network just happens to have one.
 */

const CONSTANT_COST = 45; // travel time of a fixed-cost edge
const CONGESTION_AT_FULL = 40; // travel time of a congestible edge at full load

/*
 * Series palette.
 *
 * Route identity is a *categorical* encoding, so hues are assigned in fixed order
 * and never cycled, and each theme gets its own steps rather than an automatic
 * flip — the V3 palette's pale tints (#e0bcff, #ffd9a8) were nearly invisible on
 * a light surface. Both trios are validated with the dataviz palette checker
 * under `--pairs all`: lightness band, chroma floor, all-pairs CVD separation
 * (worst 8.3 ΔE tritan), normal-vision floor (worst 17.4) and contrast ≥3:1.
 *
 * The old blue/amber/violet set failed that check badly — violet↔blue came out at
 * ΔE 0.4 under deuteranopia and 13.1 in normal vision, and those are exactly R1
 * and R3, the two routes you watch drivers migrate between. Pink replaces violet.
 *
 * The double network needs nine series, which is past the point where new hues
 * should be invented. It uses composite encoding instead: hue carries the
 * first-stage choice and lightness the second, so the three hues stay the
 * validated categorical trio and each hue's three steps form a within-hue ordinal
 * ramp (also validated, monotone in L with adequate step separation). The route
 * table direct-labels every route, so identity is never colour-alone.
 */
const SERIES = {
  blue: { dark: ['#326ecf', '#5090f7', '#8cb5fa'], light: ['#608ef0', '#2765eb', '#1b49ad'] },
  amber: { dark: ['#9b6507', '#c78009', '#dbac5b'], light: ['#d67506', '#a75b05', '#794303'] },
  pink: { dark: ['#b93978', '#ec4b9b', '#f390c1'], light: ['#e35a97', '#c7236c', '#921a4f'] },
};

/** The nth step of a hue, as a per-theme pair the renderer resolves at draw time. */
const step = (hue, i) => ({ dark: SERIES[hue].dark[i], light: SERIES[hue].light[i] });

// Chart reference-line colours. These are annotations rather than series, so they
// wear a muted ink in the label and carry only a coloured dash.
const BEFORE_COLOR = { dark: '#34d399', light: '#047857' };
const AFTER_COLOR = { dark: '#f472b6', light: '#be185d' };
const MID_COLOR = { dark: '#fbbf24', light: '#b45309' };

const fixed = (from, to) => ({ from, to, base: CONSTANT_COST });
const congestible = (from, to) => ({
  from,
  to,
  base: 0,
  congestible: true,
  congestionAtFull: CONGESTION_AT_FULL,
});
// Every free road wears the same colour, whichever routes happen to use it. It
// borrowed the colour of the first route requiring it until V4, which made the
// double network's two identical roads render in different hues.
const FREE_ROAD_COLOR = { dark: '#ec4b9b', light: '#c7236c' };
const freeRoad = (from, to) => ({ from, to, base: 0, toggleable: true, color: FREE_ROAD_COLOR });

/* ------------------------------------------------------------------ classic */

/*
 *            A
 *          /   \
 *   40x/N /     \ 45
 *        S  ⋮AB⋮  T
 *    45   \     / 40x/N
 *            B
 */
const CLASSIC = {
  id: 'classic',
  name: 'Classic Braess',
  tagline: 'Four roads, one free shortcut, and 23% more travel time.',
  nodes: {
    S: { x: 0.07, y: 0.5 },
    A: { x: 0.5, y: 0.16 },
    B: { x: 0.5, y: 0.84 },
    T: { x: 0.93, y: 0.5 },
  },
  edges: {
    SA: congestible('S', 'A'),
    AT: fixed('A', 'T'),
    SB: fixed('S', 'B'),
    BT: congestible('B', 'T'),
    AB: { ...freeRoad('A', 'B'), label: 'shortcut A→B' },
  },
  routes: [
    // Lanes pinned so the shortcut route runs down the centre of the vertical
    // A→B road rather than beside it.
    { id: 'R1', name: 'S→A→T', edges: ['SA', 'AT'], path: ['S', 'A', 'T'], color: step('blue', 1), offset: -7 },
    { id: 'R2', name: 'S→B→T', edges: ['SB', 'BT'], path: ['S', 'B', 'T'], color: step('amber', 1), offset: 7 },
    {
      id: 'R3',
      name: 'S→A→B→T',
      edges: ['SA', 'AB', 'BT'],
      path: ['S', 'A', 'B', 'T'],
      requires: ['AB'],
      color: step('pink', 1),
      offset: 0,
    },
  ],
  theory: [
    { value: CONSTANT_COST + CONGESTION_AT_FULL / 2, label: 'no shortcut', color: BEFORE_COLOR },
    { value: 2 * CONGESTION_AT_FULL, label: 'with shortcut', color: AFTER_COLOR },
  ],
  notes: [
    'Drivers spread out until <strong>S→A→T</strong> and <strong>S→B→T</strong> tie at <strong>65</strong>.',
    'Add the free <strong>A→B</strong> shortcut. It skips both 45-cost roads, so it looks like a bargain and everyone takes it.',
    'It settles at <strong>80</strong>. The other routes now cost 85, so nobody can profitably leave — and every driver is worse off than before the road was built.',
  ],
};

/* ------------------------------------------------------------------- double */

/*
 * Two Braess gadgets in series. Each half behaves exactly like the classic
 * network, and the two free roads can be built independently:
 *
 *        A1            A2
 *       /   \         /   \
 *      S  ⋮  M  ⋮  T      (⋮ = a free road, A1→B1 and A2→B2)
 *       \   /         \   /
 *        B1            B2
 *
 * Each stage costs 65 with its roads split 50/50 and 80 once everybody piles
 * onto its shortcut, so the whole trip runs 130 → 145 → 160 as the two free
 * roads are added. The point of this network is that the damage *compounds*:
 * each new free road costs every driver another 15 minutes.
 *
 * A driver's route is a choice of half-trip in each stage, so the three options
 * per stage multiply out to nine S→T routes. That also means the equilibrium is
 * unique in edge flows but not in route counts: with no shortcuts, any mix that
 * leaves each congestible edge at half load costs exactly 130.
 */
const STAGE_OPTIONS = [
  { key: 'A', mid: 'A', label: (s) => `A${s}` },
  { key: 'B', mid: 'B', label: (s) => `B${s}` },
  { key: 'X', mid: null, label: (s) => `A${s}→B${s}` },
];

// Hue carries the first-stage choice, lightness the second, so a glance at the
// dots tells you which half of the trip a driver is arguing about.
const DOUBLE_HUES = { A: 'blue', B: 'amber', X: 'pink' };

function doubleRoutes() {
  const routes = [];
  STAGE_OPTIONS.forEach((first, fi) => {
    STAGE_OPTIONS.forEach((second, si) => {
      const legs = [
        { opt: first, a: 'A1', b: 'B1', from: 'S', to: 'M', n: 1 },
        { opt: second, a: 'A2', b: 'B2', from: 'M', to: 'T', n: 2 },
      ];
      const edges = [];
      const path = ['S'];
      const requires = [];
      for (const leg of legs) {
        if (leg.opt.key === 'A') {
          edges.push(`${leg.from}${leg.a}`, `${leg.a}${leg.to}`);
          path.push(leg.a, leg.to);
        } else if (leg.opt.key === 'B') {
          edges.push(`${leg.from}${leg.b}`, `${leg.b}${leg.to}`);
          path.push(leg.b, leg.to);
        } else {
          edges.push(`${leg.from}${leg.a}`, `${leg.a}${leg.b}`, `${leg.b}${leg.to}`);
          path.push(leg.a, leg.b, leg.to);
          requires.push(`${leg.a}${leg.b}`);
        }
      }
      routes.push({
        id: `R${fi * 3 + si + 1}`,
        name: `${first.label(1)} · ${second.label(2)}`,
        edges,
        path,
        requires,
        color: step(DOUBLE_HUES[first.key], si),
      });
    });
  });
  return routes;
}

const DOUBLE = {
  id: 'double',
  name: 'Double Braess',
  tagline: 'Two free roads, two paradoxes, and the damage compounds: 130 → 160.',
  nodes: {
    S: { x: 0.03, y: 0.5 },
    A1: { x: 0.26, y: 0.14 },
    B1: { x: 0.26, y: 0.86 },
    M: { x: 0.5, y: 0.5 },
    A2: { x: 0.74, y: 0.14 },
    B2: { x: 0.74, y: 0.86 },
    T: { x: 0.97, y: 0.5 },
  },
  edges: {
    SA1: congestible('S', 'A1'),
    A1M: fixed('A1', 'M'),
    SB1: fixed('S', 'B1'),
    B1M: congestible('B1', 'M'),
    A1B1: { ...freeRoad('A1', 'B1'), label: 'shortcut A1→B1' },
    MA2: congestible('M', 'A2'),
    A2T: fixed('A2', 'T'),
    MB2: fixed('M', 'B2'),
    B2T: congestible('B2', 'T'),
    A2B2: { ...freeRoad('A2', 'B2'), label: 'shortcut A2→B2' },
  },
  routes: doubleRoutes(),
  theory: [
    { value: 2 * (CONSTANT_COST + CONGESTION_AT_FULL / 2), label: 'no shortcuts', color: BEFORE_COLOR },
    {
      value: CONSTANT_COST + CONGESTION_AT_FULL / 2 + 2 * CONGESTION_AT_FULL,
      label: 'one shortcut',
      color: MID_COLOR,
    },
    { value: 4 * CONGESTION_AT_FULL, label: 'both shortcuts', color: AFTER_COLOR },
  ],
  notes: [
    'Each half of the trip is its own Braess network. With no shortcuts both halves split 50/50 and cost 65 each — <strong>130</strong> door to door.',
    'Add <strong>one</strong> free road. That half collapses onto the shortcut at 80 while the other still costs 65: <strong>145</strong>.',
    'Add the second. Now both halves cost 80 — <strong>160</strong>. Every free road you build costs every driver another 15 minutes, and each one is individually irresistible on the way in.',
  ],
};

window.Braess = window.Braess || {};
window.Braess.SCENARIOS = [CLASSIC, DOUBLE];
window.Braess.CONSTANT_COST = CONSTANT_COST;
window.Braess.CONGESTION_AT_FULL = CONGESTION_AT_FULL;

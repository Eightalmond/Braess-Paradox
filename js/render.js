/*
 * render.js — canvas drawing.
 *
 * NetworkView draws the road network (edge width/colour keyed to congestion)
 * plus animated dots driving their routes. Dots move slower on slower routes,
 * and an agent only adopts its newly chosen route once it finishes the trip it
 * is on — so the picture stays readable while the simulation churns.
 *
 * ChartView draws average travel time per round with markers where a road was
 * built or demolished. That chart is the punchline: adding a free road makes the
 * line jump *up*.
 *
 * Three rules hold throughout this file:
 *
 *   - Nothing here reads wall time. `update(simDt)` is handed simulated seconds
 *     by the Clock and is the only method that mutates animation state; a paused
 *     clock delivers 0 and the dots therefore hold position exactly. Nothing is
 *     animated by the *renderer* either — every glow is static — so a paused
 *     frame is genuinely still rather than merely slow.
 *   - `draw()` is pure output and idempotent. It may be called any number of
 *     times while paused — which is what lets a resize or a theme change
 *     repaint a frozen frame without advancing it.
 *   - Every colour comes from CSS, resolved once per theme. `--scheme` names the
 *     live theme so the series palette has a single authority (the stylesheet)
 *     rather than a second copy of that decision in JS.
 */

const CHART_WINDOW = 800; // rounds visible in the sliding chart window
// Total perpendicular spread of the dot lanes, in pixels. Routes sharing an edge
// are drawn in their own lane so the traffic stays legible; with nine routes the
// lanes get thin, but the spread stays inside the road.
const LANE_SPREAD = 14;
const MAX_LANE_GAP = 7;
// Above this population we draw a fixed-size sample of drivers rather than one
// dot each: 1000 overlapping dots is neither legible nor cheap, and the sample
// is spread evenly across agent indices so route proportions still read true.
const MAX_DOTS = 400;
const TAU = Math.PI * 2;

const DOT_CORE = 2.6; // radius of the solid dot
const DOT_HALO = 9; // radius of its bloom, and half the sprite's size

/*
 * Congestion ramp for the congestible edges.
 *
 * This is a status encoding (free → moderate → heavy → jammed) rather than a
 * plain sequential one, and it deliberately keeps the green→red traffic
 * convention instead of the single-hue ramp a magnitude encoding would use: it
 * is the convention every traffic map has taught, and it is never the only
 * signal — each congestible edge is labelled with its travel time and car count,
 * and its width grows with load. Light-mode stops are darker steps chosen for
 * the white surface, not the dark set reused.
 */
const CONGESTION_STOPS = {
  dark: [
    [0, [52, 211, 153]],
    [0.45, [250, 204, 21]],
    [0.75, [251, 146, 60]],
    [1, [244, 63, 94]],
  ],
  light: [
    [0, [4, 150, 110]],
    [0.45, [180, 120, 4]],
    [0.75, [200, 105, 10]],
    [1, [206, 22, 62]],
  ],
};

const THEME_VARS = [
  '--scheme',
  '--text',
  '--text-dim',
  '--text-faint',
  '--grid',
  '--accent',
  '--node-fill',
  '--node-fill-2',
  '--node-stroke',
  '--edge-fixed',
  '--edge-ghost',
  '--chip-bg',
  '--panel-solid',
];
let palette = null;
const spriteCache = new Map();
let gridPattern = null;

function invalidatePalette() {
  palette = null;
  // Dot sprites bake in the surface ring and the grid tile bakes in the grid
  // colour, so both are theme-dependent and must go with the palette.
  spriteCache.clear();
  gridPattern = null;
}

function css(name) {
  if (!palette) {
    const computed = getComputedStyle(document.documentElement);
    palette = {};
    for (const v of THEME_VARS) palette[v] = computed.getPropertyValue(v).trim();
  }
  return palette[name];
}

/** 'dark' | 'light' — whichever theme the stylesheet has actually resolved. */
function scheme() {
  return css('--scheme') === 'light' ? 'light' : 'dark';
}

const isLight = () => scheme() === 'light';

/** A route's colour for the live theme. Each route carries a per-theme pair. */
function routeColor(graph, i) {
  const c = graph.routes[i].color;
  return typeof c === 'string' ? c : c[scheme()];
}

/** Same, for the chart's reference-line annotations. */
function themed(color) {
  return typeof color === 'string' ? color : color[scheme()];
}

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function congestionColor(load) {
  const stops = CONGESTION_STOPS[scheme()];
  const t = Math.max(0, Math.min(1, load));
  let i = 1;
  while (i < stops.length - 1 && t > stops[i][0]) i++;
  const [t0, a] = stops[i - 1];
  const [t1, b] = stops[i];
  const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(', ')})`;
}

/**
 * One pre-rendered dot: bloom, solid core, and a ring in the surface colour so a
 * dot stays legible on top of a road of any colour. Baking all three into a
 * sprite keeps it to a single drawImage per dot, which matters at 400 dots a
 * frame — drawing the bloom live (shadowBlur, or three arcs each) does not hold
 * 60fps. Sprites are built at device resolution so they stay crisp.
 */
function dotSprite(color, dpr) {
  const key = `${color}|${scheme()}|${dpr}`;
  const hit = spriteCache.get(key);
  if (hit) return hit;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.ceil(DOT_HALO * 2 * dpr);
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);

  const grad = g.createRadialGradient(DOT_HALO, DOT_HALO, 0, DOT_HALO, DOT_HALO, DOT_HALO);
  grad.addColorStop(0, rgba(color, 0.5));
  grad.addColorStop(0.4, rgba(color, 0.16));
  grad.addColorStop(1, rgba(color, 0));
  g.fillStyle = grad;
  g.beginPath();
  g.arc(DOT_HALO, DOT_HALO, DOT_HALO, 0, TAU);
  g.fill();

  g.beginPath();
  g.arc(DOT_HALO, DOT_HALO, DOT_CORE, 0, TAU);
  g.fillStyle = color;
  g.fill();
  // A full-strength ring, not a hint of one: at full load the road under a dot is
  // vivid red, and the pink series step sitting on it needs real separation.
  g.lineWidth = 1.4;
  g.strokeStyle = css('--panel-solid');
  g.stroke();

  spriteCache.set(key, canvas);
  return canvas;
}

/** A faint blueprint grid behind the network, cached as a repeating tile. */
function backdropPattern(ctx, dpr) {
  if (gridPattern) return gridPattern;
  const step = 26;
  const tile = document.createElement('canvas');
  tile.width = tile.height = Math.round(step * dpr);
  const g = tile.getContext('2d');
  g.scale(dpr, dpr);
  g.fillStyle = css('--grid');
  g.beginPath();
  g.arc(step / 2, step / 2, 0.9, 0, TAU);
  g.fill();
  gridPattern = ctx.createPattern(tile, 'repeat');
  // The context is already scaled by dpr, so undo that for the pattern or the
  // tile lands at dpr× its intended size.
  gridPattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
  return gridPattern;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * A label on a glass chip, so text never fights whatever it sits on — a road, a
 * reference line, or the series itself. `anchor` is where `x` falls: the chip's
 * centre by default, or its right edge.
 */
function chipText(ctx, lines, x, y, anchor = 'center') {
  const padX = 7;
  const padY = 4;
  const lh = 14;
  ctx.textBaseline = 'middle';

  let w = 0;
  for (const line of lines) {
    ctx.font = line.font;
    w = Math.max(w, ctx.measureText(line.text).width);
  }
  const cx = anchor === 'right' ? x - w / 2 - padX : x;
  const h = lines.length * lh;
  const top = y - h / 2;

  ctx.fillStyle = css('--chip-bg');
  roundRect(ctx, cx - w / 2 - padX, top - padY, w + padX * 2, h + padY * 2, 7);
  ctx.fill();

  ctx.textAlign = 'center';
  lines.forEach((line, i) => {
    ctx.font = line.font;
    ctx.fillStyle = line.color;
    ctx.fillText(line.text, cx, top + lh * i + lh / 2);
  });
}

/**
 * Perpendicular offset for a route's dot lane. A scenario may pin a route's lane
 * explicitly (the classic network centres its shortcut route on the vertical
 * A→B road); otherwise lanes are spread evenly across the route list.
 */
function routeOffset(graph, i) {
  const pinned = graph.routes[i].offset;
  if (pinned !== undefined) return pinned;
  const n = graph.routes.length;
  if (n < 2) return 0;
  const gap = Math.min(MAX_LANE_GAP, LANE_SPREAD / (n - 1));
  return (i - (n - 1) / 2) * gap;
}

/** CSS-pixel size of a canvas, without touching its backing store. */
function canvasSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  return { w: Math.max(1, Math.round(rect.width)), h: Math.max(1, Math.round(rect.height)) };
}

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { w, h } = canvasSize(canvas);
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h, dpr };
}

class NetworkView {
  constructor(canvas, graph, sim) {
    this.canvas = canvas;
    this.graph = graph;
    this.sim = sim;
    this.resetAgents();
  }

  /**
   * (Re)allocate dot state to match the current population. Must be called
   * after anything that resizes or repopulates the simulation — `sim.reset()`
   * or `graph.setPopulation()` — or the dots describe a population that no
   * longer exists.
   */
  resetAgents() {
    const N = this.graph.population;
    const count = Math.min(N, MAX_DOTS);
    this.dotAgent = new Int32Array(count); // which agent each dot stands for
    this.travel = new Float32Array(count); // trip progress, 0..1
    this.visualRoute = new Int8Array(count);
    for (let j = 0; j < count; j++) {
      this.dotAgent[j] = Math.floor((j * N) / count);
      // Random phase, not an even stagger: evenly spaced dots read as one solid
      // stripe, whereas random phases bunch and gap like real traffic.
      this.travel[j] = Math.random();
      this.visualRoute[j] = this.sim.agents[this.dotAgent[j]];
    }
  }

  /**
   * Reconcile dots with a change in which routes exist.
   *
   * V1 let a dot keep driving a route that had just been deleted until it
   * happened to finish its lap — up to a few seconds of traffic flowing down a
   * road drawn as removed. The desync was invisible because the cost lookup
   * fell back to a magic 65 for the inactive route. Snapping here preserves
   * each dot's phase (so nothing teleports) while moving it onto a real road,
   * and it works while paused, when `update()` is a deliberate no-op.
   */
  syncRoutes() {
    for (let j = 0; j < this.travel.length; j++) {
      if (this.graph.isRouteActive(this.visualRoute[j])) continue;
      this.visualRoute[j] = this.sim.agents[this.dotAgent[j]];
    }
  }

  /** Current pixel position of every dot — the render state, for assertions. */
  dotPositions() {
    const { w, h } = canvasSize(this.canvas);
    const pos = this.nodePositions(w, h);
    const geoms = this.graph.routes.map((_, i) => this.routeGeometry(i, pos));
    const out = [];
    for (let j = 0; j < this.travel.length; j++) {
      const r = this.visualRoute[j];
      const p = this.pointAlong(geoms[r], this.travel[j], routeOffset(this.graph, r));
      out.push({ x: p.x, y: p.y, route: r, travel: this.travel[j] });
    }
    return out;
  }

  nodePositions(w, h) {
    const padX = 48;
    const padY = 44;
    const pos = {};
    for (const [key, n] of Object.entries(this.graph.nodes)) {
      pos[key] = { x: padX + n.x * (w - 2 * padX), y: padY + n.y * (h - 2 * padY) };
    }
    return pos;
  }

  /** Pixel polyline for a route, plus cumulative segment lengths. */
  routeGeometry(routeIndex, pos) {
    const pts = this.graph.routes[routeIndex].path.map((k) => pos[k]);
    const lengths = [];
    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      lengths.push(len);
      total += len;
    }
    return { pts, lengths, total };
  }

  pointAlong(geom, t, offset) {
    let target = t * geom.total;
    let seg = 0;
    while (seg < geom.lengths.length - 1 && target > geom.lengths[seg]) {
      target -= geom.lengths[seg];
      seg++;
    }
    const a = geom.pts[seg];
    const b = geom.pts[seg + 1];
    const f = geom.lengths[seg] ? target / geom.lengths[seg] : 0;
    const dx = (b.x - a.x) / (geom.lengths[seg] || 1);
    const dy = (b.y - a.y) / (geom.lengths[seg] || 1);
    return {
      x: a.x + (b.x - a.x) * f - dy * offset,
      y: a.y + (b.y - a.y) * f + dx * offset,
    };
  }

  /**
   * Advance the dots by `simDt` *simulated* seconds, as issued by the Clock.
   *
   * This is the only place dot state changes, and it never consults wall time.
   * A paused clock hands us 0 and we return immediately, so the dots hold their
   * exact positions for as long as the pause lasts and continue from there.
   */
  update(simDt) {
    if (!(simDt > 0)) return;

    const costs = this.sim.routeCosts();
    for (let j = 0; j < this.travel.length; j++) {
      let vr = this.visualRoute[j];
      // syncRoutes() normally handles this at the moment a road closes; the
      // check keeps the invariant local so no cost lookup can ever be null.
      if (!this.graph.isRouteActive(vr)) {
        vr = this.visualRoute[j] = this.sim.agents[this.dotAgent[j]];
      }
      // Slower route => slower dot. 25/cost gives roughly a third of a lap
      // per second at the equilibrium travel times.
      this.travel[j] += (simDt * 25) / costs[vr];
      if (this.travel[j] >= 1) {
        this.travel[j] -= Math.floor(this.travel[j]);
        // Trip finished — now honour whatever route this agent has since chosen.
        this.visualRoute[j] = this.sim.agents[this.dotAgent[j]];
      }
    }
  }

  draw() {
    const { ctx, w, h, dpr } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);

    ctx.save();
    ctx.fillStyle = backdropPattern(ctx, dpr);
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    const pos = this.nodePositions(w, h);
    const flows = this.graph.edgeFlows(this.sim.counts);
    const N = this.graph.population;
    const light = isLight();

    const stroke = (a, b, style, width, dash, alpha = 1) => {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = style;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    };

    // --- roads ---
    // Labels are collected and drawn last, so a chip is never painted over by a
    // later road's glow.
    const labels = [];
    for (const [key, e] of Object.entries(this.graph.edges)) {
      const a = pos[e.from];
      const b = pos[e.to];
      const flow = flows[key];
      const enabled = this.graph.isEdgeEnabled(key);

      if (e.toggleable && !enabled) {
        stroke(a, b, css('--edge-ghost'), 2, [3, 9]);
      } else if (e.congestible) {
        const load = N ? flow / N : 0;
        const color = congestionColor(load);
        const width = 4 + 12 * load;
        // A wider translucent pass first: the road glows as it fills, so load is
        // legible from across the room before you read the number.
        stroke(a, b, color, width + 12, null, light ? 0.14 : 0.2);
        stroke(a, b, color, width, null);
      } else if (e.toggleable) {
        const color = themed(e.color);
        stroke(a, b, color, 14, null, light ? 0.12 : 0.18);
        stroke(a, b, color, 3, [10, 7]);
      } else {
        stroke(a, b, css('--edge-fixed'), 6, null);
      }

      if (!enabled) continue;

      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      // Push the label off the road, perpendicular to it. A vertical free road is
      // the exception: nudge it sideways so it clears the dots.
      const lift = 24;
      const lines = [
        {
          text: this.graph.edgeCost(key, flow).toFixed(1),
          font: '600 13px ui-monospace, SFMono-Regular, Menlo, monospace',
          color: css('--text'),
        },
      ];
      if (e.congestible) {
        lines.push({
          text: `${flow} cars`,
          font: '11px ui-monospace, SFMono-Regular, Menlo, monospace',
          color: css('--text-dim'),
        });
      }
      labels.push({
        lines,
        x: e.toggleable ? mx + 36 : mx - (dy / len) * lift,
        y: e.toggleable ? my : my + (dx / len) * lift,
      });
    }

    // --- agent dots ---
    const geoms = this.graph.routes.map((_, i) => this.routeGeometry(i, pos));
    for (let j = 0; j < this.travel.length; j++) {
      const r = this.visualRoute[j];
      const p = this.pointAlong(geoms[r], this.travel[j], routeOffset(this.graph, r));
      const sprite = dotSprite(routeColor(this.graph, r), dpr);
      ctx.drawImage(sprite, p.x - DOT_HALO, p.y - DOT_HALO, DOT_HALO * 2, DOT_HALO * 2);
    }

    // --- nodes ---
    const nodeGlow = light ? '#2563eb' : '#4a9eff';
    for (const [key, p] of Object.entries(pos)) {
      ctx.save();
      const glow = ctx.createRadialGradient(p.x, p.y, 12, p.x, p.y, 30);
      glow.addColorStop(0, rgba(nodeGlow, light ? 0.1 : 0.16));
      glow.addColorStop(1, rgba(nodeGlow, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 30, 0, TAU);
      ctx.fill();
      ctx.restore();

      const fill = ctx.createLinearGradient(p.x, p.y - 20, p.x, p.y + 20);
      fill.addColorStop(0, css('--node-fill-2'));
      fill.addColorStop(1, css('--node-fill'));
      ctx.beginPath();
      ctx.arc(p.x, p.y, 20, 0, TAU);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = css('--node-stroke');
      ctx.stroke();

      ctx.fillStyle = css('--text');
      ctx.font = `700 ${key.length > 1 ? 13 : 15}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(key, p.x, p.y + 0.5);
    }

    for (const label of labels) chipText(ctx, label.lines, label.x, label.y);
  }
}

class ChartView {
  constructor(canvas, graph, sim) {
    this.canvas = canvas;
    this.graph = graph;
    this.sim = sim;
  }

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);

    const history = this.sim.history;
    const view = history.slice(-CHART_WINDOW);
    if (view.length < 2) {
      // Nothing plotted yet — say so rather than showing an empty box.
      ctx.fillStyle = css('--text-faint');
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Press Play to run the simulation', w / 2, h / 2);
      return;
    }

    const padL = 54;
    const padR = 14;
    const padT = 16;
    const padB = 26;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const theory = this.graph.theory;
    let lo = Math.min(...theory.map((t) => t.value));
    let hi = Math.max(...theory.map((t) => t.value));
    for (const p of view) {
      lo = Math.min(lo, p.avgCost);
      hi = Math.max(hi, p.avgCost);
    }
    const margin = Math.max(3, (hi - lo) * 0.15);
    lo -= margin;
    hi += margin;

    const x0 = view[0].round;
    const x1 = view[view.length - 1].round;
    const spanX = Math.max(1, x1 - x0);
    const sx = (r) => padL + ((r - x0) / spanX) * plotW;
    const sy = (c) => padT + (1 - (c - lo) / (hi - lo)) * plotH;

    // baseline + left axis, recessive
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    // Reference lines for the analytical equilibria. These are annotations rather
    // than series, so the labels wear muted ink and only the dash carries colour.
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (const line of theory) {
      const color = themed(line.color);
      const y = sy(line.value);

      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = css('--text-dim');
      ctx.textAlign = 'right';
      ctx.fillText(String(line.value), padL - 13, y);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(padL - 9, y);
      ctx.lineTo(padL - 3, y);
      ctx.stroke();
      ctx.restore();

      // Tagged at the right end rather than the left: the interesting motion is
      // always at the start of the window. On a chip, because at the right end a
      // settled series lies exactly along its own reference line.
      chipText(
        ctx,
        [{ text: line.label, font: '10px ui-monospace, SFMono-Regular, Menlo, monospace', color: css('--text-faint') }],
        padL + plotW - 2,
        y,
        'right'
      );
    }

    // markers wherever a road was built or demolished
    for (const t of this.sim.toggles) {
      if (t.round < x0 || t.round > x1) continue;
      const x = sx(t.round);
      ctx.save();
      ctx.strokeStyle = themed(t.enabled ? theory[theory.length - 1].color : theory[0].color);
      ctx.globalAlpha = 0.75;
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.restore();
    }

    // The series: a soft fill under a 2px line. One series, so no legend box —
    // the panel heading names it.
    const accent = css('--accent');
    const trace = () => {
      ctx.beginPath();
      ctx.moveTo(sx(view[0].round), sy(view[0].avgCost));
      for (const p of view) ctx.lineTo(sx(p.round), sy(p.avgCost));
    };

    const fill = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    fill.addColorStop(0, rgba(accent, isLight() ? 0.2 : 0.28));
    fill.addColorStop(1, rgba(accent, 0));
    ctx.save();
    trace();
    ctx.lineTo(sx(x1), padT + plotH);
    ctx.lineTo(sx(x0), padT + plotH);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.strokeStyle = rgba(accent, 0.28);
    ctx.lineWidth = 6;
    trace();
    ctx.stroke();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    trace();
    ctx.stroke();
    ctx.restore();

    // x labels
    ctx.fillStyle = css('--text-faint');
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(`round ${x0}`, padL, padT + plotH + 8);
    ctx.textAlign = 'right';
    ctx.fillText(`round ${x1}`, padL + plotW, padT + plotH + 8);
  }
}

window.Braess = window.Braess || {};
window.Braess.NetworkView = NetworkView;
window.Braess.ChartView = ChartView;
window.Braess.invalidatePalette = invalidatePalette;
window.Braess.routeColor = routeColor;

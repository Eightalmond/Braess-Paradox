/*
 * render.js — canvas drawing.
 *
 * NetworkView draws the road network (edge width/colour keyed to congestion)
 * plus one animated dot per agent driving its route. Dots move slower on slower
 * routes, and an agent only adopts its newly chosen route once it finishes the
 * trip it is on — so the picture stays readable while the simulation churns.
 *
 * ChartView draws average travel time per round with markers where the
 * shortcut was toggled. That chart is the punchline: adding a free road makes
 * the line jump *up*.
 */

// Violet for the shortcut and its route: the congestion scale already owns
// green→red, so a pink dot on a jammed (red) edge would be invisible.
const SHORTCUT_COLOR = '#c07cff';
const ROUTE_COLORS = ['#4a9eff', '#ffb454', SHORTCUT_COLOR];
const ROUTE_OFFSETS = [-7, 7, 0]; // perpendicular dot offset so shared edges stay legible
const NO_SHORTCUT_COLOR = '#3ddc97';
const CHART_WINDOW = 800; // rounds visible in the sliding chart window

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

class NetworkView {
  constructor(canvas, graph, sim) {
    this.canvas = canvas;
    this.graph = graph;
    this.sim = sim;
    this.resetAgents();
  }

  resetAgents() {
    const N = this.graph.population;
    this.travel = new Float32Array(N);
    this.visualRoute = new Int8Array(N);
    for (let i = 0; i < N; i++) {
      // Random phase, not an even stagger: evenly spaced dots read as one solid
      // stripe, whereas random phases bunch and gap like real traffic.
      this.travel[i] = Math.random();
      this.visualRoute[i] = this.sim.agents[i];
    }
  }

  nodePositions(w, h) {
    const padX = 46;
    const padY = 40;
    const pos = {};
    for (const [key, n] of Object.entries(window.Braess.NODES)) {
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

  /** Advance the dots. dt is in seconds. */
  update(dt) {
    const costs = this.sim.routeCosts();
    for (let i = 0; i < this.travel.length; i++) {
      const vr = this.visualRoute[i];
      // Slower route => slower dot. 25/cost gives roughly a third of a lap
      // per second at the equilibrium travel times.
      const cost = costs[vr] || 65;
      this.travel[i] += (dt * 25) / cost;
      if (this.travel[i] >= 1) {
        this.travel[i] -= Math.floor(this.travel[i]);
        // Trip finished — now honour whatever route this agent has since chosen.
        this.visualRoute[i] = this.sim.agents[i];
      }
    }
  }

  draw() {
    const { ctx, w, h } = fitCanvas(this.canvas);
    ctx.clearRect(0, 0, w, h);

    const pos = this.nodePositions(w, h);
    const flows = this.graph.edgeFlows(this.sim.counts);
    const N = this.graph.population;

    // --- edges ---
    for (const [key, e] of Object.entries(this.graph.edges)) {
      const a = pos[e.from];
      const b = pos[e.to];
      const flow = flows[key];
      const enabled = !e.shortcut || this.graph.shortcutEnabled;

      ctx.save();
      if (e.shortcut && !enabled) {
        ctx.strokeStyle = css('--edge-ghost');
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 8]);
      } else if (e.congestible) {
        const load = N ? flow / N : 0;
        // green (free flowing) -> red (jammed)
        const hue = 140 - 140 * load;
        ctx.strokeStyle = `hsl(${hue}, 70%, 52%)`;
        ctx.lineWidth = 4 + 12 * load;
      } else if (e.shortcut) {
        ctx.strokeStyle = SHORTCUT_COLOR;
        ctx.lineWidth = 4;
        ctx.setLineDash([9, 6]);
      } else {
        ctx.strokeStyle = css('--edge-fixed');
        ctx.lineWidth = 6;
      }
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();

      if (e.shortcut && !enabled) continue;

      // --- edge label: current travel time (and load, if congestible) ---
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      // Push the label off the road, perpendicular to it. The vertical A→B
      // shortcut is the exception: nudge it sideways so it clears the dots.
      const lift = 22;
      const tx = e.shortcut ? mx + 34 : mx - (dy / len) * lift;
      const ty = e.shortcut ? my : my + (dx / len) * lift;

      ctx.save();
      ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = css('--text');
      ctx.fillText(this.graph.edgeCost(key, flow).toFixed(1), tx, ty);
      if (e.congestible) {
        ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillStyle = css('--text-dim');
        ctx.fillText(`${flow} cars`, tx, ty + 15);
      }
      ctx.restore();
    }

    // --- agent dots ---
    const geoms = this.graph.routes.map((_, i) => this.routeGeometry(i, pos));
    for (let i = 0; i < this.travel.length; i++) {
      const r = this.visualRoute[i];
      const p = this.pointAlong(geoms[r], this.travel[i], ROUTE_OFFSETS[r]);
      ctx.fillStyle = ROUTE_COLORS[r];
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- nodes ---
    for (const [key, p] of Object.entries(pos)) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 19, 0, Math.PI * 2);
      ctx.fillStyle = css('--node-fill');
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = css('--node-stroke');
      ctx.stroke();

      ctx.fillStyle = css('--text');
      ctx.font = '700 15px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(key, p.x, p.y + 0.5);
    }
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
      ctx.fillStyle = css('--text-dim');
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Press Play to run the simulation', w / 2, h / 2);
      return;
    }

    const padL = 42;
    const padR = 12;
    const padT = 12;
    const padB = 24;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const theory = this.graph.theory;
    let lo = Math.min(theory.without, theory.with);
    let hi = Math.max(theory.without, theory.with);
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

    // axes
    ctx.strokeStyle = css('--grid');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    // reference lines for the analytical equilibria
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (const [value, label, color] of [
      [theory.without, 'no shortcut', NO_SHORTCUT_COLOR],
      [theory.with, 'with shortcut', SHORTCUT_COLOR],
    ]) {
      const y = sy(value);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.45;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = color;
      ctx.textAlign = 'right';
      ctx.fillText(String(value), padL - 6, y);
      ctx.textAlign = 'left';
      ctx.globalAlpha = 0.7;
      ctx.fillText(label, padL + 6, y - 9);
      ctx.globalAlpha = 1;
    }

    // shortcut toggle markers
    for (const t of this.sim.shortcutToggles) {
      if (t.round < x0 || t.round > x1) continue;
      const x = sx(t.round);
      ctx.save();
      ctx.strokeStyle = t.enabled ? SHORTCUT_COLOR : NO_SHORTCUT_COLOR;
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.restore();
    }

    // the series
    ctx.strokeStyle = css('--accent');
    ctx.lineWidth = 2;
    ctx.beginPath();
    view.forEach((p, i) => {
      const x = sx(p.round);
      const y = sy(p.avgCost);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // x labels
    ctx.fillStyle = css('--text-dim');
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(`round ${x0}`, padL, padT + plotH + 7);
    ctx.textAlign = 'right';
    ctx.fillText(`round ${x1}`, padL + plotW, padT + plotH + 7);
  }
}

window.Braess = window.Braess || {};
window.Braess.NetworkView = NetworkView;
window.Braess.ChartView = ChartView;
window.Braess.ROUTE_COLORS = ROUTE_COLORS;

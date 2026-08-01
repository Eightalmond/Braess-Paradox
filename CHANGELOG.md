# Changelog

## V3 — a second network, behind tabs

### What's new

A **Double Braess** tab: two Braess gadgets chained in series, with two free
roads that can be built and demolished independently. Each half of the trip is
its own copy of the classic network, so the paradox *compounds* — 130 door to
door with no free roads, 145 with one, 160 with both. Every road you add costs
every driver another 15 minutes, and each one is individually irresistible on the
way in.

Verified against the simulation at N = 40, 200 and 1000: all four states (none,
first road, both, second road only) reach exact analytical equilibrium with zero
switches in the last 1000 rounds of each phase.

### Refactor

The network was hardcoded across four files. It is now data, in a new
`js/scenarios.js`, and `Graph` is a loader for it:

- **Any number of toggleable roads.** `graph.shortcutEnabled` — a single boolean —
  became `graph.enabled`, a set of edge keys. Routes declare which free roads
  they depend on via `requires` and exist only while all of them do.
  `sim.toggleShortcut()` became `sim.toggleEdge(key)`, which sweeps *every*
  inactive route when a road closes rather than the one route that owned the
  edge — with two roads, demolishing one strands agents on three routes at once.
- **`window.Braess.NODES` is gone.** It was a global that only worked because
  there was exactly one network; node positions now come from `graph.nodes`.
- **Route colours and dot lanes come from the scenario.** `ROUTE_COLORS` and
  `ROUTE_OFFSETS` were fixed-length arrays indexed by route. The double network
  has nine routes, so colour is now a route property (hue carries the first-stage
  choice, lightness the second) and lanes are spread across however many routes
  exist. The classic network pins its three lanes so it looks exactly as it did.
- **Chart reference lines are a list**, not a `{ without, with }` pair — the
  double network has three.
- One build/demolish **button per free road**, generated from
  `graph.toggleableEdges()`, plus a per-scenario tagline and walkthrough.

### Desyncs this could have introduced, and what prevents them

Switching networks changes the route count, the node set, the edge set and the
number of free roads at once — the same class of bug as V2's pause, with more
surface. Every switch goes through the V2 discipline: pause the clock, then
`graph.load()` → `rebuild()` → `restart()` in one synchronous block, so no frame
can observe a half-swapped network.

- `sim.reset()` re-derives `counts` from `graph.routes`, so a stale nine-element
  count array cannot survive a switch to a three-route network.
- `networkView.resetAgents()` re-derives dot state, so no dot indexes into the
  old route list. Asserted: after a switch, every dot is on route 0 with finite
  coordinates.
- Toggle state, history and the round counter are cleared, so a free road built
  in one network does not appear enabled in the next.
- `graph.load()` copies the scenario's edges rather than mutating them, because
  `coeff` is per-population runtime state and a scenario has to survive being
  loaded, unloaded and loaded again. Asserted by a round trip back to the
  classic tab.
- One that bit during development: plain `<script>` tags share a single global
  scope, so `BEFORE_COLOR` declared in both `scenarios.js` and `render.js` was a
  hard `SyntaxError` that took the whole app down. Renamed, and worth remembering
  before adding another top-level const.

Tests grew from 17 to 22: the double network's convergence at three population
sizes, a scenario-switch check that inspects every rebuilt piece of DOM and
model state, free-road independence, and screenshots for both networks in both
themes.

## V2 — control state, fixed at the architecture level

### The pause bug

**Symptom.** Pause stopped the round counter and the chart, but the traffic dots
kept flowing across the canvas. Pause was decorative.

**Root cause.** Two independent clocks, by design. `main.js` held a private
`let playing` that gated *only* the round-advancement block of the frame loop:

```js
if (playing) { …sim.step()…; updateStats(); }

networkView.update(dt);   // outside the gate
networkView.draw();
```

`networkView.update(dt)` was called unconditionally, and `dt` came from
`performance.now()` deltas. `NetworkView` owned its own animation state — a
`travel[]` array of trip phases — which it integrated against wall time. No
simulation concept governed it, and `playing` was a variable no other component
could see. V1's own header comment stated the intent: *"Two clocks run
independently."* That was the defect. There was no if-check to add, because the
animation was never asked about pause in the first place.

The round counter and the chart appeared to freeze for an unrelated reason: they
read `sim.round` and `sim.history`, which are static while no rounds run. They
were correct by accident, not by design.

**Fix.** A new `js/clock.js` owns the only notion of "running" and is the only
code in the app permitted to read wall time. `Clock.tick(wallNow)` returns
`{ dt, rounds }` in *simulated* units, and returns zeros when stopped. The frame
loop feeds that single `dt` to both the round loop and `networkView.update()`, so
every consumer freezes for the same reason at the same instant. `main.js` no
longer has a `playing` flag; the button label is derived from `clock.running`.

Two properties are structural rather than remembered:

- `lastWall` is cleared on `stop()` and re-baselined on the first tick after
  `start()`, so a long pause cannot produce a catch-up delta. Resume continues
  from the frozen phase because nothing is reset in order to do it.
- Whole rounds are credited by the clock rather than derived downstream from
  `dt * speed`, so `step()` yields exactly one round at any speed. Deriving it
  would have lost a step at 60 rounds/sec, where `1/60 * 60` is
  `0.9999999999999999`.

The frame loop deliberately keeps running while paused, with repainting split
from advancement behind a `needsDraw` flag. "Frozen" is a property of the clock,
never of the loop — which is what lets a resize or theme change repaint a frozen
frame without advancing it.

### Other control desyncs found in the audit

| Control | Issue | Fix |
| --- | --- | --- |
| Add/Remove shortcut | Dots kept driving the shortcut for up to a full lap after it was deleted — flowing down a road drawn as removed. Hidden by `costs[vr] \|\| 65`, which silently substituted a magic number for the inactive route's `null` cost. | `NetworkView.syncRoutes()` snaps affected dots to their fallback route on toggle, preserving trip phase so nothing teleports. Works while paused, where `update()` is a no-op. The `\|\| 65` fallback is gone; a null cost is now unreachable rather than absorbed. |
| Step | Advanced the simulation only, relying on the runaway animation to make dots adopt new routes. Correct pause would have left the dots frozen forever while the sim moved — a desync *created* by fixing the pause bug. | Step credits one round to the clock instead of calling `sim.step()`, so the round and its slice of dot motion arrive through the normal frame path. |
| Play (resume) | Latent: `lastFrame` was refreshed every frame, so V1 did not jump — but any fix that stops the loop while paused leaves it stale, and the first resumed frame gets a huge `dt`. | The clock owns its baseline and clears it on stop. Not reachable by construction. |
| Reset | `roundAccumulator` was never zeroed, so fractional round carry survived a reset and could fire a round on frame one. `wasSettled` was likewise never cleared. | `clock.reset()` zeroes all carry; `restart()` rebuilds clock, sim, dots, legend and stats in one synchronous block. |
| Theme | No control existed; theming was CSS-only. Worse, `css()` called `getComputedStyle` ~40× per frame, and with repaint decoupled from advancement a paused canvas would never pick up a theme change. | Added an Auto/Light/Dark picker. Theme variables are cached per theme and invalidated on change, which also forces a repaint of a frozen frame. The media query is scoped `:root:not([data-theme])` so an explicit choice beats the OS preference in both directions. |
| Drivers (N) | No control existed; population was a hardcoded `const POPULATION = 100`. | Added a 20–1000 slider. `graph.setPopulation()` renormalizes the congestion coefficient so the 65/80 equilibria hold at any N, then the run restarts — clock, agent arrays and dot arrays rebuilt together, with no frame in between for them to disagree in. Above 400 drivers a fixed 400-dot sample is drawn, spread evenly across agent indices; the route table still reports true counts. |
| Speed | `#speed-value` started from text hardcoded in the markup rather than from the input. | Every readout is derived from the model on init via `syncControls()`. |
| Resize | Latent: with repaint decoupled from advancement, a resize while paused would leave a stale or stretched canvas, since `fitCanvas()` only runs inside `draw()`. | A `ResizeObserver` on both canvases requests a repaint. |

### Testing

New `tests/run.mjs` (`npm test`) — 17 headless Playwright checks against the real
page through `window.Braess.app`, the same object the DOM handlers use. No
test-only code path.

The pause checks read actual dot coordinates out of the render state, let real
animation frames elapse, and require bit-identical values — eyeballing a canvas
cannot distinguish frozen from slow. Two metric traps worth recording, both hit
while writing these tests:

- Euclidean dot displacement is wrong for measuring *how far* a dot moved: a dot
  finishing its trip wraps from T back to S, which is ~600px of legitimate
  travel. Magnitudes are measured as wrap-safe progress in laps.
- End-to-end round-rate measurement measures the auto-pause, not the speed
  slider: the sim settles in ~19 rounds, so at 60 rounds/sec the app correctly
  stops a third of a second into the window. Pacing is timed against a
  standalone `Clock` under real rAF, with slider wiring and end-to-end pacing
  consequences asserted separately.

Also re-verified post-refactor, since the round loop was rewritten:

- **Convergence at N = 40, 200 and 1000.** 3000 rounds per phase across
  no-shortcut → shortcut → removed. All three settle to exactly 65 → 80 → 65 by
  round ~20, with the 50/50 split and full R3 adoption as predicted, and **zero**
  switches plus a sub-0.01 cost band over the last 1000 rounds of every phase —
  no thrashing.
- **Screenshots in both themes**, asserted non-blank by distinct-colour count
  rather than by file size alone.

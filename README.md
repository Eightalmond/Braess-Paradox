# Braess's Paradox — an interactive traffic equilibrium simulator

Adding a new road to a network can make **every single driver slower**. Not
because of a mistake, and not because anyone behaved irrationally — precisely
*because* everyone behaved rationally. This is Braess's Paradox, and it's one of
the cleanest demonstrations that a Nash equilibrium need not be efficient.

This repo is a small self-contained web app that lets you watch it happen, in two
networks:

| Tab | Network | The point |
| --- | --- | --- |
| **Classic Braess** | 4 nodes, 1 free shortcut, 3 routes | Adding a free road takes everyone from **65** to **80**. |
| **Double Braess** | 7 nodes, 2 free roads, 9 routes | The damage compounds: **130 → 145 → 160**, 15 minutes per road. |

## Running it

```
open index.html
```

That's it. No build step, no server, no dependencies — plain HTML, CSS, and
JavaScript loaded with `<script>` tags.

## The classic network

```
              A
         ↗         ↘
   40·(x/N)          45
    ↗                  ↘
  S          ⋮ A→B ⋮      T        (A→B is the free "shortcut", cost 0)
    ↘                  ↗
     45              40·(x/N)
         ↘         ↗
              B
```

Every edge has a travel time. Two of them are **congestible** — they get slower
the more drivers use them, `cost(x) = 40 · x/N` where `x` is the number of
drivers on that edge and `N` the population. The other two cost a flat **45** no
matter how busy they are. The dashed `A→B` shortcut is **free** (cost 0) and can
be toggled on and off.

That gives up to three routes from `S` to `T`:

| Route | Path | Edges used |
| --- | --- | --- |
| R1 | S→A→T | one congestible, one fixed |
| R2 | S→B→T | one fixed, one congestible |
| R3 | S→A→B→T | **both** congestible edges (only exists with the shortcut) |

### Why the numbers are 65 and 80

**Without the shortcut**, R1 and R2 are symmetric. Any imbalance makes the
busier route slower, so drivers spread out until the two routes tie at a 50/50
split:

```
cost = 40·(0.5) + 45 = 20 + 45 = 65
```

**With the shortcut**, R3 uses both congestible edges and skips both of the
fixed 45-cost edges. Starting from the 50/50 split, R3 costs about 40 — a
bargain versus 65 — so drivers pile onto it. But every driver who switches adds
load to *both* congestible edges, so R3 gets worse as it fills up. It bottoms
out with everyone on R3:

```
cost = 40·(1.0) + 0 + 40·(1.0) = 40 + 40 = 80
```

Is that stable? A driver who defects to R1 pays `40·(1.0) + 45 = 85`. Worse. So
nobody moves: it's a genuine Nash equilibrium. Every driver is now doing
**80** instead of **65** — 23% slower — and the only thing that changed is that
they were *given an extra option*.

The textbook version of this example uses 4000 cars and a cost of `x/100`. The
congestion coefficient here is normalized as `40/N`, which reproduces those
exact 65 and 80 figures for any population size.

### The double network: why 130, 145 and 160

The **Double Braess** tab chains two copies of the same gadget:

```
        A1                A2
      ↗    ↘            ↗    ↘
   S    ⋮A1→B1⋮   M   ⋮A2→B2⋮   T
      ↘    ↗            ↘    ↗
        B1                B2
```

Each half is the classic network, so each half costs **65** with its traffic split
50/50 and **80** once everybody piles onto its free road. A driver picks a
half-trip in each stage, which is why three options per stage enumerate to nine
S→T routes.

| Free roads built | Cost per driver |
| --- | --- |
| none | 65 + 65 = **130** |
| one | 80 + 65 = **145** |
| both | 80 + 80 = **160** |

Each road you build costs every driver another 15 minutes, and each one is
individually irresistible on the way in — that's the compounding version of the
same trap. Note that with no free roads the equilibrium is unique in *edge flows*
but not in route counts: any mix leaving each congestible edge at half load costs
exactly 130, so 50 drivers on `A1·A2` plus 50 on `B1·B2` is just as much an
equilibrium as 25 on each of the four routes.

## How equilibrium is found

There's no equation being solved. The simulation uses **best-response
dynamics**, which is closer to how the paradox actually plays out on real roads:

1. Each round, a small batch of drivers (3% of the population) is sampled.
2. Each sampled driver looks at the *current* load on every route and computes
   the travel time they personally would get on each one. Crucially they exclude
   themselves from the current load before adding themselves to the candidate
   route — that's what makes it a true best response, and it keeps the process
   from oscillating around a near-tie.
3. If some route beats their current one, they switch.
4. Repeat. When a full sweep produces no profitable switch for anybody, the
   system is at equilibrium and the simulation auto-pauses.

Started with all `N` drivers crammed onto R1, this converges to the 50/50 split
in roughly 25 rounds, and to the all-on-R3 state in a few hundred.

## Using the demo

| Control | What it does |
| --- | --- |
| **Play / Pause** | Runs best-response rounds continuously. Pause halts *everything* — rounds, chart, and the dots, which freeze mid-transit and continue from where they stopped. Auto-pauses on reaching equilibrium. |
| **Step** | Runs exactly one round and the matching slice of dot motion — useful for watching convergence up close, or confirming that nothing moves once settled. |
| **Reset** | Puts all drivers back on R1, clears history, removes the shortcut. |
| **Add / Remove shortcut** | Toggles a free road. This is the paradox button — one per free road, so the double network has two. |
| **Rounds/sec** | How fast rounds tick while playing. |
| **Drivers** | Population size, 20–1000. Changing it restarts the run. The congestion coefficient is renormalized as `40/N`, so the 65 and 80 equilibria hold at every setting — N changes how granular the game is, not what it converges to. |
| **Theme** | Auto (follow the OS), Light, or Dark. An explicit choice overrides the OS preference. |
| **Tabs** | Switch network. Each switch restarts the run from a cold start. |

Suggested run-through:

1. Press **Play**. Drivers fan out; the two routes converge and tie at **65**.
   The badge turns green and it pauses.
2. Press **Add shortcut A→B**, then **Play** again. Watch everyone migrate onto
   the new road while the chart climbs.
3. It settles at **80**. Note the route table: R1 and R2 now show **85**, which
   is why nobody leaves. Everyone is stuck, and everyone is worse off.
4. Press **Remove shortcut**, then **Play**. Travel time spikes (everyone is
   dumped back onto R1) and then relaxes to **65** again.

### Reading the picture

- **Edge colour and thickness** track congestion on the two congestible edges —
  thin green when free-flowing, thick red when jammed. The two fixed-cost edges
  stay grey. The violet dashed line is the shortcut.
- **Dots** are individual drivers, coloured by the route they're on (blue R1,
  amber R2, violet R3). A driver who picks a new route finishes their current
  trip before switching, so the dots lag the route table slightly — same as real
  traffic. Dots move slower on slower routes. Up to 400 drivers get a dot each;
  above that a fixed 400-dot sample is drawn, spread evenly across the
  population, while the route table keeps reporting true counts.
- **The chart** plots average travel time per round, with dashed reference lines
  at each of the network's analytical equilibria and a vertical marker wherever a
  road was built or demolished. The jump *upward* right after a marker is the
  whole point.
- In the **double network**, a route's dot colour encodes both halves of its trip:
  hue is the first-stage choice (blue via A1, amber via B1, violet via the free
  road) and lightness the second.

## Code layout

| File | Responsibility |
| --- | --- |
| `js/scenarios.js` | The networks, as pure data: nodes, edges, routes, analytical equilibria, walkthrough. |
| `js/graph.js` | Loads a scenario and owns its runtime state: which free roads exist, congestion coefficients at the current N. |
| `js/simulation.js` | Driver population, best-response step, equilibrium detection, history log. |
| `js/clock.js` | The single source of truth for "is the simulation running", and the only code that reads wall time. |
| `js/render.js` | Canvas drawing — the network, the animated dots, the chart. |
| `js/main.js` | Wires DOM controls to the simulation and drives the frame loop. |
| `tests/run.mjs` | Headless verification: control state, convergence claims, screenshots. |

### One clock

Everything that moves is driven by simulated time issued by `Clock`, never by
wall time. `clock.tick()` returns the simulated seconds and whole rounds elapsed
since the last frame — zero for both while paused — and the frame loop hands that
same delta to the round loop and the dot animation alike. Nothing else in the app
holds a `playing` flag or a timer of its own, which is why pause stops the whole
picture at once instead of just the parts that happened to check.

The frame loop keeps running while paused, with repainting split from advancement
behind a dirty flag. That is what lets a window resize or a theme change repaint
a frozen frame without advancing it by a single round.

See [CHANGELOG.md](CHANGELOG.md) for the V1 pause bug this replaced, and the
other control desyncs the audit turned up.

## Tests

```
npm install
npm test
```

22 headless Playwright checks driving the real page. Notably: pause is verified
by reading actual dot coordinates, letting real animation frames elapse, and
requiring bit-identical values; equilibrium convergence is verified for both
networks at N = 40/200/1000 over 3000 rounds per phase, asserting zero switches
and a flat cost band once settled; switching tabs is checked against every piece
of rebuilt DOM and model state; and screenshots are captured for both networks in
both themes and checked for non-blankness. `node tests/run.mjs <substring>` runs
a subset.

## Things worth trying

- **Is 80 really the best they could do?** No. If a central planner forced a
  50/50 split on R1/R2 and banned the shortcut, everyone would do 65. The ratio
  between the selfish equilibrium and the social optimum is the *price of
  anarchy* — here 80/65 ≈ 1.23. For networks with affine cost functions like
  these, it's provably never worse than 4/3.
- **Step through the cascade one round at a time** after adding the shortcut.
  Early switchers genuinely gain; it's the later ones who erase the gain for
  everybody, including the early switchers.
- **Change the numbers** in `js/graph.js` (`CONSTANT_COST`, `CONGESTION_AT_FULL`)
  and find the edges of the effect. The paradox is not universal — it needs the
  fixed edges to be expensive enough to be worth escaping, but cheap enough to
  still be a viable fallback. Holding `CONGESTION_AT_FULL = 40` and sweeping
  `CONSTANT_COST`:

  | `CONSTANT_COST` | before | after | split R1/R2/R3 | paradox? |
  | --- | --- | --- | --- | --- |
  | 10 | 30 | 30 | 50/50/0 | no — shortcut never used |
  | 20 | 40 | 40 | 50/50/0 | no — exactly breaks even |
  | 30 | 50 | 59.4 | 26/26/48 | yes, partial adoption |
  | 45 | 65 | 80 | 0/0/100 | yes (the classic case) |
  | 60 | 80 | 80 | 0/0/100 | no — everyone switches, nobody loses |

  The paradox appears exactly when
  `CONGESTION_AT_FULL/2 < CONSTANT_COST < 3·CONGESTION_AT_FULL/2`. Below the
  lower bound the shortcut is unattractive even when the roads are empty; above
  the upper bound the old routes were so bad that piling onto the shortcut is a
  genuine improvement. Note the middle row: adoption can be *partial*, settling
  at a mixed equilibrium where all three routes tie.

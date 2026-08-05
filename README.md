# Braess's Paradox — an interactive traffic equilibrium simulator

Adding a new road to a network can make **every single driver slower** — not
from a mistake, but because everyone acting rationally piles onto the new
"shortcut" until it's worse than the roads it replaced.

## The idea, in plain terms

Two routes from **S** to **T** settle at **65** minutes each, 50/50 split —
nobody gains by switching. Add a free shortcut connecting them, and it looks
like a bargain at first, so people switch. But every switch adds load to both
roads the shortcut touches, making it slower for everyone on it — including
the people who switched first. It keeps looking better than the alternative
until *everyone* has piled on, settling at **80**. Bailing out now costs even
more, so nobody does. That's a real equilibrium, just a worse one — and nobody
in the story ever made a bad call.

## Running it

```
open index.html
```

No build step, no server, no dependencies.

## What's in it

Two networks, picked from the tabs:

| Network | Setup | Result |
| --- | --- | --- |
| **Classic Braess** | 1 free road, 3 routes | 65 → **80** once the shortcut fills |
| **Double Braess** | 2 free roads chained in series, 9 routes | 130 → 145 → **160** — each road costs another 15 minutes |

The simulation runs **best-response dynamics**: each round, a few random
drivers check if a different route beats their current one given everyone
else's traffic, and switch if so. Repeat until nobody wants to move — that's
the equilibrium, and it auto-pauses there.

## Controls

| Control | What it does |
| --- | --- |
| **Play / Pause** | Runs rounds continuously; pause freezes everything, including the dots mid-transit. Auto-pauses at equilibrium. |
| **Skip 200** | Jumps 200 rounds at once, paused. |
| **Reset** | Back to a cold start. |
| **Add / Remove shortcut** | Builds or demolishes a free road — the paradox button. |
| **Rounds/sec** | Playback speed. |
| **Drivers** | Population size, 20–1000. Restarts the run. |
| **Tabs** | Switch network. |

Dots are individual drivers, coloured by route. Edge colour and thickness
track congestion. The chart plots average travel time with reference lines at
each equilibrium.

## Tests

```
npm install
npm test
```

19 headless Playwright checks: pause genuinely freezes (verified from actual
dot coordinates, not eyeballed), both networks converge to their exact
predicted equilibria at N = 40/200/1000 with no thrashing, and every control
is checked against the real DOM. See [CHANGELOG.md](CHANGELOG.md) for the
architecture behind pause and the bugs it replaced.

## Worth trying

- **Price of anarchy**: a central planner forcing the 50/50 split would keep
  everyone at 65 even with the shortcut available. 80/65 ≈ 1.23 — never worse
  than 4/3 for networks like this one.
- **Watch it happen slowly**: drop Rounds/sec to 1–2 after adding a shortcut.
  Early switchers really do gain; it's the late ones who erase everyone's gain.
- **Change the constants** in `js/scenarios.js` (`CONSTANT_COST`,
  `CONGESTION_AT_FULL`) — the paradox only appears in a specific range; outside
  it the shortcut is either useless or a genuine improvement.

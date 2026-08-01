/*
 * tests/run.mjs — headless verification of V2.
 *
 *   node tests/run.mjs            # everything
 *   node tests/run.mjs pause      # only tests whose name contains "pause"
 *
 * Everything here drives the real page through `window.Braess.app`, which is the
 * same object the DOM handlers use. There is no test-only code path, so a pass
 * is a statement about the shipped app rather than about a mock of it.
 *
 * The pause tests are the point of the file. Eyeballing a canvas cannot tell you
 * whether dots are frozen or merely slow, so we read the actual dot coordinates
 * out of the render state, let real animation frames elapse, read them again,
 * and require bit-identical values.
 */

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE_URL = pathToFileURL(path.join(ROOT, 'index.html')).href;
const SHOT_DIR = path.join(ROOT, 'tests', 'screenshots');

const filter = process.argv[2];
// The classic network's one free road. Buttons are generated per toggleable edge,
// so they are addressed by edge key rather than by a fixed id.
const AB = '[data-edge="AB"]';
const results = [];
let browser;

// ---------------------------------------------------------------- test harness

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function assertClose(actual, expected, tol, message) {
  assert(
    Math.abs(actual - expected) <= tol,
    `${message} — expected ${expected} ±${tol}, got ${actual}`
  );
}

async function test(name, fn, contextOptions = {}) {
  if (filter && !name.includes(filter)) return;
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  try {
    await page.goto(PAGE_URL);
    await page.waitForFunction(() => window.Braess && window.Braess.app);
    await fn(page);
    assert(consoleErrors.length === 0, `console errors: ${consoleErrors.join('; ')}`);
    results.push({ name, ok: true });
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL  ${name}\n          ${err.message}`);
  } finally {
    await context.close();
  }
}

/** Wait for `n` real animation frames to be presented. */
const frames = (page, n = 10) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let seen = 0;
        const tick = () => (++seen >= count ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n
  );

const snapshot = (page) => page.evaluate(() => window.Braess.app.snapshot());

/**
 * Largest pixel displacement of any dot between two snapshots. Correct for
 * "did anything move at all" (0 means frozen), but not for measuring *how far*
 * something moved: a dot that finishes its trip wraps from T back to S, which is
 * hundreds of pixels of legitimate travel. Use maxLapProgress for magnitudes.
 */
const maxDotShift = (a, b) => {
  let worst = 0;
  for (let i = 0; i < a.dots.length; i++) {
    worst = Math.max(worst, Math.hypot(a.dots[i].x - b.dots[i].x, a.dots[i].y - b.dots[i].y));
  }
  return worst;
};

/** Largest forward progress along a route, in laps, wrap-safe. */
const maxLapProgress = (a, b) => {
  let worst = 0;
  for (let i = 0; i < a.dots.length; i++) {
    worst = Math.max(worst, (((b.dots[i].travel - a.dots[i].travel) % 1) + 1) % 1);
  }
  return worst;
};

/** Screenshot the page and assert the network canvas actually rendered. */
async function shoot(page, name) {
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  const { size } = await fs.stat(file);
  assert(size > 20000, `${name} screenshot looks empty (${size} bytes)`);

  // A rendered network canvas must not be a single flat colour.
  const distinct = await page.evaluate(() => {
    const c = document.getElementById('network');
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 97) {
      seen.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
    }
    return seen.size;
  });
  assert(distinct > 20, `${name}: network canvas has only ${distinct} distinct colours — probably blank`);
  console.log(`        wrote ${path.relative(ROOT, file)} (${(size / 1024).toFixed(0)} KB)`);
}

// ------------------------------------------------------------------- the tests

async function main() {
  browser = await chromium.launch();
  await fs.mkdir(SHOT_DIR, { recursive: true });

  // --- 1. the V1 bug: pause must freeze the dots, not just the round counter ---

  await test('pause freezes dots, rounds, chart and sim clock', async (page) => {
    await page.click('#play');
    await page.waitForTimeout(600); // let dots get mid-transit and rounds tick
    await page.click('#play');

    const before = await snapshot(page);
    assert(before.running === false, 'clock should report stopped after Pause');
    assert(before.round > 0, 'sim should have advanced while playing');
    assert(
      before.dots.some((d) => d.travel > 0.02 && d.travel < 0.98),
      'expected dots mid-transit, otherwise "frozen" proves nothing'
    );

    await page.waitForTimeout(1000);
    await frames(page, 30); // ~30 real frames the render loop could have moved on
    const after = await snapshot(page);

    assert(maxDotShift(before, after) === 0, `dots moved ${maxDotShift(before, after)}px while paused`);
    for (let i = 0; i < before.dots.length; i++) {
      assert(before.dots[i].travel === after.dots[i].travel, `dot ${i} phase changed while paused`);
      assert(before.dots[i].route === after.dots[i].route, `dot ${i} route changed while paused`);
    }
    assert(after.round === before.round, 'round counter advanced while paused');
    assert(after.simTime === before.simTime, 'sim clock advanced while paused');
    assert(after.historyLength === before.historyLength, 'chart history grew while paused');
    assert(after.avgCost === before.avgCost, 'avg cost changed while paused');

    // The DOM must agree with the model, not just the model with itself.
    assert((await page.textContent('#round')) === String(after.round), 'round readout desynced');
    assert((await page.textContent('#play')).includes('Play'), 'button should offer Play when paused');
  });

  await test('pause holds through a long stall, then resume continues without jumping', async (page) => {
    await page.click('#play');
    await page.waitForTimeout(500);
    await page.click('#play');
    const frozen = await snapshot(page);

    await page.waitForTimeout(2500); // a long pause: the resume-jump trap
    const stillFrozen = await snapshot(page);
    assert(maxDotShift(frozen, stillFrozen) === 0, 'dots drifted during the long pause');

    // The structural guarantee: a stopped clock holds no wall-time baseline, so
    // there is nothing for the first resumed frame to catch up against. Assert
    // it directly — the observable bound below is bounded by the per-frame dt
    // clamp anyway, so it alone could not distinguish a one-frame leak.
    assert(
      (await page.evaluate(() => window.Braess.app.clock.lastWall)) === null,
      'a stopped clock still holds a wall-time baseline — resume can replay the pause'
    );

    await page.click('#play');
    await frames(page, 4);
    await page.click('#play');
    const resumed = await snapshot(page);

    assert(maxDotShift(stillFrozen, resumed) > 0, 'dots did not resume moving');
    // 2.5s of replayed pause is ~0.96 of a lap. A handful of honest frames is a
    // few hundredths. Measured wrap-safe, so a dot crossing T→S is not mistaken
    // for a jump.
    const progress = maxLapProgress(stillFrozen, resumed);
    assert(progress < 0.15, `dots advanced ${progress.toFixed(3)} laps on resume — pause time leaked in`);
    assertClose(
      resumed.simTime - stillFrozen.simTime,
      0.07,
      0.25,
      'simulated time charged for the resume'
    );

    for (let i = 0; i < frozen.dots.length; i++) {
      assert(resumed.dots[i].travel !== 0 || frozen.dots[i].travel === 0, `dot ${i} phase was reset`);
    }
    assert(resumed.round >= stillFrozen.round, 'round counter went backwards on resume');
  });

  await test('pause survives a resize, and a frozen canvas still repaints', async (page) => {
    // Repainting a paused frame must not advance it. A resize is the remaining
    // trigger for that (the theme switch is gone), and it is the one that most
    // needs covering: the canvas backing store is only refitted inside draw().
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click('#play');
    await page.waitForTimeout(500);
    await page.click('#play');

    const before = await snapshot(page);
    const wide = await page.locator('#network').screenshot();

    await page.setViewportSize({ width: 1000, height: 900 });
    await frames(page, 6);
    const narrow = await page.locator('#network').screenshot();
    const after = await snapshot(page);

    assert(!wide.equals(narrow), 'paused canvas did not repaint after the resize');
    // Dot *pixel* positions legitimately move with the canvas, so the invariant
    // to assert is the trip phase — the actual animation state.
    for (let i = 0; i < before.dots.length; i++) {
      assert(before.dots[i].travel === after.dots[i].travel, `dot ${i} advanced across a resize`);
      assert(before.dots[i].route === after.dots[i].route, `dot ${i} changed route across a resize`);
    }
    assert(after.round === before.round, 'resize advanced the simulation');
    assert(after.simTime === before.simTime, 'resize advanced the sim clock');
  });

  // --- 2. the rest of the controls ---

  await test('step advances exactly one round and moves dots deterministically', async (page) => {
    const start = await snapshot(page);
    await page.click('#step');
    await frames(page, 3);
    const one = await snapshot(page);

    assert(one.round === start.round + 1, `step gave ${one.round - start.round} rounds, want 1`);
    assert(one.running === false, 'step must leave the clock paused');
    assert(maxDotShift(start, one) > 0, 'step did not move the dots at all');

    // A second step must be the same size, and must not run away afterwards.
    await page.click('#step');
    await frames(page, 3);
    const two = await snapshot(page);
    assert(two.round === start.round + 2, 'second step did not advance exactly one round');

    await page.waitForTimeout(400);
    await frames(page, 20);
    const idle = await snapshot(page);
    assert(idle.round === two.round, 'sim kept running after a step');
    assert(maxDotShift(two, idle) === 0, 'dots kept moving after a step');
  });

  await test('step is exact at every speed (float-safe round crediting)', async (page) => {
    for (const speed of [1, 7, 20, 59, 60]) {
      await page.evaluate(() => window.Braess.app.restart());
      await page.fill('#speed', String(speed));
      await page.dispatchEvent('#speed', 'input');
      const before = await snapshot(page);
      await page.click('#step');
      await frames(page, 3);
      const after = await snapshot(page);
      assert(
        after.round === before.round + 1,
        `at ${speed} rounds/sec a step gave ${after.round - before.round} rounds`
      );
    }
  });

  await test('speed slider is wired to the clock, with a matching readout', async (page) => {
    for (const speed of [1, 25, 60]) {
      await page.fill('#speed', String(speed));
      await page.dispatchEvent('#speed', 'input');
      assert(
        (await page.evaluate(() => window.Braess.app.clock.speed)) === speed,
        `clock.speed did not follow the slider to ${speed}`
      );
      assert((await page.textContent('#speed-value')) === String(speed), 'speed readout desynced');
    }
    // Changing speed must not start, stop, or advance anything by itself.
    const s = await snapshot(page);
    assert(s.running === false && s.round === 0, 'speed change disturbed the run state');
  });

  await test('speed setting governs the real round rate under rAF', async (page) => {
    // Measured on a standalone Clock driven by real animation frames. Doing this
    // end-to-end would measure the auto-pause instead: the sim settles in ~19
    // rounds, so at 60 rounds/sec the app legitimately stops a third of a second
    // in and the apparent rate collapses. The pacing contract belongs to the
    // Clock, so that is what gets timed.
    const observed = await page.evaluate(async (speeds) => {
      const out = {};
      for (const speed of speeds) {
        // Window sized so at least ~4 rounds are expected even at 1 round/sec;
        // otherwise a slow setting "passes" on a count of zero.
        const window_ms = Math.max(800, (4 / speed) * 1000);
        const clock = new window.Braess.Clock({ speed });
        clock.start();
        const t0 = performance.now();
        let rounds = 0;
        await new Promise((resolve) => {
          const tick = (now) => {
            rounds += clock.tick(now).rounds;
            if (performance.now() - t0 < window_ms) requestAnimationFrame(tick);
            else resolve();
          };
          requestAnimationFrame(tick);
        });
        out[speed] = rounds / ((performance.now() - t0) / 1000);
      }
      return out;
    }, [1, 10, 60]);

    for (const [speed, rate] of Object.entries(observed)) {
      // 20%, floored at 0.5 rounds/sec so the granularity of a whole round in a
      // short window is not mistaken for drift. Tight enough that a factor-of-two
      // error, or a zero count, cannot pass at any setting.
      const tol = Math.max(0.5, Number(speed) * 0.2);
      assertClose(rate, Number(speed), tol, `clock rate at ${speed} rounds/sec`);
    }
    console.log(
      `        measured: ${Object.entries(observed)
        .map(([s, r]) => `${s}→${r.toFixed(1)}`)
        .join(', ')} rounds/sec`
    );
  });

  await test('speed setting changes end-to-end pacing', async (page) => {
    // The observable end-to-end consequence: slow enough and the system has not
    // settled yet in the same wall-clock window in which fast has finished.
    const roundsIn = async (speed) => {
      await page.evaluate(() => window.Braess.app.restart());
      await page.fill('#speed', String(speed));
      await page.dispatchEvent('#speed', 'input');
      await page.click('#play');
      await page.waitForTimeout(600);
      const s = await snapshot(page);
      await page.evaluate(() => window.Braess.app.setRunning(false));
      return s;
    };

    const slow = await roundsIn(2);
    assert(slow.round <= 4, `at 2 rounds/sec, 600ms gave ${slow.round} rounds`);
    assert(!slow.settled, 'at 2 rounds/sec the sim should not have settled in 600ms');

    const fast = await roundsIn(60);
    assert(fast.round > slow.round, `60 rounds/sec (${fast.round}) not faster than 2 (${slow.round})`);
    assert(fast.settled, 'at 60 rounds/sec the sim should have settled within 600ms');
  });

  await test('reset returns every piece of state to a cold start', async (page) => {
    await page.click('#play');
    await page.waitForTimeout(400);
    await page.click(AB);
    await page.waitForTimeout(300);
    await page.click('#reset');
    await frames(page, 3);

    const s = await snapshot(page);
    const N = await page.evaluate(() => window.Braess.app.graph.population);
    assert(s.round === 0, `round is ${s.round} after reset`);
    assert(s.running === false, 'reset must leave the clock stopped');
    assert(s.simTime === 0, 'sim clock not zeroed by reset');
    assert(s.historyLength === 1, `history has ${s.historyLength} entries after reset, want 1`);
    assert(s.counts[0] === N && s.counts[1] === 0 && s.counts[2] === 0, `counts ${s.counts}`);
    assert(s.dots.every((d) => d.route === 0), 'dots not all back on R1 after reset');
    assert(
      await page.evaluate(() => window.Braess.app.graph.enabled.size === 0),
      'reset must remove every free road'
    );
    assert((await page.textContent(AB)).includes('Add'), 'road button label desynced');

    // Fractional round carry must not survive a reset and fire a free round.
    await page.waitForTimeout(300);
    await frames(page, 20);
    assert((await snapshot(page)).round === 0, 'a round fired after reset without Play');
  });

  await test('removing the shortcut leaves no dots on the deleted road', async (page) => {
    await page.click(AB);
    await page.click('#play');
    await page.waitForTimeout(1500); // let traffic pile onto R3
    await page.click('#play');

    const loaded = await snapshot(page);
    assert(
      loaded.dots.some((d) => d.route === 2),
      'expected dots on the shortcut route before removing it'
    );

    await page.click(AB); // remove it while paused
    const s = await snapshot(page);
    assert(!s.dots.some((d) => d.route === 2), 'dots still driving the removed shortcut');
    assert(s.counts[2] === 0, 'agents still assigned to the removed route');

    // Snapping roads must not teleport dots along their trip.
    const phasesKept = s.dots.filter((d, i) => d.travel === loaded.dots[i].travel).length;
    assert(phasesKept === s.dots.length, 'snapping to the fallback road reset dot phases');
  });

  await test('population slider rebuilds sim and dots atomically', async (page) => {
    for (const N of [40, 200, 1000]) {
      await page.fill('#population', String(N));
      await page.dispatchEvent('#population', 'input');
      await frames(page, 3);

      const s = await snapshot(page);
      const info = await page.evaluate(() => ({
        population: window.Braess.app.graph.population,
        dots: window.Braess.app.networkView.travel.length,
        agents: window.Braess.app.sim.agents.length,
        coeff: window.Braess.app.graph.edges.SA.coeff,
      }));
      assert(info.population === N, `population is ${info.population}, want ${N}`);
      assert(info.agents === N, `agent array is ${info.agents}, want ${N}`);
      assert(info.dots === Math.min(N, 400), `dot count ${info.dots} for N=${N}`);
      assert(s.counts[0] === N, `counts[0] is ${s.counts[0]}, want ${N}`);
      assert(s.round === 0, 'changing N must restart the run');
      assert(s.running === false, 'changing N must leave the clock stopped');
      assertClose(info.coeff * N, 40, 1e-9, 'congestion coefficient not renormalized');
      assert((await page.textContent('#population-value')) === String(N), 'N readout desynced');
      assert(s.dots.every((d) => d.route === 0), 'dots not rebuilt onto R1');
    }
  });

  await test('auto-pause on equilibrium stops the dots too', async (page) => {
    await page.click('#play');
    await page.waitForFunction(() => window.Braess.app.sim.atEquilibrium(), null, { timeout: 15000 });
    await frames(page, 5);

    const settled = await snapshot(page);
    assert(settled.running === false, 'auto-pause did not stop the clock');
    await page.waitForTimeout(600);
    await frames(page, 20);
    const later = await snapshot(page);
    assert(maxDotShift(settled, later) === 0, 'dots kept moving after auto-pause');
    assert((await page.textContent('#eq-badge')).includes('Equilibrium'), 'badge did not settle');
  });

  // --- 3. the equilibrium claims, re-verified against the refactored sim ---

  await test('convergence claims still hold after the refactor', async (page) => {
    for (const N of [40, 200, 1000]) {
      const out = await page.evaluate((population) => {
        const { Graph, Simulation, SCENARIOS } = window.Braess;
        const graph = new Graph(SCENARIOS[0], population);
        const sim = new Simulation(graph);

        const run = (rounds) => {
          for (let i = 0; i < rounds; i++) sim.step();
        };
        const tail = (n) => sim.history.slice(-n);
        const stats = (rows) => ({
          min: Math.min(...rows.map((r) => r.avgCost)),
          max: Math.max(...rows.map((r) => r.avgCost)),
          switches: rows.reduce((a, r) => a + r.switches, 0),
        });

        // Phase 1: no shortcut. Expect the 50/50 split at 65.
        run(3000);
        const noShortcut = { cost: sim.avgCost(), counts: Array.from(sim.counts), ...stats(tail(1000)) };
        const settledAt = sim.history.findIndex((h, i) => i > 0 && Math.abs(h.avgCost - 65) < 0.5);

        // Phase 2: add the shortcut. Expect everyone on R3 at 80.
        sim.toggleEdge('AB');
        run(3000);
        const withShortcut = { cost: sim.avgCost(), counts: Array.from(sim.counts), ...stats(tail(1000)) };

        // Phase 3: take it away again. Expect a relaxation back to 65.
        sim.toggleEdge('AB');
        run(3000);
        const removed = { cost: sim.avgCost(), counts: Array.from(sim.counts), ...stats(tail(1000)) };

        return { noShortcut, withShortcut, removed, settledAt, equilibrium: sim.atEquilibrium() };
      }, N);

      const half = N / 2;
      assertClose(out.noShortcut.cost, 65, 0.01, `N=${N}: no-shortcut equilibrium cost`);
      assert(
        out.noShortcut.counts[0] === half && out.noShortcut.counts[1] === half,
        `N=${N}: no-shortcut split is ${out.noShortcut.counts}, want ${half}/${half}`
      );
      assert(
        out.withShortcut.counts[2] === N,
        `N=${N}: with-shortcut split is ${out.withShortcut.counts}, want all ${N} on R3`
      );
      assertClose(out.withShortcut.cost, 80, 0.01, `N=${N}: with-shortcut equilibrium cost`);
      assertClose(out.removed.cost, 65, 0.01, `N=${N}: cost after removing the shortcut`);
      assert(out.equilibrium, `N=${N}: not at equilibrium after 9000 rounds`);
      assert(out.settledAt > 0 && out.settledAt < 400, `N=${N}: settled at round ${out.settledAt}`);

      // No thrashing: once settled, the last 1000 rounds of each phase must be
      // flat and switch-free, not oscillating around a near-tie.
      for (const [phase, st] of Object.entries(out)) {
        if (!st || typeof st.switches !== 'number') continue;
        assert(st.switches === 0, `N=${N}: ${st.switches} switches in the last 1000 rounds of ${phase}`);
        assertClose(st.max - st.min, 0, 0.01, `N=${N}: avg cost band over the last 1000 rounds of ${phase}`);
      }
      console.log(
        `        classic N=${N}: 65 → ${out.withShortcut.cost.toFixed(1)} → ${out.removed.cost.toFixed(1)}` +
          `, settled by round ${out.settledAt}, 0 switches in each tail`
      );
    }
  });

  await test('double network compounds the paradox: 130 → 145 → 160', async (page) => {
    for (const N of [40, 200, 1000]) {
      const out = await page.evaluate((population) => {
        const { Graph, Simulation, SCENARIOS } = window.Braess;
        const scenario = SCENARIOS.find((s) => s.id === 'double');
        const graph = new Graph(scenario, population);
        const sim = new Simulation(graph);

        const run = (rounds) => {
          for (let i = 0; i < rounds; i++) sim.step();
        };
        const tail = (n) => sim.history.slice(-n);
        const phase = () => {
          const rows = tail(1000);
          const flows = graph.edgeFlows(sim.counts);
          return {
            cost: sim.avgCost(),
            settled: sim.atEquilibrium(),
            // The equilibrium is unique in edge flows but not in route counts:
            // any mix leaving each congestible edge at the same load is equally
            // an equilibrium, so the flows are what must be asserted.
            congestible: Object.fromEntries(
              Object.entries(flows).filter(([k]) => graph.edges[k].congestible)
            ),
            switches: rows.reduce((a, r) => a + r.switches, 0),
            band: Math.max(...rows.map((r) => r.avgCost)) - Math.min(...rows.map((r) => r.avgCost)),
          };
        };

        run(3000);
        const none = phase();
        sim.toggleEdge('A1B1');
        run(3000);
        const first = phase();
        sim.toggleEdge('A2B2');
        run(3000);
        const both = phase();
        // Demolish only the first road: the second half must stay collapsed.
        sim.toggleEdge('A1B1');
        run(3000);
        const second = phase();

        return { none, first, both, second, routes: graph.routes.length };
      }, N);

      assert(out.routes === 9, `expected 9 enumerated routes, got ${out.routes}`);
      const half = N / 2;
      const expected = {
        none: [130, { SA1: half, B1M: half, MA2: half, B2T: half }],
        first: [145, { SA1: N, B1M: N, MA2: half, B2T: half }],
        both: [160, { SA1: N, B1M: N, MA2: N, B2T: N }],
        second: [145, { SA1: half, B1M: half, MA2: N, B2T: N }],
      };

      for (const [name, [cost, flows]] of Object.entries(expected)) {
        const got = out[name];
        assertClose(got.cost, cost, 0.01, `N=${N}: ${name} equilibrium cost`);
        assert(got.settled, `N=${N}: ${name} did not reach equilibrium in 3000 rounds`);
        for (const [edge, load] of Object.entries(flows)) {
          assert(
            got.congestible[edge] === load,
            `N=${N}: ${name} load on ${edge} is ${got.congestible[edge]}, want ${load}`
          );
        }
        assert(got.switches === 0, `N=${N}: ${got.switches} switches in the last 1000 rounds of ${name}`);
        assertClose(got.band, 0, 0.01, `N=${N}: avg cost band over the last 1000 rounds of ${name}`);
      }

      // The whole point of this network: each free road costs the same 15 again.
      assertClose(out.first.cost - out.none.cost, 15, 0.01, `N=${N}: first road's damage`);
      assertClose(out.both.cost - out.first.cost, 15, 0.01, `N=${N}: second road's damage`);
      console.log(
        `        double  N=${N}: ${out.none.cost.toFixed(0)} → ${out.first.cost.toFixed(0)} → ` +
          `${out.both.cost.toFixed(0)}, one removed → ${out.second.cost.toFixed(0)}, 0 switches in each tail`
      );
    }
  });

  await test('scenario tab rebuilds every scenario-shaped piece of state', async (page) => {
    // Dirty the classic network first, so a stale fragment would show up.
    await page.click(AB);
    await page.click('#play');
    await page.waitForTimeout(600);

    await page.click('.tab:nth-child(2)');
    await frames(page, 3);

    const s = await snapshot(page);
    const dom = await page.evaluate(() => ({
      routes: window.Braess.app.graph.routes.length,
      nodes: Object.keys(window.Braess.app.graph.nodes),
      tableRows: document.querySelectorAll('#route-rows tr').length,
      roadButtons: Array.from(document.querySelectorAll('#shortcut-buttons button')).map(
        (b) => b.dataset.edge
      ),
      legendRows: document.querySelectorAll('#edge-legend li').length,
      notes: document.querySelectorAll('#scenario-notes li').length,
      activeTabs: Array.from(document.querySelectorAll('.tab.active')).map((b) => b.textContent),
      theoryLines: window.Braess.app.graph.theory.length,
      dots: window.Braess.app.networkView.visualRoute.length,
    }));

    assert(s.scenario === 'double', `switched to ${s.scenario}`);
    assert(s.running === false, 'switching scenario must leave the clock stopped');
    assert(s.round === 0, `round is ${s.round} after switching`);
    assert(s.historyLength === 1, `history has ${s.historyLength} entries after switching`);
    assert(s.enabled.length === 0, `free roads ${s.enabled} carried over from the last network`);
    assert(dom.routes === 9 && dom.tableRows === 9, `route table has ${dom.tableRows} rows for 9 routes`);
    assert(dom.legendRows === 10, `legend has ${dom.legendRows} rows for 10 edges`);
    assert(dom.notes === 3, `walkthrough has ${dom.notes} steps`);
    assert(dom.theoryLines === 3, `chart has ${dom.theoryLines} reference lines`);
    assert(dom.nodes.join() === 'S,A1,B1,M,A2,B2,T', `nodes are ${dom.nodes}`);
    assert(dom.roadButtons.join() === 'A1B1,A2B2', `road buttons are ${dom.roadButtons}`);
    assert(dom.activeTabs.length === 1 && dom.activeTabs[0] === 'Double Braess', `active tab ${dom.activeTabs}`);
    // Dots must describe the new network, not index into the old route list.
    assert(s.counts[0] === 100, `counts[0] is ${s.counts[0]} after switching`);
    assert(s.dots.every((d) => d.route === 0), 'dots not rebuilt onto the first route');
    assert(s.dots.every((d) => Number.isFinite(d.x) && Number.isFinite(d.y)), 'dot positions are NaN');

    // And back again, to prove a scenario object survives being unloaded.
    await page.click('.tab:nth-child(1)');
    await frames(page, 3);
    const back = await snapshot(page);
    assert(back.scenario === 'classic', `switched back to ${back.scenario}`);
    assert(back.counts.length === 3, `classic has ${back.counts.length} routes after a round trip`);
    assertClose(back.avgCost, 85, 0.01, 'classic did not return to its cold-start cost');
  });

  await test('the two free roads are independent', async (page) => {
    await page.evaluate(() => window.Braess.app.selectScenarioById('double'));
    await frames(page, 3);

    await page.click('[data-edge="A1B1"]');
    let s = await snapshot(page);
    assert(s.enabled.join() === 'A1B1', `enabled is ${s.enabled} after building the first road`);
    assert(
      (await page.textContent('[data-edge="A2B2"]')).includes('Add'),
      'building one road changed the other button'
    );

    await page.click('[data-edge="A2B2"]');
    s = await snapshot(page);
    assert(s.enabled.sort().join() === 'A1B1,A2B2', `enabled is ${s.enabled} with both roads`);

    // Run to the both-roads equilibrium, then demolish only the first. Every
    // route needing A1B1 dies at once — six of the nine — and no dot may be left
    // driving any of them.
    await page.click('#play');
    await page.waitForFunction(() => window.Braess.app.sim.atEquilibrium(), null, { timeout: 20000 });
    const settled = await snapshot(page);
    assertClose(settled.avgCost, 160, 0.01, 'both-roads equilibrium');

    await page.click('[data-edge="A1B1"]');
    const after = await snapshot(page);
    const dead = await page.evaluate(() =>
      window.Braess.app.graph.routes
        .map((r, i) => (window.Braess.app.graph.isRouteActive(i) ? null : i))
        .filter((i) => i !== null)
    );
    assert(dead.length === 3, `expected 3 routes to die with A1B1, got ${dead.length}`);
    assert(!after.dots.some((d) => dead.includes(d.route)), 'dots still driving a demolished route');
    assert(
      dead.every((i) => after.counts[i] === 0),
      'agents still assigned to a demolished route'
    );
    assert(after.enabled.join() === 'A2B2', `enabled is ${after.enabled} after demolishing A1B1`);
  });

  // --- 4. screenshots, both themes ---

  await test('screenshot check (classic)', async (page) => {
    await page.setViewportSize({ width: 1280, height: 980 });
    await page.click('#play');
    await page.waitForFunction(() => window.Braess.app.sim.atEquilibrium(), null, { timeout: 15000 });
    await page.click(AB);
    await page.click('#play');
    await page.waitForFunction(() => window.Braess.app.sim.counts[2] > 0, null, { timeout: 15000 });
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.Braess.app.setRunning(false));
    await frames(page, 5);
    await shoot(page, 'classic');
  });

  await test('screenshot check (double)', async (page) => {
    await page.setViewportSize({ width: 1280, height: 1080 });
    await page.evaluate(() => window.Braess.app.selectScenarioById('double'));
    await page.click('[data-edge="A1B1"]');
    await page.click('[data-edge="A2B2"]');
    await page.click('#play');
    await page.waitForFunction(() => window.Braess.app.sim.atEquilibrium(), null, { timeout: 20000 });
    await frames(page, 5);

    // The picture is only worth keeping if it shows the punchline.
    const s = await snapshot(page);
    assertClose(s.avgCost, 160, 0.01, 'double network screenshot is not at the 160 equilibrium');
    await shoot(page, 'double');
  });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('failures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.err.message}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  if (browser) browser.close();
  process.exit(1);
});

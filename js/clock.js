/*
 * clock.js — the single source of truth for "is the simulation running", and
 * the only thing in the app allowed to look at wall time.
 *
 * V1's bug was architectural: `playing` was a private variable in main.js that
 * gated round advancement, while the dot animation integrated `performance.now()`
 * deltas on its own. Two clocks, one button. Pause could not possibly work.
 *
 * V2 inverts that. Nothing downstream sees wall time; everything is handed a
 * *simulated* delta produced here. Paused means `tick()` returns zero, so every
 * consumer freezes for the same reason at the same instant, and resuming
 * continues from the frozen state because nothing was reset to do it.
 *
 * Two structural guarantees worth stating explicitly:
 *
 *   1. `lastWall` is cleared whenever the clock stops, and re-baselined on the
 *      first tick after it starts. A long pause therefore cannot produce a huge
 *      catch-up delta — the dots cannot jump on resume. This is a property of
 *      the design, not a remembered special case.
 *   2. Rounds are counted here rather than derived downstream from `dt * speed`.
 *      `step()` credits whole rounds directly, so a single step always yields
 *      exactly one round regardless of floating-point luck at the current speed
 *      (1/60 * 60 === 0.9999999999999999, which a derived count would swallow).
 */

const MAX_WALL_DT = 0.05; // clamp catch-up after a tab switch, in seconds
const MAX_ROUNDS_PER_TICK = 20; // never block a frame on a huge backlog

class Clock {
  constructor({ speed = 20 } = {}) {
    this.speed = speed; // rounds per second of simulated time
    this.running = false;
    this.simTime = 0; // seconds of simulated time elapsed
    this.rounds = 0; // whole rounds delivered so far
    this.lastWall = null; // null whenever stopped; re-baselined on resume
    this.accumulator = 0; // fractional round carry
    this.pendingRounds = 0; // whole rounds injected by step()
    this.pendingDt = 0; // simulated seconds injected by step()
    this.droppedRounds = 0; // rounds discarded to the per-tick cap
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastWall = null; // first tick after resume contributes no elapsed time
  }

  stop() {
    this.running = false;
    this.lastWall = null;
  }

  toggle() {
    if (this.running) this.stop();
    else this.start();
    return this.running;
  }

  /**
   * Credit `n` whole rounds and the simulated time they represent, without
   * starting the clock. Used by the Step button: the sim advances and the dots
   * move by a deterministic amount, while the clock stays paused.
   */
  step(n = 1) {
    this.pendingRounds += n;
    this.pendingDt += n / this.speed;
  }

  /** Back to a cold start. Does not touch `speed`, which is a user preference. */
  reset() {
    this.stop();
    this.simTime = 0;
    this.rounds = 0;
    this.accumulator = 0;
    this.pendingRounds = 0;
    this.pendingDt = 0;
    this.droppedRounds = 0;
  }

  /**
   * Advance simulated time. `wallNow` is a `performance.now()` reading, used
   * only when running. Returns `{ dt, rounds }` — both zero when the clock is
   * paused and nothing is pending, which is what freezes the whole app.
   */
  tick(wallNow) {
    const injectedRounds = this.pendingRounds;
    const injectedDt = this.pendingDt;
    this.pendingRounds = 0;
    this.pendingDt = 0;

    let elapsedDt = 0;
    if (this.running) {
      if (this.lastWall === null) this.lastWall = wallNow;
      elapsedDt = Math.min(MAX_WALL_DT, (wallNow - this.lastWall) / 1000);
      this.lastWall = wallNow;
    }

    // Only elapsed time accrues fractional rounds; injected rounds are already
    // whole and bypass the accumulator, so Step is exact at every speed.
    this.accumulator += elapsedDt * this.speed;
    const whole = Math.floor(this.accumulator);
    this.accumulator -= whole;

    let rounds = injectedRounds + whole;
    if (rounds > MAX_ROUNDS_PER_TICK) {
      this.droppedRounds += rounds - MAX_ROUNDS_PER_TICK;
      rounds = MAX_ROUNDS_PER_TICK;
    }

    const dt = injectedDt + elapsedDt;
    this.simTime += dt;
    this.rounds += rounds;
    return { dt, rounds };
  }
}

window.Braess = window.Braess || {};
window.Braess.Clock = Clock;

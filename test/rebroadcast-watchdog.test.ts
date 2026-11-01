import test from 'node:test';
import assert from 'node:assert/strict';
import { HUNG_AFTER, NvrOutageWatch, OUTAGE_MIN_MS, RebroadcastHangWatch, RECONNECT_DELAY_MS, RESTART_MIN_INTERVAL_MS, WatchdogDeps } from '../src/rebroadcast-watchdog';

/** A fake clock whose timers run when time is advanced past them. */
function clock() {
    let now = 1_000_000;
    let timers: { at: number; fn: () => void; id: number }[] = [];
    let next = 0;
    const deps: WatchdogDeps = {
        now: () => now,
        setTimer: (fn, ms) => { const id = ++next; timers.push({ at: now + ms, fn, id }); return id; },
        clearTimer: t => { timers = timers.filter(x => x.id !== t); },
    };
    const advance = (ms: number) => {
        now += ms;
        const due = timers.filter(t => t.at <= now);
        timers = timers.filter(t => t.at > now);
        for (const t of due) t.fn();
    };
    return { deps, advance, pending: () => timers.length };
}

test('outage: the first connection restarts nothing', () => {
    const c = clock(), fired: number[] = [];
    const w = new NvrOutageWatch(ms => fired.push(ms), c.deps);
    w.state(false);
    c.advance(5 * OUTAGE_MIN_MS);
    w.state(true);
    c.advance(RECONNECT_DELAY_MS * 2);
    assert.deepEqual(fired, []);
});

test('outage: back after a long outage restarts once, after the reconnect delay', () => {
    const c = clock(), fired: number[] = [];
    const w = new NvrOutageWatch(ms => fired.push(ms), c.deps);
    w.state(true);
    w.state(false);
    c.advance(OUTAGE_MIN_MS + 5000);
    // reconnect attempts in between do not move the outage start
    w.state(false);
    w.state(true);
    c.advance(RECONNECT_DELAY_MS - 1);
    assert.deepEqual(fired, []);
    c.advance(1);
    assert.deepEqual(fired, [OUTAGE_MIN_MS + 5000]);
    c.advance(RECONNECT_DELAY_MS * 3);
    assert.equal(fired.length, 1);
});

test('outage: a short blip restarts nothing', () => {
    const c = clock(), fired: number[] = [];
    const w = new NvrOutageWatch(ms => fired.push(ms), c.deps);
    w.state(true);
    w.state(false);
    c.advance(OUTAGE_MIN_MS - 1);
    w.state(true);
    c.advance(RECONNECT_DELAY_MS * 2);
    assert.deepEqual(fired, []);
});

test('outage: lost again before the delay ends cancels the restart; the next return restarts', () => {
    const c = clock(), fired: number[] = [];
    const w = new NvrOutageWatch(ms => fired.push(ms), c.deps);
    w.state(true);
    w.state(false);
    c.advance(OUTAGE_MIN_MS);
    w.state(true);
    c.advance(RECONNECT_DELAY_MS / 2);
    w.state(false);
    assert.equal(c.pending(), 0);
    c.advance(OUTAGE_MIN_MS);
    w.state(true);
    c.advance(RECONNECT_DELAY_MS);
    assert.deepEqual(fired, [OUTAGE_MIN_MS]);
});

test('outage: dispose cancels a pending restart', () => {
    const c = clock(), fired: number[] = [];
    const w = new NvrOutageWatch(ms => fired.push(ms), c.deps);
    w.state(true);
    w.state(false);
    c.advance(OUTAGE_MIN_MS);
    w.state(true);
    w.dispose();
    c.advance(RECONNECT_DELAY_MS);
    assert.deepEqual(fired, []);
});

test('hang: restarts after HUNG_AFTER timeouts in a row while the NVR is online', () => {
    let now = 0;
    const h = new RebroadcastHangWatch(() => now);
    for (let i = 1; i < HUNG_AFTER; i++) assert.equal(h.timedOut(true), false);
    assert.equal(h.timedOut(true), true);
});

test('hang: an answer in between resets the count', () => {
    const h = new RebroadcastHangWatch(() => 0);
    for (let i = 1; i < HUNG_AFTER; i++) h.timedOut(true);
    h.ok();
    assert.equal(h.timedOut(true), false);
});

test('hang: timeouts while the NVR is offline never restart and reset the count', () => {
    const h = new RebroadcastHangWatch(() => 0);
    for (let i = 0; i < HUNG_AFTER * 3; i++) assert.equal(h.timedOut(false), false);
    for (let i = 1; i < HUNG_AFTER; i++) assert.equal(h.timedOut(true), false);
});

test('hang: at most one restart per interval, counting restarts for any reason', () => {
    let now = 0;
    const h = new RebroadcastHangWatch(() => now);
    h.restarted();
    now += RESTART_MIN_INTERVAL_MS - 1;
    for (let i = 0; i < HUNG_AFTER * 2; i++) assert.equal(h.timedOut(true), false);
    now += 1;
    assert.equal(h.timedOut(true), true);
});

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { NvrOutageWatch, OUTAGE_MIN_MS, RebroadcastHangWatch, RECONNECT_DELAY_MS, RESTART_MIN_INTERVAL_MS } from '../src/rebroadcast-watchdog';

/** Fake setTimeout and Date for the test's body. */
function fakeTime(t: { after: (fn: () => void) => void }) {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    t.after(() => mock.timers.reset());
    return (ms: number) => mock.timers.tick(ms);
}

test('outage: the first connection restarts nothing', t => {
    const tick = fakeTime(t), fired: number[] = [];
    const w = new NvrOutageWatch(ms => fired.push(ms));
    w.state(false);
    tick(5 * OUTAGE_MIN_MS);
    w.state(true);
    tick(RECONNECT_DELAY_MS * 2);
    assert.deepEqual(fired, []);
});

test('outage: back after a long outage restarts once, after the reconnect delay', t => {
    const tick = fakeTime(t), fired: number[] = [];
    const w = new NvrOutageWatch(ms => fired.push(ms));
    w.state(true);
    w.state(false);
    tick(OUTAGE_MIN_MS + 5000);
    // reconnect attempts in between do not move the outage start
    w.state(false);
    w.state(true);
    tick(RECONNECT_DELAY_MS - 1);
    assert.deepEqual(fired, []);
    tick(1);
    assert.deepEqual(fired, [OUTAGE_MIN_MS + 5000]);
    tick(RECONNECT_DELAY_MS * 3);
    assert.equal(fired.length, 1);
});

test('outage: a short blip restarts nothing', t => {
    const tick = fakeTime(t), fired: number[] = [];
    const w = new NvrOutageWatch(ms => fired.push(ms));
    w.state(true);
    w.state(false);
    tick(OUTAGE_MIN_MS - 1);
    w.state(true);
    tick(RECONNECT_DELAY_MS * 2);
    assert.deepEqual(fired, []);
});

test('outage: lost again before the delay ends cancels the restart; the next return restarts', t => {
    const tick = fakeTime(t), fired: number[] = [];
    const w = new NvrOutageWatch(ms => fired.push(ms));
    w.state(true);
    w.state(false);
    tick(OUTAGE_MIN_MS);
    w.state(true);
    tick(RECONNECT_DELAY_MS / 2);
    w.state(false);
    tick(OUTAGE_MIN_MS);
    assert.deepEqual(fired, []);
    w.state(true);
    tick(RECONNECT_DELAY_MS);
    assert.deepEqual(fired, [OUTAGE_MIN_MS]);
});

test('outage: dispose cancels a pending restart', t => {
    const tick = fakeTime(t), fired: number[] = [];
    const w = new NvrOutageWatch(ms => fired.push(ms));
    w.state(true);
    w.state(false);
    tick(OUTAGE_MIN_MS);
    w.state(true);
    w.dispose();
    tick(RECONNECT_DELAY_MS);
    assert.deepEqual(fired, []);
});

test('hang: restarts after two timeouts in a row while the NVR is online', t => {
    fakeTime(t);
    const h = new RebroadcastHangWatch();
    assert.equal(h.timedOut(true), false);
    assert.equal(h.timedOut(true), true);
});

test('hang: an answer in between resets the count', t => {
    fakeTime(t);
    const h = new RebroadcastHangWatch();
    h.timedOut(true);
    h.ok();
    assert.equal(h.timedOut(true), false);
});

test('hang: timeouts while the NVR is offline never restart and reset the count', t => {
    fakeTime(t);
    const h = new RebroadcastHangWatch();
    for (let i = 0; i < 6; i++) assert.equal(h.timedOut(false), false);
    assert.equal(h.timedOut(true), false);
});

test('hang: at most one restart per interval, counting restarts for any reason', t => {
    const tick = fakeTime(t);
    const h = new RebroadcastHangWatch();
    h.restarted();
    tick(RESTART_MIN_INTERVAL_MS - 1);
    for (let i = 0; i < 4; i++) assert.equal(h.timedOut(true), false);
    tick(1);
    assert.equal(h.timedOut(true), true);
});

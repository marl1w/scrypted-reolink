import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionConfig, MotionController } from '../src/motion';
import { PushEvent } from '../src/baichuan/events';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alarm = (motion: boolean, ai: string[] = []): PushEvent => ({ kind: 'alarm', channel: 0, motion, ai: new Set(ai), status: motion ? ['MD'] : [] });
const daynight = (mode: string): PushEvent => ({ kind: 'daynight', channel: 0, motion: false, ai: new Set(), status: [], dayNight: mode });

function setup(cfg: Partial<MotionConfig> = {}) {
    const log: string[] = [];
    const c: MotionConfig = { timeoutMs: 80, dayNightIgnoreMs: 0, trigger: 'Motion + AI', repeatMs: 30, ...cfg };
    const m = new MotionController(() => c, {
        setMotion: on => log.push(`motion=${on}`),
        detections: cl => log.push(`det=${cl.join(',')}`),
        dayNight: d => log.push(`dn=${d}`),
    });
    return { m, log, c };
}

test('motion turns on, holds for the timeout after the last active push, then off', async () => {
    const { m, log } = setup();
    m.handle(alarm(true));
    m.handle(alarm(false));
    assert.deepEqual(log, ['motion=true']);
    await sleep(50);
    assert.equal(m.motion, true);
    await sleep(60);
    assert.deepEqual(log, ['motion=true', 'motion=false']);
    m.dispose();
});

test('a new push extends the hold; a still-active level keeps extending', async () => {
    const { m, log } = setup();
    m.handle(alarm(true));
    await sleep(150);
    assert.equal(m.motion, true, 'level still active, repeat keeps it on');
    m.handle(alarm(false));
    await sleep(40);
    assert.equal(m.motion, true);
    await sleep(80);
    assert.equal(m.motion, false);
    assert.deepEqual(log.filter(l => l.startsWith('motion')), ['motion=true', 'motion=false']);
    m.dispose();
});

test('AI classes map to detections with the device class names, before motion; "other" is motion only', () => {
    const { m, log } = setup({ repeatMs: 10000 });
    m.handle(alarm(true, ['people', 'vehicle', 'other']));
    assert.deepEqual(log, ['det=people,vehicle', 'motion=true']);
    m.handle(alarm(false, ['dog_cat', 'face', 'package']));
    assert.equal(log.at(-1), 'det=dog_cat,face,package');
    m.dispose();
});

test('AI Only ignores raw motion but not AI', () => {
    const { m, log } = setup({ trigger: 'AI Only' });
    m.handle(alarm(true));
    assert.deepEqual(log, []);
    m.handle(alarm(true, ['people']));
    assert.deepEqual(log, ['det=people', 'motion=true']);
    m.dispose();
});

test('raw motion right after a day/night switch is ignored when configured', async () => {
    const { m, log } = setup({ dayNightIgnoreMs: 50 });
    m.handle(daynight('night'));
    m.handle(alarm(true));
    assert.deepEqual(log, ['dn=night']);
    assert.equal(m.dayNight, 'night');
    await sleep(60);
    m.handle(alarm(true));
    assert.deepEqual(log, ['dn=night', 'motion=true']);
    m.dispose();
});

test('raw reports every push as the camera states it, ignoring trigger rules and holds, and unknown on reset', () => {
    const raw: string[] = [];
    const c: MotionConfig = { timeoutMs: 80, dayNightIgnoreMs: 60000, trigger: 'AI Only', repeatMs: 30 };
    const m = new MotionController(() => c, {
        setMotion: () => { },
        detections: () => { },
        raw: (motion, classes) => raw.push(`${motion}:${classes.join(',')}`),
    });
    m.handle(daynight('night'));
    m.handle(alarm(true));
    m.handle(alarm(true, ['people', 'other']));
    m.handle(alarm(false));
    m.reset();
    assert.deepEqual(raw, ['true:', 'true:people', 'false:', 'undefined:']);
    m.dispose();
});

test('the last class clearing emits one empty detection list; pulses only while classes are active', async () => {
    const { m, log } = setup({ repeatMs: 20, timeoutMs: 1000 });
    m.handle(alarm(true, ['people']));
    await sleep(50);
    const pulses = log.filter(l => l === 'det=people').length;
    assert.ok(pulses >= 2, `pulses while active (${pulses})`);
    m.handle(alarm(true));
    assert.equal(log.at(-1), 'det=', 'cleared at once');
    await sleep(50);
    assert.equal(log.filter(l => l === 'det=').length, 1, 'once');
    assert.equal(log.filter(l => l === 'det=people').length, pulses, 'no pulse after clearing');
    m.handle(alarm(false));
    assert.equal(log.filter(l => l === 'det=').length, 1, 'nothing to clear twice');
    m.handle(alarm(true, ['vehicle']));
    m.reset();
    assert.equal(log.at(-1), 'det=', 'connection lost with a class active: cleared');
    m.reset();
    assert.equal(log.filter(l => l === 'det=').length, 2);
    m.dispose();
});

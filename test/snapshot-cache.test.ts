import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyframeAssembler, KeyframeCache, nalTypes } from '../src/snapshot-cache';

const nal = (type: number, n: number, four = true) => Buffer.from([...(four ? [0] : []), 0, 0, 1, type, n, n]);
const au = (...types: number[]) => Buffer.concat(types.map(t => nal(t, t)));
const key = au(0x67, 0x68, 0x65);
const delta = au(0x41);

test('assembler cuts whole keyframes out of a raw stream across chunk boundaries', () => {
    const a = new KeyframeAssembler();
    const all = Buffer.concat([Buffer.from([7, 7]), delta, key, au(0x65), delta, delta, au(0x67, 0x68), nal(0x65, 9, false), delta, delta]);
    const out: Buffer[] = [];
    for (let i = 0; i < all.length; i += 5) out.push(...a.push(all.subarray(i, i + 5)));
    assert.equal(out.length, 2);
    assert.deepEqual(nalTypes(out[0]), [7, 8, 5, 5]);
    assert.deepEqual(nalTypes(out[1]), [7, 8, 5]);
});

test('a keyframe without in-band SPS/PPS gets the latest ones', () => {
    const a = new KeyframeAssembler();
    const out = [...a.push(Buffer.concat([key, delta, au(0x65), delta, delta]))];
    assert.equal(out.length, 2);
    assert.deepEqual(nalTypes(out[1]), [7, 8, 5]);
});

const mk = (now: () => number) => new KeyframeCache({ ffmpegPath: async () => { throw new Error('none'); }, source: async () => ({ url: '', label: 'test' }), log: () => { }, now, restartMinMs: 1e6 });

test('only keyframes are kept; a just-arrived one is reused, else the next one is awaited', async () => {
    let now = 0;
    const c = mk(() => now);
    c.start();
    c.accept(delta);
    assert.equal(c.keyframes, 0);
    c.accept(key);
    now = 200;
    assert.equal(await c.keyframe(300, 0), key);
    now = 900;
    assert.equal(await c.keyframe(300, 0), undefined);
    const p = c.keyframe(300, 1000);
    c.accept(delta);
    const key2 = au(0x67, 0x68, 0x65, 0x65);
    c.accept(key2);
    assert.equal(await p, key2);
    c.stop();
});

test('no keyframe in time resolves undefined so the caller can fall back', async () => {
    const c = mk(() => 0);
    c.start();
    assert.equal(await c.keyframe(300, 30), undefined);
    c.stop();
    assert.equal(await c.keyframe(300, 30), undefined);
});

test('a delayed start reads the source after the delay; restart reads it again at once', async () => {
    let reads = 0;
    const c = new KeyframeCache({ ffmpegPath: async () => 'ffmpeg', source: async () => { reads++; throw new Error('none'); }, log: () => { }, restartMinMs: 1e6 });
    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    c.start(50);
    await wait(10);
    assert.equal(reads, 0);
    await wait(80);
    assert.equal(reads, 1);
    c.restart();
    await wait(10);
    assert.equal(reads, 2);
    c.stop();
    c.restart();
    await wait(10);
    assert.equal(reads, 2);
    assert.equal(c.running, false);
});

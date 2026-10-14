import test from 'node:test';
import assert from 'node:assert/strict';
import { AccessUnitSplitter, KeyframeCache, nalTypes } from '../src/snapshot-cache';

const nal = (type: number, n: number) => Buffer.from([0, 0, 0, 1, type, n, n]);
const au = (...types: number[]) => Buffer.concat([Buffer.from([0, 0, 0, 1, 0x09, 0xf0]), ...types.map(t => nal(t, t))]);
const key = au(0x67, 0x68, 0x65);
const delta = au(0x41);

test('splitter cuts access units at each delimiter across chunk boundaries', () => {
    const s = new AccessUnitSplitter();
    const all = Buffer.concat([Buffer.from([7, 7]), key, delta, delta, key]);
    const out: Buffer[] = [];
    for (let i = 0; i < all.length; i += 5) out.push(...s.push(all.subarray(i, i + 5)));
    // The last unit stays pending until the next delimiter proves it complete.
    assert.equal(out.length, 3);
    assert.deepEqual(nalTypes(out[0]), [9, 7, 8, 5]);
    assert.deepEqual(nalTypes(out[1]), [9, 1]);
});

const mk = (now: () => number) => new KeyframeCache({ ffmpegPath: async () => { throw new Error('none'); }, url: () => '', log: () => { }, now, restartMinMs: 1e6 });

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

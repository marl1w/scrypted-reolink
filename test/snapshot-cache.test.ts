import test from 'node:test';
import assert from 'node:assert/strict';
import { JpegSplitter, KeyframeCache } from '../src/snapshot-cache';

const jpeg = (n: number) => Buffer.from([0xff, 0xd8, n, 0xff, 0x00, n, 0xff, 0xd9]);

test('splitter returns whole images across chunk boundaries and drops leading junk', () => {
    const s = new JpegSplitter();
    const all = Buffer.concat([Buffer.from([1, 2, 3]), jpeg(1), jpeg(2), jpeg(3)]);
    const out: Buffer[] = [];
    for (let i = 0; i < all.length; i += 3) out.push(...s.push(all.subarray(i, i + 3)));
    assert.deepEqual(out, [jpeg(1), jpeg(2), jpeg(3)]);
});

test('cache serves a fresh image at once, and waits for the next one when stale', async () => {
    let now = 0;
    const c = new KeyframeCache({ ffmpegPath: async () => { throw new Error('none'); }, url: () => '', log: () => { }, now: () => now, restartMinMs: 1e6 });
    c.start();
    c.accept(jpeg(1));
    now = 1000;
    assert.deepEqual(await c.get(2500, 0), jpeg(1));
    now = 5000;
    assert.equal(await c.get(2500, 0), undefined);
    const p = c.get(2500, 1000);
    c.accept(jpeg(2));
    assert.deepEqual(await p, jpeg(2));
    assert.equal(await c.get(2500, 20).then(() => 'fresh'), 'fresh');
    c.stop();
});

test('a stale cache times out to undefined so the caller can fall back', async () => {
    let now = 0;
    const c = new KeyframeCache({ ffmpegPath: async () => { throw new Error('none'); }, url: () => '', log: () => { }, now: () => now, restartMinMs: 1e6 });
    c.start();
    assert.equal(await c.get(2500, 30), undefined);
    c.stop();
    assert.equal(await c.get(2500, 30), undefined);
});

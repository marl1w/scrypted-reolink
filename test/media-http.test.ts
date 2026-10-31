import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clipSpools, handleMediaRequest, linkExpiry, mediaLink, MediaHost } from '../src/media-http';

process.env.SCRYPTED_PLUGIN_VOLUME = mkdtempSync(join(tmpdir(), 'reolink-media-'));
const clipDir = join(process.env.SCRYPTED_PLUGIN_VOLUME, 'clips');

const KEY = Buffer.alloc(32, 3);
const NOW = Date.parse('2026-10-31T12:20:00Z');

class FakeResponse {
    code?: number;
    headers: Record<string, string> = {};
    body?: string | Buffer;
    stream?: AsyncGenerator<Buffer, void>;
    send(body: string | Buffer, o?: { code?: number; headers?: object }) { this.body = body; this.code = o?.code ?? 200; this.headers = (o?.headers ?? {}) as any; }
    sendFile() { throw new Error('unexpected'); }
    sendSocket() { throw new Error('unexpected'); }
    sendStream(s: AsyncGenerator<Buffer, void>, o?: { code?: number; headers?: object }) { this.stream = s; this.code = o?.code ?? 200; this.headers = (o?.headers ?? {}) as any; }
}

function host(calls: string[], over: Partial<Record<'clipThumbnail' | 'clipMp4', (...a: any[]) => Promise<any>>> = {}): MediaHost {
    const recordings = {
        decodeClip: (ch: number, id: string) => { if (!/^CLIP/.test(id) || ch !== 2) throw new Error('invalid clip id'); return {}; },
        clipThumbnail: over.clipThumbnail ?? (async (ch: number, id: string) => { calls.push(`thumb ${ch} ${id}`); return Buffer.from([0xff, 0xd8]); }),
        clipMp4: over.clipMp4 ?? (async (ch: number, id: string) => {
            calls.push(`clip ${ch} ${id}`);
            return { stream: (async function* () { yield Buffer.from('ftyp'); })(), stop() { } };
        }),
    };
    return { recordings: recordings as any, clipKey: () => KEY };
}

const link = (kind: 'clip' | 'thumb', over: Partial<{ nvr: string; channel: number; exp: number; clipId: string }> = {}) =>
    mediaLink('/endpoint/@x/plugin/public', { kind, nvr: 'nvr-0a1b2c3d', channel: 2, clipId: 'CLIP', exp: linkExpiry(NOW), ...over }, KEY);

async function get(url: string, h: MediaHost | undefined, headers: Record<string, string> = {}, method = 'GET') {
    const res = new FakeResponse();
    const handled = await handleMediaRequest({ url, method, headers }, res as any, id => id === 'nvr-0a1b2c3d' ? h : undefined, () => NOW);
    return { handled, res };
}

test('media links: signed, expiring on the hour a day ahead, stable within the hour', () => {
    assert.equal(linkExpiry(NOW) * 1000, Date.parse('2026-11-01T13:00:00Z'));
    assert.equal(link('thumb'), mediaLink('/endpoint/@x/plugin/public/', { kind: 'thumb', nvr: 'nvr-0a1b2c3d', channel: 2, clipId: 'CLIP', exp: linkExpiry(NOW + 60_000) }, KEY));
    assert.match(link('clip'), /^\/endpoint\/@x\/plugin\/public\/clip\.mp4\?n=nvr-0a1b2c3d&c=2&id=CLIP&e=\d+&s=[\w-]{22}$/);
});

test('a thumbnail link serves the JPEG; a forged, expired or foreign one is refused', async () => {
    const calls: string[] = [];
    const h = host(calls);
    const ok = await get(link('thumb') + '&scryptedToken=x', h);
    assert.equal(ok.res.code, 200);
    assert.equal(ok.res.headers['Content-Type'], 'image/jpeg');
    assert.deepEqual(calls, ['thumb 2 CLIP']);
    assert.equal((await get(link('thumb').replace('c=2', 'c=3'), h)).res.code, 403, 'another channel');
    assert.equal((await get(link('thumb').replace('thumb.jpg', 'clip.mp4'), h)).res.code, 403, 'another kind');
    assert.equal((await get(link('thumb', { exp: Math.floor(NOW / 1000) - 1 }), h)).res.code, 403, 'expired');
    assert.equal((await get(link('thumb', { nvr: 'nvr-ffffffff' }), h)).res.code, 403, 'unknown NVR');
    assert.equal((await get('/endpoint/@x/plugin/public/other', h)).handled, false);
    assert.equal(calls.length, 1);
});

async function drain(s: AsyncGenerator<Buffer, void>) {
    const out: Buffer[] = [];
    for await (const b of s) out.push(b);
    return Buffer.concat(out).toString();
}

function reset() {
    for (const b of clipSpools.values()) b.remove();
    clipSpools.clear();
}

/** A remux fed by hand: push bytes, or undefined to end it. */
function feed(calls: string[]) {
    const queue: (Buffer | undefined)[] = [];
    let wait: (() => void) | undefined;
    const push = (b?: Buffer) => { queue.push(b); wait?.(); };
    const clipMp4 = async (_ch: number, id: string) => {
        calls.push(`open ${id}`);
        return {
            stream: (async function* () {
                while (true) {
                    while (!queue.length) await new Promise<void>(r => wait = r);
                    const b = queue.shift();
                    if (!b) return;
                    yield b;
                }
            })(), stop() { calls.push(`stop ${id}`); },
        };
    };
    return { push, clipMp4 };
}

/** Until the spooled clip has `size` bytes (and is complete, when `done`). */
async function spooled(size: number, done = false, id = 'CLIP') {
    for (let i = 0; i < 200; i++) {
        const s = clipSpools.get(`nvr-0a1b2c3d|2|${id}`);
        if (s && s.size === size && (!done || s.done)) return;
        await new Promise(r => setTimeout(r, 5));
    }
    assert.fail(`not spooled: ${size}`);
}

test('a clip link streams video/mp4; a busy NVR is a 503; range probes do not open the NVR', async () => {
    reset();
    const calls: string[] = [];
    const probe = await get(link('clip'), host(calls), { range: 'bytes=0-1' });
    assert.equal(probe.res.code, 206);
    assert.deepEqual(probe.res.body, Buffer.alloc(2));
    const nothing = await get(link('clip'), host(calls), { range: 'bytes=500-' });
    assert.equal(nothing.res.code, 416, 'nothing to resume');
    assert.equal(nothing.res.headers['Content-Range'], undefined, 'no length to state');
    assert.equal((await get(link('clip'), host(calls), {}, 'HEAD')).res.code, 200);
    assert.deepEqual(calls, [], 'probes did not open the NVR');
    const ok = await get(link('clip'), host(calls), { range: 'bytes=0-' });
    assert.equal(ok.res.code, 200, 'still remuxing: the whole clip, no end promised');
    assert.equal(ok.res.headers['Content-Length'], undefined);
    assert.equal(ok.res.headers['Content-Type'], 'video/mp4');
    assert.equal(await drain(ok.res.stream!), 'ftyp');
    assert.deepEqual(calls, ['clip 2 CLIP']);
    reset();
    const busy = await get(link('clip'), host(calls, { clipMp4: async () => { throw new Error('NVR playback busy: 3 playback streams or thumbnails already open'); } }));
    assert.equal(busy.res.code, 503);
    const failed = await get(link('clip'), host(calls, { clipMp4: async () => { throw new Error('clip failed: http://192.0.2.10/x?token=abc'); } }));
    assert.equal(failed.res.code, 502);
    assert.ok(!String(failed.res.body).includes('abc'), 'scrubbed');
    reset();
});

test('a dropped clip connection resumes from its spooled bytes; a finished clip serves any range with its length', async () => {
    reset();
    const calls: string[] = [];
    const f = feed(calls);
    const h = host(calls, { clipMp4: f.clipMp4 });
    f.push(Buffer.from('0123'));
    const first = await get(link('clip'), h, { range: 'bytes=0-' });
    const it = first.res.stream!;
    assert.equal((await it.next()).value!.toString(), '0123');
    await it.return(undefined); // the browser dropped the connection
    f.push(Buffer.from('4567'));
    await spooled(8);
    const resumed = await get(link('clip'), h, { range: 'bytes=2-' });
    assert.equal(resumed.res.code, 206);
    assert.equal(resumed.res.headers['Content-Range'], 'bytes 2-7/*', 'what is written so far, length unknown');
    assert.equal(resumed.res.headers['Content-Length'], '6');
    assert.equal(await drain(resumed.res.stream!), '234567');
    const next = get(link('clip'), h, { range: 'bytes=8-' });
    f.push(Buffer.from('89'));
    const more = (await next).res;
    assert.equal(more.code, 206, 'waits for the next bytes');
    assert.match(more.headers['Content-Range'], /^bytes 8-9\/(\*|10)$/);
    assert.equal(await drain(more.stream!), '89');
    const partial = await get(link('clip'), h, { range: 'bytes=0-1' });
    assert.equal(partial.res.code, 206, 'a bounded range is partial content');
    f.push(undefined);
    await spooled(10, true);
    assert.deepEqual(calls, ['open CLIP', 'stop CLIP'], 'one remux for every request');
    const range = await get(link('clip'), h, { range: 'bytes=3-5' });
    assert.equal(range.res.code, 206);
    assert.equal(range.res.headers['Content-Range'], 'bytes 3-5/10');
    assert.equal(range.res.headers['Content-Length'], '3');
    assert.equal(await drain(range.res.stream!), '345');
    const open = await get(link('clip'), h, { range: 'bytes=0-' });
    assert.equal(open.res.code, 206);
    assert.equal(open.res.headers['Content-Range'], 'bytes 0-9/10');
    assert.equal(await drain(open.res.stream!), '0123456789');
    for (const bad of ['bytes=5-2', 'items=1-2', 'bytes=x']) {
        const whole = await get(link('clip'), h, { range: bad });
        assert.equal(whole.res.code, 200, `${bad} is ignored`);
        assert.equal(whole.res.headers['Content-Length'], '10');
        assert.equal(await drain(whole.res.stream!), '0123456789');
    }
    const past = await get(link('clip'), h, { range: 'bytes=10-' });
    assert.equal(past.res.code, 416);
    assert.equal(past.res.headers['Content-Range'], 'bytes */10');
    assert.equal(readdirSync(clipDir).length, 1, 'spooled to one file');
    reset();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(readdirSync(clipDir).length, 0, 'deleted');
});

test('two first requests of one clip start one remux', async () => {
    reset();
    const calls: string[] = [];
    const f = feed(calls);
    f.push(Buffer.from('ftyp'));
    const h = host(calls, { clipMp4: async (ch: number, id: string) => { await new Promise(r => setTimeout(r, 10)); return f.clipMp4(ch, id); } });
    const [a, b] = await Promise.all([get(link('clip'), h), get(link('clip'), h)]);
    assert.equal(a.res.code, 200);
    assert.equal(b.res.code, 200);
    assert.deepEqual(calls, ['open CLIP']);
    reset();
});

test('a new clip takes the NVR slot of a remux nobody has read for a while, not of a paused one', async () => {
    reset();
    const calls: string[] = [];
    const f = feed(calls);
    let running = 0;
    const h = host(calls, {
        clipMp4: async (ch: number, id: string) => {
            if (running) throw new Error('NVR playback busy: 1 playback streams or thumbnails already open');
            running++;
            const c = await f.clipMp4(ch, id);
            return { stream: c.stream, stop() { if (running) running--; c.stop(); } };
        },
    });
    f.push(Buffer.from('ftyp'));
    const a = await get(link('clip'), h, { range: 'bytes=0-' });
    await a.res.stream!.next();
    await a.res.stream!.return(undefined); // paused: the connection dropped
    assert.equal((await get(link('clip', { clipId: 'CLIP2' }), h)).res.code, 503, 'paused a moment ago: kept');
    clipSpools.get('nvr-0a1b2c3d|2|CLIP')!.usedAt -= 10_000;
    const b = await get(link('clip', { clipId: 'CLIP2' }), h);
    assert.equal(b.res.code, 200);
    assert.deepEqual(calls, ['open CLIP', 'stop CLIP', 'open CLIP2']);
    assert.ok(!clipSpools.has('nvr-0a1b2c3d|2|CLIP'));
    reset();
});

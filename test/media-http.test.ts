import test from 'node:test';
import assert from 'node:assert/strict';
import { clipBuffers, handleMediaRequest, linkExpiry, mediaLink, MediaHost } from '../src/media-http';

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
        decodeClip: (ch: number, id: string) => { if (id !== 'CLIP' || ch !== 2) throw new Error('invalid clip id'); return {}; },
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
    for (const b of clipBuffers.values()) b.stop();
    clipBuffers.clear();
}

test('a clip link streams video/mp4; a busy NVR is a 503; range probes do not open the NVR', async () => {
    reset();
    const calls: string[] = [];
    const probe = await get(link('clip'), host(calls), { range: 'bytes=0-1' });
    assert.equal(probe.res.code, 206);
    assert.deepEqual(probe.res.body, Buffer.alloc(2));
    assert.equal((await get(link('clip'), host(calls), { range: 'bytes=500-' })).res.code, 416, 'nothing to resume');
    assert.equal((await get(link('clip'), host(calls), {}, 'HEAD')).res.code, 200);
    assert.deepEqual(calls, [], 'probes did not open the NVR');
    const ok = await get(link('clip'), host(calls), { range: 'bytes=0-' });
    assert.equal(ok.res.code, 200);
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

test('a dropped clip connection resumes from its kept bytes; a finished clip serves any range with its length', async () => {
    reset();
    const calls: string[] = [];
    let push!: (b?: Buffer) => void;
    const queue: (Buffer | undefined)[] = [];
    let wait: (() => void) | undefined;
    push = b => { queue.push(b); wait?.(); };
    const h = host(calls, {
        clipMp4: async () => {
            calls.push('open');
            return {
                stream: (async function* () {
                    while (true) {
                        while (!queue.length) await new Promise<void>(r => wait = r);
                        const b = queue.shift();
                        if (!b) return;
                        yield b;
                    }
                })(), stop() { calls.push('stop'); },
            };
        },
    });
    push(Buffer.from('0123'));
    const first = await get(link('clip'), h, { range: 'bytes=0-' });
    const it = first.res.stream!;
    assert.equal((await it.next()).value!.toString(), '0123');
    await it.return(undefined); // the browser dropped the connection
    push(Buffer.from('4567'));
    await new Promise(r => setImmediate(r));
    const resumed = await get(link('clip'), h, { range: 'bytes=2-' });
    assert.equal(resumed.res.code, 206);
    assert.match(resumed.res.headers['Content-Range'], /^bytes 2-\d+\/\*$/);
    const rest = drain(resumed.res.stream!);
    push(Buffer.from('89'));
    push(undefined);
    assert.equal(await rest, '23456789');
    assert.deepEqual(calls, ['open', 'stop'], 'one remux for both requests');
    const range = await get(link('clip'), h, { range: 'bytes=3-5' });
    assert.equal(range.res.code, 206);
    assert.equal(range.res.headers['Content-Range'], 'bytes 3-5/10');
    assert.equal(range.res.headers['Content-Length'], '3');
    assert.equal(await drain(range.res.stream!), '345');
    const whole = await get(link('clip'), h);
    assert.equal(whole.res.code, 200);
    assert.equal(whole.res.headers['Content-Length'], '10');
    assert.equal(await drain(whole.res.stream!), '0123456789');
    assert.equal((await get(link('clip'), h, { range: 'bytes=10-' })).res.code, 416);
    reset();
});

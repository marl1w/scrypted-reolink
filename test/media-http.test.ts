import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMediaRequest, linkExpiry, mediaLink, MediaHost } from '../src/media-http';

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

test('a clip link streams video/mp4; a busy NVR is a 503; range probes do not open the NVR', async () => {
    const calls: string[] = [];
    const ok = await get(link('clip'), host(calls), { range: 'bytes=0-' });
    assert.equal(ok.res.code, 200);
    assert.equal(ok.res.headers['Content-Type'], 'video/mp4');
    const chunks: string[] = [];
    for await (const b of ok.res.stream!) chunks.push(b.toString());
    assert.deepEqual(chunks, ['ftyp']);
    const probe = await get(link('clip'), host(calls), { range: 'bytes=0-1' });
    assert.equal(probe.res.code, 206);
    assert.deepEqual(probe.res.body, Buffer.alloc(2));
    assert.equal((await get(link('clip'), host(calls), { range: 'bytes=500-' })).res.code, 416);
    assert.equal((await get(link('clip'), host(calls), {}, 'HEAD')).res.code, 200);
    assert.deepEqual(calls, ['clip 2 CLIP'], 'only the real request opened the NVR');
    const busy = await get(link('clip'), host(calls, { clipMp4: async () => { throw new Error('NVR playback busy: 3 playback streams or thumbnails already open'); } }));
    assert.equal(busy.res.code, 503);
    const failed = await get(link('clip'), host(calls, { clipMp4: async () => { throw new Error('clip failed: http://192.0.2.10/x?token=abc'); } }));
    assert.equal(failed.res.code, 502);
    assert.ok(!String(failed.res.body).includes('abc'), 'scrubbed');
});

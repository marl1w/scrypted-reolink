import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { Cmd } from '../src/baichuan/constants';
import { NvrApi } from '../src/http/nvr-api';
import { HttpSession } from '../src/http/session';
import { NvrRecordings, RecorderDeps } from '../src/recorder';
import { MockHttpNvr } from './mock-http';

const fx = (n: string) => readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', n), 'utf8');

/** A Baichuan session answering the alarm-video search from fixtures, recording what was asked. */
class FakeBaichuan {
    calls: number[] = [];
    fail = false;
    async channelQuery(cmd: number, _ch: number, xml: string): Promise<string> {
        this.calls.push(cmd);
        if (this.fail) throw new Error('cmd 272: no reply');
        if (cmd === Cmd.AlarmVideoOpen) return fx('alarm-video-open.xml');
        if (cmd === Cmd.AlarmVideoNext) { assert.match(xml, /<fileHandle>7<\/fileHandle>/); return fx('alarm-video-page.xml'); }
        return '';
    }
}

async function withRecorder(fn: (r: NvrRecordings, m: MockHttpNvr, bc: FakeBaichuan, s: HttpSession, deps: RecorderDeps) => Promise<void>, over: Partial<RecorderDeps> = {}, now = Date.parse('2026-10-31T12:00:00Z')) {
    const m = new MockHttpNvr();
    await m.start();
    m.files.set('0|sub', JSON.parse(fx('search-events.json')));
    m.files.set('0|main', JSON.parse(fx('search-events.json')).map((f: any) => ({ ...f, type: 'main', name: f.name.replace(/^1-/, '0-') })));
    m.files.set('1|sub', JSON.parse(fx('search-continuous.json')));
    const s = new HttpSession({ host: '127.0.0.1', port: m.port, username: m.user, password: m.password });
    const api = new NvrApi(s);
    const bc = new FakeBaichuan();
    const deps: RecorderDeps = {
        api: () => api,
        token: min => s.getToken(min),
        target: () => ({ host: '127.0.0.1', port: m.port, rtmpPort: 1935, username: m.user, password: m.password }),
        baichuan: () => bc,
        uid: ch => ch === 0 ? 'UIDEXAMPLE0' : '',
        clipKey: () => Buffer.alloc(32, 1),
        ffmpegPath: async () => 'ffmpeg',
        now: () => now,
        ...over,
    };
    const r = new NvrRecordings(deps);
    try { await fn(r, m, bc, s, deps); }
    finally { await s.stop(); await m.stop(); }
    assert.equal(m.tokens.size, 0, 'logged out');
}

test('clips of a day: one login, one search, triggers from the alarm-video search, cached after', () => withRecorder(async (r, m, bc) => {
    const q = { startTime: Date.parse('2026-10-30T00:00:00Z'), endTime: Date.parse('2026-10-30T22:00:00Z') };
    const clips = await r.clips(0, q);
    assert.equal(clips.length, 3);
    assert.equal(clips[0].event, 'person');
    assert.deepEqual(clips[1].detectionClasses, ['vehicle', 'line_crossing']);
    assert.equal(m.searches.length, 1);
    assert.deepEqual(m.searches[0], { channel: 0, onlyStatus: 0, streamType: 'sub', StartTime: { year: 2026, mon: 10, day: 30, hour: 0, min: 0, sec: 0 }, EndTime: { year: 2026, mon: 10, day: 30, hour: 23, min: 59, sec: 59 } });
    assert.deepEqual(bc.calls, [Cmd.AlarmVideoOpen, Cmd.AlarmVideoNext, Cmd.AlarmVideoClose], 'the search handle is closed');
    await r.clips(0, q);
    await Promise.all([r.clips(0, q), r.recordingAt(0, 'sub', clips[0].startTime)]);
    assert.equal(m.searches.length, 1, 'a past day is served from the cache');
    assert.equal(bc.calls.length, 3);
    assert.equal(m.logins, 1);
    assert.ok(m.calls.includes('GetTime'));
    assert.equal((await r.clips(0, { ...q, count: 1 }))[0].startTime, clips[2].startTime, 'count keeps the most recent');
}));

test('clips of a 24/7 day: windows nothing triggered in are dropped, unless triggers are unknown', () => withRecorder(async (r, _m, bc) => {
    const q = { startTime: Date.parse('2026-10-29T23:00:00Z'), endTime: Date.parse('2026-10-30T00:10:00Z') };
    // channel 1 has no UID: triggers unknown, every window is kept
    const all = await r.clips(1, q);
    assert.equal(all.length, 14, '70 minutes in 5 minute windows');
    assert.ok(all.every(c => c.event === 'recording'));
    assert.equal(bc.calls.length, 0);
}, {}, Date.parse('2026-10-30T00:10:00Z')));

test('trigger lookup failing does not hide recordings', () => withRecorder(async (r, _m, bc) => {
    bc.fail = true;
    const clips = await r.clips(0, { startTime: Date.parse('2026-10-30T00:00:00Z'), endTime: Date.parse('2026-10-30T22:00:00Z') });
    assert.equal(clips.length, 3);
    assert.ok(clips.every(c => !c.detectionClasses.length));
}));

test('recording stream: the file holding the time, the seek into it, a bounded read; Playback measured once', () => withRecorder(async (r, m) => {
    const t = Date.parse('2026-10-30T11:12:28Z'); // 60 s into the first recording
    const at = await r.recordingAt(0, 'main', t);
    assert.equal(at.seek, 60);
    assert.equal(at.row.name, '0-0-0-01260930111128-00000');
    const input = await r.input(0, at.row, at.seek, 20);
    assert.equal(input.route, 'playback');
    assert.equal(input.container, 'flv');
    assert.deepEqual(input.inputArguments.slice(2, 6), ['-fflags', '+genpts', '-t', '20.000']);
    const q = new URL(input.url).searchParams;
    assert.equal(q.get('cmd'), 'Playback');
    assert.equal(q.get('type'), '0');
    assert.equal(q.get('start'), '20261030121128');
    assert.equal(q.get('playbackTime'), '20261030111128');
    assert.equal(q.get('seek'), '60');
    assert.ok(m.tokens.has(q.get('token')!), 'the shared session token');
    await r.input(0, at.row, 0);
    assert.equal(m.playbacks.length, 1, 'the route is measured once, then remembered');
    assert.equal(m.logins, 1);
    await assert.rejects(r.recordingAt(0, 'main', Date.parse('2026-10-30T15:00:00Z')), /no main stream recording on channel 0/);
    const gap = await r.recordingAt(0, 'sub', Date.parse('2026-10-30T12:28:28Z'));
    assert.equal(gap.seek, 0, 'a short gap plays the next recording from its start');
}));

test('playback route falls back on a verified row: Playback refused, then /flv; 404 everywhere is a missing recording', () => withRecorder(async (r, m) => {
    m.routeStatus.Playback = 404;
    const at = await r.recordingAt(0, 'sub', Date.parse('2026-10-30T11:12:28Z'));
    const input = await r.input(0, at.row, at.seek, undefined, { verified: true });
    assert.equal(input.route, 'flv');
    assert.equal(new URL(input.url).searchParams.get('seek'), '60');
    assert.deepEqual(m.playbacks.map(p => p.route), ['Playback', 'flv']);
    r.forgetRoute();
    m.routeStatus.flv = 404;
    const dl = await r.input(0, at.row, at.seek, undefined, { verified: true });
    assert.equal(dl.route, 'download');
    assert.equal(dl.container, 'mp4');
    assert.deepEqual(dl.inputArguments.slice(2, 6), ['-fflags', '+genpts', '-ss', '60.000'], 'a whole file is seeked by ffmpeg');
    r.forgetRoute();
    m.routeStatus.Download = 404;
    const err = await r.input(0, at.row, at.seek, undefined, { verified: true }).then(() => undefined, e => e as Error);
    assert.match(err!.message, /recording not found on the NVR, deleted or not written yet \(playback: HTTP 404; flv: HTTP 404; download: HTTP 404\)/);
    m.routeStatus.Download = 200;
    assert.equal((await r.input(0, at.row, at.seek, undefined, { verified: true })).route, 'download', 'no back-off after 404 everywhere: the recording was gone, not the route');
    assert.ok(!err!.message.includes(m.password));
}));

test('a recorder stating PlaybackTime in its own clock is asked in its own clock', () => withRecorder(async (r, m) => {
    m.files.set('0|sub', JSON.parse(fx('search-events.json')).map((f: any) => ({ ...f, PlaybackTime: f.StartTime })));
    const at = await r.recordingAt(0, 'sub', Date.parse('2026-10-30T11:12:28Z'));
    assert.equal(at.seek, 60);
    assert.equal(new URL((await r.input(0, at.row, at.seek)).url).searchParams.get('playbackTime'), '20261030121128');
}));

test('a day still being recorded is searched again for a time it could not have listed', () => {
    let now = Date.parse('2026-10-30T11:00:00Z');
    return withRecorder(async (r, m) => {
        await assert.rejects(r.recordingAt(0, 'sub', Date.parse('2026-10-30T10:59:00Z')));
        now = Date.parse('2026-10-30T11:13:00Z');
        await r.recordingAt(0, 'sub', Date.parse('2026-10-30T11:12:28Z'));
        assert.equal(m.searches.length, 2);
        now += 5000;
        await r.recordingAt(0, 'sub', Date.parse('2026-10-30T11:12:28Z'));
        assert.equal(m.searches.length, 2, 'a burst costs one search');
    }, { now: () => now });
});

test('thumbnails: one small JPEG per key from ffmpeg, cached; a failure says why', async () => {
    const runs: string[][] = [];
    const runFfmpeg = async (_p: string, args: string[]) => { runs.push(args); return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); };
    await withRecorder(async r => {
        const clip = (await r.clips(0, { startTime: Date.parse('2026-10-30T00:00:00Z'), endTime: Date.parse('2026-10-30T22:00:00Z') }))[0];
        const a = await r.clipThumbnail(0, clip.id);
        const b = await r.clipThumbnail(0, clip.id);
        assert.equal(a, b);
        assert.equal(runs.length, 1);
        assert.ok(runs[0].includes('scale=320:-2'));
        assert.ok(runs[0].includes('-i'));
    }, { runFfmpeg });
    await withRecorder(async r => {
        await assert.rejects(r.thumbnail('x', async () => ({ route: 'playback', url: '', container: 'flv', inputArguments: [] })), /thumbnail failed: ffmpeg produced no JPEG/);
    }, { runFfmpeg: async () => Buffer.from('nope') });
});

test('a 24/7 day with known triggers keeps only windows a trigger falls in', () => withRecorder(async (r, m) => {
    // the same 70 minutes of 24/7 footage, with the event fixture's triggers moved into the second recording
    m.files.set('0|sub', JSON.parse(fx('search-continuous.json')));
    const clips = await r.clips(0, { startTime: Date.parse('2026-10-29T23:00:00Z'), endTime: Date.parse('2026-10-30T00:10:00Z') });
    assert.equal(clips.length, 1);
    assert.equal(clips[0].event, 'person');
    assert.equal(new Date(clips[0].startTime).toISOString(), '2026-10-29T23:10:00.000Z');
}, {
    baichuan: () => ({
        channelQuery: async (cmd: number) => cmd === Cmd.AlarmVideoOpen ? fx('alarm-video-open.xml')
            : cmd === Cmd.AlarmVideoNext ? fx('alarm-video-page.xml').replace(/<day>30<\/day><hour>12<\/hour><minute>11<\/minute><second>28/, '<day>30</day><hour>0</hour><minute>12</minute><second>0')
                .replace(/<day>30<\/day><hour>12<\/hour><minute>12<\/minute><second>11/, '<day>30</day><hour>0</hour><minute>13</minute><second>0') : '',
    }),
}, Date.parse('2026-10-30T00:10:00Z')));

test('a failed search serves the older answer instead of failing', () => {
    let now = Date.parse('2026-10-30T11:13:00Z');
    return withRecorder(async (r, m) => {
        await r.recordingAt(0, 'sub', Date.parse('2026-10-30T11:12:28Z'));
        now += 10 * 60_000;
        m.failLogin = true;
        m.expireAll();
        const at = await r.recordingAt(0, 'sub', Date.parse('2026-10-30T11:12:30Z'));
        assert.equal(at.row.name, '1-0-0-01260930111128-00000');
        m.failLogin = false;
    }, { now: () => now });
});

const routeOf = (url: string) => url.includes('cmd=Playback') ? 'playback' : url.includes('/flv') ? 'flv' : 'download';
const T0 = Date.parse('2026-10-30T11:12:28Z');

test('route: a timeout is no reason to move; a 404 is; remembered route first; measured again after 10 min', () => {
    let now = Date.parse('2026-10-31T12:00:00Z');
    const answers: Record<string, number | Error> = { playback: new Error('no answer within 15 s'), flv: 200, download: 200 };
    const probed: string[] = [];
    const probe = async (url: string) => {
        const r = routeOf(url);
        probed.push(r);
        const a = answers[r];
        if (a instanceof Error) throw a;
        return a;
    };
    return withRecorder(async r => {
        const at = await r.recordingAt(0, 'sub', T0);
        assert.equal((await r.input(0, at.row, at.seek, 5, { thumbnail: true, verified: true })).route, 'flv', 'used this once');
        assert.equal(r.route, undefined, 'not remembered: Playback only timed out');
        assert.equal((await r.input(0, at.row, at.seek, 5, { thumbnail: true, verified: true })).route, 'flv');
        assert.deepEqual(probed, ['playback', 'flv', 'playback', 'flv'], 'measured again');
        answers.playback = 404;
        probed.length = 0;
        await r.input(0, at.row, at.seek, 5, { thumbnail: true, verified: true });
        assert.equal(r.route, 'flv', 'remembered after a definite 404');
        await r.input(0, at.row, at.seek, 5, { thumbnail: true, verified: true });
        assert.deepEqual(probed, ['playback', 'flv'], 'then reused');
        now += 11 * 60_000;
        probed.length = 0;
        answers.playback = 200;
        await r.input(0, at.row, at.seek, 5, { thumbnail: true, verified: true });
        assert.deepEqual(probed, ['flv'], 'measured again after the TTL, the remembered route first');
        r.routeFailed();
        answers.flv = 404;
        probed.length = 0;
        assert.equal((await r.input(0, at.row, at.seek, 5, { thumbnail: true, verified: true })).route, 'playback');
        assert.deepEqual(probed, ['flv', 'playback'], 'a failure re-measures');
    }, { probe, now: () => now });
});

test('route: after a total failure, playback fails at once for a minute', () => {
    let now = Date.parse('2026-10-31T12:00:00Z');
    let probes = 0;
    return withRecorder(async r => {
        const at = await r.recordingAt(0, 'sub', T0);
        await assert.rejects(r.input(0, at.row, at.seek), /any playback endpoint/);
        assert.equal(probes, 3);
        await assert.rejects(r.input(0, at.row, at.seek), /any playback endpoint/);
        assert.equal(probes, 3, 'no probe during the back-off');
        now += 61_000;
        await assert.rejects(r.input(0, at.row, at.seek));
        assert.equal(probes, 6);
    }, { probe: async () => { probes++; return 503; }, now: () => now });
});

test('a past day is not searched again when the asked span ends now; today is, after 30 s', () => {
    let now = Date.parse('2026-10-31T00:30:00Z'); // 01:30 on the recorder: the span covers two recorder days
    return withRecorder(async (r, m, bc) => {
        m.files.set('0|sub', [...JSON.parse(fx('search-events.json')), ...JSON.parse(fx('search-events.json')).map((f: any) => ({ ...f, StartTime: { ...f.StartTime, day: 31, hour: 0 }, EndTime: { ...f.EndTime, day: 31, hour: 1 }, PlaybackTime: { ...f.PlaybackTime, day: 30, hour: 23 } }))]);
        const q = () => r.clips(0, { startTime: Date.parse('2026-10-30T10:00:00Z'), endTime: now });
        await q();
        assert.equal(m.searches.length, 2);
        assert.equal(bc.calls.filter(c => c === Cmd.AlarmVideoOpen).length, 2);
        now += 10_000;
        await q();
        assert.equal(m.searches.length, 2, 'within 30 s nothing is searched');
        now += 60_000;
        await q();
        assert.deepEqual(m.searches.slice(2).map(s => s.StartTime.day), [31], 'only today again');
        assert.equal(bc.calls.filter(c => c === Cmd.AlarmVideoOpen).length, 3, 'only today\'s triggers again (60 s), the past day\'s are kept an hour');
    }, { now: () => now });
});

test('playback slots: per channel and stream, latest wins, capped by the setting; a day at most; tokens last', () => {
    let now = Date.parse('2026-10-31T12:00:00Z');
    let slots = 3;
    const asked: (number | undefined)[] = [];
    return withRecorder(async r => {
        const at = await r.recordingAt(0, 'sub', T0);
        const a = await r.input(0, at.row, at.seek, 10 * 86_400);
        assert.ok(a.inputArguments.includes('86400.000'), 'clamped to a day');
        await r.input(0, at.row, at.seek);
        await r.input(0, at.row, at.seek);
        assert.ok(await r.input(1, at.row, at.seek, 20));
        assert.ok(await r.input(2, at.row, at.seek, 20));
        await assert.rejects(r.input(3, at.row, at.seek, 20), /NVR playback busy: 3/);
        assert.ok(await r.input(2, at.row, at.seek), 'the same camera and stream replaces its own lease');
        slots = 4;
        assert.ok(await r.input(3, at.row, at.seek, 20), 'the setting raises the cap');
        now += 61_000;
        slots = 3;
        assert.ok(await r.input(4, at.row, at.seek), 'a clip or open stream holds its slot a minute, a short bounded one its length');
        assert.ok(asked.every(x => (x ?? 0) >= 10 * 60_000), 'a playback token lasts at least 10 minutes');
    }, { now: () => now, probe: async () => 200, token: async (ms?: number) => { asked.push(ms); return 'TOKEN'; }, slots: () => slots });
});

test('a lease is taken only once the URL exists', () => withRecorder(async r => {
    const at = await r.recordingAt(0, 'sub', T0);
    await r.input(0, at.row, 0, 20); // the route is measured and remembered
    let fail = true;
    (r as any).deps.token = async () => { if (fail) throw new Error('login failed'); return 'T'; };
    for (let i = 1; i < 6; i++) await assert.rejects(r.input(i, at.row, 0, 20), /login failed/);
    fail = false;
    for (let i = 0; i < 3; i++) await r.input(i, at.row, 0, 20);
    await assert.rejects(r.input(3, at.row, 0, 20), /busy/);
}, { probe: async () => 200 }));

test('a thumbnail that re-measures the route takes one slot at a time', () => {
    let running = 0, max = 0;
    const probe = async () => { running++; max = Math.max(max, running); await new Promise(r => setTimeout(r, 5)); running--; return 200; };
    const runFfmpeg = async () => { running++; max = Math.max(max, running); await new Promise(r => setTimeout(r, 5)); running--; return Buffer.from([0xff, 0xd8]); };
    return withRecorder(async r => {
        const at = await r.recordingAt(0, 'sub', T0);
        await r.thumbnail('t', () => r.input(0, at.row, 0, undefined, { thumbnail: true }));
        assert.equal(max, 1);
    }, { probe, runFfmpeg, slots: () => 1 });
});

test('thumbnails: one decode per key in flight, failures remembered a minute, the queue capped', async () => {
    let now = Date.parse('2026-10-31T12:00:00Z');
    let runs = 0, fail = true;
    const gates: (() => void)[] = [];
    const runFfmpeg = async () => {
        runs++;
        await new Promise<void>(r => gates.push(r));
        if (fail) throw new Error('thumbnail failed: Server returned 404 for http://192.0.2.10/x?token=abc');
        return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    };
    const flush = async () => { for (let i = 0; i < 50 && !gates.length; i++) await new Promise(r => setTimeout(r, 5)); gates.shift()?.(); };
    await withRecorder(async r => {
        const input = async () => ({ route: 'playback' as const, url: 'u', container: 'flv', inputArguments: ['-i', 'u'] });
        const a = r.thumbnail('k', input), b = r.thumbnail('k', input);
        assert.equal(a, b, 'shared');
        await flush();
        const err = await a.catch(e => e as Error) as Error;
        assert.match(err.message, /404/);
        assert.ok(!err.message.includes('abc'), 'scrubbed');
        await assert.rejects(r.thumbnail('k', input), /404/);
        assert.equal(runs, 1, 'a failure is remembered');
        now += 61_000;
        fail = false;
        const c = r.thumbnail('k', input);
        await flush();
        assert.equal((await c)[0], 0xff);
        assert.equal(runs, 2);
        // two running, 64 waiting: the 67th drops the oldest waiting one
        const many = Array.from({ length: 67 }, (_, i) => r.thumbnail(`q${i}`, input).then(() => 'ok', e => (e as Error).message));
        for (let i = 0; i < 70; i++) await flush();
        const res = await Promise.all(many);
        assert.equal(res[2], 'thumbnail dropped: too many waiting');
        assert.equal(res.filter(x => x === 'ok').length, 66);
        // a dropped one is not remembered as a failure: asked again, it is decoded
        const again = r.thumbnail('q2', input);
        await flush();
        assert.equal((await again)[0], 0xff);
    }, { runFfmpeg, now: () => now });
});

test('thumbnails: two decodes at once, but one playback slot always stays free', async () => {
    for (const [slots, want] of [[3, 2], [2, 1], [1, 1], [8, 2]]) {
        let running = 0, max = 0;
        const runFfmpeg = async () => { running++; max = Math.max(max, running); await new Promise(r => setTimeout(r, 5)); running--; return Buffer.from([0xff, 0xd8]); };
        await withRecorder(async r => {
            const input = async () => ({ route: 'playback' as const, url: 'u', container: 'flv', inputArguments: ['-i', 'u'] });
            await Promise.all(Array.from({ length: 6 }, (_, i) => r.thumbnail(`p${i}`, input)));
            assert.equal(max, want, `${slots} slots`);
        }, { runFfmpeg, slots: () => slots });
    }
});

test('thumbnails probe only the first packets; a miss falls back to ffmpeg\'s default probing', async () => {
    const runs: string[][] = [];
    let fastFails = true;
    const runFfmpeg = async (_p: string, args: string[]) => {
        runs.push(args);
        if (fastFails && args.includes('-analyzeduration')) throw new Error('thumbnail failed: Output file does not contain any stream');
        return Buffer.from([0xff, 0xd8]);
    };
    await withRecorder(async r => {
        const input = async () => ({ route: 'playback' as const, url: 'u', container: 'flv', inputArguments: ['-i', 'u'] });
        assert.equal((await r.thumbnail('a', input, 3))[0], 0xff);
        assert.equal(runs.length, 2);
        assert.ok(runs[0].indexOf('-analyzeduration') < runs[0].indexOf('-i'), 'probing limits come before the input');
        assert.ok(!runs[1].includes('-analyzeduration'));
        fastFails = false;
        await r.thumbnail('b', input, 3);
        assert.equal(runs.length, 3, 'the next one probes fast again');
        assert.ok(runs[2].includes('-analyzeduration'));
    }, { runFfmpeg });
    // a stream the NVR closed at once is asked again, still fast
    runs.length = 0;
    let closes = 1;
    await withRecorder(async r => {
        const input = async () => ({ route: 'playback' as const, url: 'u', container: 'flv', inputArguments: ['-i', 'u'] });
        assert.equal((await r.thumbnail('a', input, 3))[0], 0xff);
        assert.equal(runs.length, 2);
        assert.ok(runs.every(a => a.includes('-analyzeduration')));
    }, { thumbnailRetryMs: 1, runFfmpeg: async (_p: string, args: string[]) => { runs.push(args); if (closes-- > 0) throw new Error('thumbnail failed: Error opening input: End of file'); return Buffer.from([0xff, 0xd8]); } });
    // an NVR error is not retried
    runs.length = 0;
    await withRecorder(async r => {
        const input = async () => ({ route: 'playback' as const, url: 'u', container: 'flv', inputArguments: ['-i', 'u'] });
        await assert.rejects(r.thumbnail('a', input, 3), /404/);
        assert.equal(runs.length, 1);
    }, { runFfmpeg: async (_p: string, args: string[]) => { runs.push(args); throw new Error('thumbnail failed: Server returned 404 Not Found'); } });
});

test('thumbnails: a closed stream waits its back-off off the worker; streams closed again and again pause thumbnails', async () => {
    const order: string[] = [];
    const logs: string[] = [];
    let closeAll = false;
    await withRecorder(async r => {
        const input = (k: string) => async () => ({ route: 'playback' as const, url: k, container: 'flv', inputArguments: ['-i', k] });
        // one worker (2 slots): b decodes while a waits to be asked again
        await Promise.all([r.thumbnail('a', input('a')), r.thumbnail('b', input('b'))]);
        assert.deepEqual(order, ['a', 'b', 'a']);
        closeAll = true;
        const res = await Promise.all(['c', 'd'].map(k => r.thumbnail(k, input(k)).then(() => 'ok', e => (e as Error).message)));
        assert.ok(res.every(m => /End of file|paused/.test(m)), 'gave up');
        assert.ok(logs.some(l => /thumbnails paused/.test(l)));
        const runs = order.length;
        await assert.rejects(r.thumbnail('e', input('e')), /thumbnails paused/);
        assert.equal(order.length, runs, 'paused: no ffmpeg');
    }, {
        slots: () => 2, thumbnailRetryMs: 20, log: m => logs.push(m),
        runFfmpeg: async (_p: string, args: string[]) => {
            const k = args[args.indexOf('-i') + 1];
            order.push(k);
            if (closeAll || (k === 'a' && order.length === 1)) throw new Error('thumbnail failed: Error opening input: End of file');
            return Buffer.from([0xff, 0xd8]);
        },
    });
});

test('thumbnails on the Download route are taken at the start of the file', () => withRecorder(async r => {
    const at = await r.recordingAt(0, 'sub', T0);
    const th = await r.input(0, at.row, 60, undefined, { thumbnail: true });
    assert.equal(th.route, 'download');
    assert.ok(!th.inputArguments.includes('-ss'), 'not seeked: a whole file would be read up to the seek');
    assert.ok((await r.input(0, at.row, 60)).inputArguments.includes('-ss'));
}, { probe: async (url: string) => routeOf(url) === 'download' ? 200 : 404 }));

test('the PlaybackTime convention of the last decisive search is kept when no row votes', () => withRecorder(async (r, m) => {
    m.files.set('0|sub', JSON.parse(fx('search-events.json')).map((f: any) => ({ ...f, PlaybackTime: f.StartTime })));
    await r.recordingAt(0, 'sub', T0);
    assert.equal(r.utcConvention, false);
    // a day where every recording is a single row in the ambiguous shape: no vote
    m.files.set('0|main', [{ ...JSON.parse(fx('search-events.json'))[0], PlaybackTime: undefined, type: 'main', name: '0-0-0-01260930111128-00000' }]);
    const at = await r.recordingAt(0, 'main', T0);
    assert.equal(at.row.playbackId, '20261030121128', 'derived in the recorder\'s own clock');
    assert.equal(r.utcConvention, false);
}));

test('trigger windows are written into the day record cached now', () => {
    let now = Date.parse('2026-10-31T12:00:00Z');
    return withRecorder(async (r, _m, bc) => {
        const q = { startTime: Date.parse('2026-10-30T00:00:00Z'), endTime: Date.parse('2026-10-30T22:00:00Z') };
        // a search that replaces the record while the trigger lookup runs
        const orig = bc.channelQuery.bind(bc);
        let once = true;
        bc.channelQuery = async (cmd: number, ch: number, xml: string) => {
            if (cmd === Cmd.AlarmVideoOpen && once) { once = false; (r as any).days.forEach((v: any, k: string) => (r as any).days.set(k, { ...v, alarms: undefined, alarmsAt: undefined })); }
            return orig(cmd, ch, xml);
        };
        await r.clips(0, q);
        now += 1000;
        const again = await r.clips(0, q);
        assert.equal(again[0].event, 'person');
        assert.equal(bc.calls.filter(c => c === Cmd.AlarmVideoOpen).length, 1, 'the lookup landed in the current record');
    }, { now: () => now });
});

test('the token wiring passes the asked lifetime through to the session', () => withRecorder(async (r, m, _bc, s) => {
    const at = await r.recordingAt(0, 'sub', T0);
    const seen: number[] = [];
    const orig = s.getToken.bind(s);
    (s as any).getToken = (min?: number) => { seen.push(min ?? 0); return orig(min); };
    await r.input(0, at.row, at.seek, 1800);
    assert.ok(seen.some(x => x >= 31 * 60_000), `asked ${seen}`);
    assert.equal(m.logins, 1);
}, {}));

/** A stand-in ffmpeg: stdout and stderr streams, killed like a process. */
class FakeProc extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    stdin = new PassThrough();
    exitCode: number | null = null;
    signalCode: string | null = null;
    killed = 0;
    constructor(public args: string[]) { super(); }
    kill() {
        this.killed++;
        this.signalCode = 'SIGKILL';
        this.stdout.end();
        setImmediate(() => this.emit('close', null, 'SIGKILL'));
        return true;
    }
    exit(code: number) {
        this.exitCode = code;
        this.stdout.end();
        setImmediate(() => this.emit('close', code, null));
    }
}

async function withClip(fn: (r: NvrRecordings, procs: FakeProc[], clipId: string) => Promise<void>, over: Partial<RecorderDeps> = {}) {
    const procs: FakeProc[] = [];
    const spawnFfmpeg = ((_f: string, args: string[]) => { const p = new FakeProc(args); procs.push(p); return p; }) as any;
    await withRecorder(async r => {
        const clip = (await r.clips(0, { startTime: Date.parse('2026-10-30T00:00:00Z'), endTime: Date.parse('2026-10-30T22:00:00Z') }))[0];
        await fn(r, procs, clip.id);
    }, { probe: async () => 200, slots: () => 1, spawnFfmpeg, ...over });
}

/** The n-th ffmpeg, once spawned (the route and the token come first). */
async function spawned(procs: FakeProc[], n = 0): Promise<FakeProc> {
    for (let i = 0; i < 400 && !procs[n]; i++) await new Promise(res => setTimeout(res, 5));
    assert.ok(procs[n], 'ffmpeg spawned');
    return procs[n];
}

/** True when a playback slot is free (slots: 1). */
const slotFree = (r: NvrRecordings) => { try { r.holdSlot()(); return true; } catch { return false; } };

test('served clip: remuxed to fragmented MP4 without re-encoding; the slot is held while it plays and freed at the end', () => withClip(async (r, procs, id) => {
    const opening = r.clipMp4(0, id);
    const p = await spawned(procs);
    assert.ok(p.args.includes('frag_keyframe+empty_moov+default_base_moof') && p.args.includes('copy') && p.args.at(-1) === 'pipe:1');
    assert.ok(p.args.indexOf('-analyzeduration') < p.args.indexOf('-i'));
    p.stdout.write(Buffer.from('ftyp'));
    const clip = await opening;
    assert.equal(slotFree(r), false, 'one slot, held by the clip');
    await assert.rejects(r.clipMp4(0, id), /NVR playback busy/);
    const got: string[] = [];
    const reading = (async () => { for await (const b of clip.stream) got.push(b.toString()); })();
    await new Promise(res => setImmediate(res));
    p.stdout.write(Buffer.from('moof'));
    p.exit(0);
    await reading;
    assert.deepEqual(got.join(''), 'ftypmoof');
    assert.equal(slotFree(r), true, 'released at the end');
    assert.equal(p.killed, 0);
}));

test('served clip: a client that goes away kills ffmpeg and frees the slot', () => withClip(async (r, procs, id) => {
    const opening = r.clipMp4(0, id);
    await spawned(procs);
    procs[0].stdout.write(Buffer.from('ftyp'));
    const clip = await opening;
    const first = await clip.stream.next();
    assert.equal(first.value!.toString(), 'ftyp');
    await clip.stream.return(undefined); // the HTTP server stops iterating when the response closes
    assert.equal(procs[0].killed, 1);
    assert.equal(slotFree(r), true);
}));

test('served clip: ffmpeg failing first frees the slot and says why', async () => {
    await withClip(async (r, procs, id) => {
        const opening = r.clipMp4(0, id);
        await spawned(procs);
        procs[0].stderr.write('Server returned 404 Not Found for http://192.0.2.10/x?token=abc\n');
        procs[0].exit(1);
        const e = await opening.catch(x => x as Error) as Error;
        assert.match(e.message, /^clip failed: Server returned 404/);
        assert.ok(!e.message.includes('abc'), 'scrubbed');
        assert.equal(slotFree(r), true);
    });
});

test('a clip link is not a lease: getting it holds no slot', () => withClip(async (r, _procs, id) => {
    for (let i = 0; i < 3; i++) await r.input(0, r.decodeClip(0, id), 0, 300, { held: true });
    assert.equal(slotFree(r), true);
}));

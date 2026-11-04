import test from 'node:test';
import assert from 'node:assert/strict';
import { addStreamCredentials, buildStreamOptions, chooseSubstream, parseSubstreamProtocol, maskCredentials, prebufferedStreams, redactUrl, rtspSubstream, substreamOption } from '../src/streams';

// Expected values are written out by hand from the stock plugin's
// ReolinkCamera.getConstructedVideoStreamOptions (@scrypted/reolink 0.0.112) for the same inputs.
const H = '192.0.2.10';
const nvr = { exactType: 'NVR' };
const abil = (ch: number, live?: number, mainEncType?: number) => {
    const abilityChn: any[] = [];
    abilityChn[ch] = { live: live === undefined ? undefined : { ver: live }, mainEncType: mainEncType === undefined ? undefined : { ver: mainEncType } };
    return { abilityChn };
};

test('NVR channel, live=1, H.264 main 3840x2160: five streams in stock order with stock names and urls', () => {
    const s = buildStreamOptions({ channel: 3, host: H, deviceInfo: { ...nvr, model: 'RLC-810A' }, ability: abil(3, 1, 0), enc: { mainStream: { width: 3840, height: 2160, vType: 'h264' } } });
    assert.deepEqual(s, [
        { name: 'RTMP main.bcs', id: 'main.bcs', container: 'rtmp', video: { width: 3840, height: 2160 }, url: 'rtmp://192.0.2.10:1935/bcs/channel3_main.bcs?channel=3&stream=0' },
        { name: 'RTMP ext.bcs', id: 'ext.bcs', container: 'rtmp', video: { width: 896, height: 672 }, url: 'rtmp://192.0.2.10:1935/bcs/channel3_ext.bcs?channel=3&stream=0' },
        { name: 'RTMP sub.bcs', id: 'sub.bcs', container: 'rtmp', video: { width: 640, height: 480 }, url: 'rtmp://192.0.2.10:1935/bcs/channel3_sub.bcs?channel=3&stream=0' },
        { name: 'RTSP h264Preview_04_main', id: 'h264Preview_04_main', container: 'rtsp', video: { codec: 'h264', width: 3840, height: 2160 }, url: 'rtsp://192.0.2.10:554/h264Preview_04_main' },
        { name: 'RTSP h264Preview_04_sub', id: 'h264Preview_04_sub', container: 'rtsp', video: { codec: 'h264', width: 640, height: 480 }, url: 'rtsp://192.0.2.10:554/h264Preview_04_sub' },
    ]);
});

test('H.265 main: RTSP main renamed to h265Preview, no RTMP main/ext when mainEncType=1', () => {
    const s = buildStreamOptions({ channel: 0, host: H, deviceInfo: nvr, ability: abil(0, 1, 1), enc: { mainStream: { width: 3840, height: 2160, vType: 'h265' } } });
    assert.deepEqual(s.map(x => x.id), ['ext.bcs', 'sub.bcs', 'h265Preview_01_main', 'h264Preview_01_sub']);
    const main = s[2];
    assert.deepEqual(main, { name: 'RTSP h265Preview_01_main', id: 'h265Preview_01_main', container: 'rtsp', video: { codec: 'h265', width: 3840, height: 2160 }, url: 'rtsp://192.0.2.10:554/h265Preview_01_main' });
});

test('live=2 variants', () => {
    assert.deepEqual(buildStreamOptions({ channel: 1, host: H, ability: abil(1, 2, 0) }).map(x => x.id), ['main.bcs', 'sub.bcs', 'h264Preview_02_main', 'h264Preview_02_sub']);
    assert.deepEqual(buildStreamOptions({ channel: 1, host: H, ability: abil(1, 2, 1) }).map(x => x.id), ['sub.bcs', 'h264Preview_02_main', 'h264Preview_02_sub']);
});

test('no ability and no encoder data: stock defaults (2560x1920 main)', () => {
    const s = buildStreamOptions({ channel: 11, host: H });
    assert.deepEqual(s.map(x => x.id), ['main.bcs', 'ext.bcs', 'sub.bcs', 'h264Preview_12_main', 'h264Preview_12_sub']);
    assert.deepEqual(s[3].video, { codec: 'h264', width: 2560, height: 1920 });
});

test('dual-lens models add autotrack.bcs, and the second lens only on channel 0 (stock quirk kept)', () => {
    const on5 = buildStreamOptions({ channel: 5, host: H, deviceInfo: { ...nvr, model: 'Reolink TrackMix PoE' } });
    assert.deepEqual(on5.map(x => x.id).slice(-1), ['autotrack.bcs']);
    assert.equal(on5.at(-1)!.url, 'rtmp://192.0.2.10:1935/bcs/channel5_autotrack.bcs?channel=5&stream=0');
    const on0 = buildStreamOptions({ channel: 0, host: H, deviceInfo: { ...nvr, model: 'Reolink TrackMix PoE' } });
    assert.deepEqual(on0.map(x => x.id).slice(-3), ['autotrack.bcs', 'h264Preview_02_main', 'h264Preview_02_sub']);
    assert.deepEqual(on0.at(-2)!.video, { codec: 'h264', width: 3840, height: 2160 });
});

test('Home Hub: RTSP only', () => {
    assert.deepEqual(buildStreamOptions({ channel: 0, host: H, deviceInfo: { exactType: 'HOMEHUB' } }).map(x => x.id), ['h264Preview_01_main', 'h264Preview_01_sub']);
});

test('port overrides', () => {
    const s = buildStreamOptions({ channel: 0, host: H, rtspPort: 8554, rtmpPort: 11935 });
    assert.match(s[0].url, /^rtmp:\/\/192\.0\.2\.10:11935\//);
    assert.match(s[3].url, /^rtsp:\/\/192\.0\.2\.10:8554\//);
});

test('credentials as stock: RTSP userinfo (percent-encoded), RTMP raw query', () => {
    assert.equal(addStreamCredentials('rtsp://192.0.2.10:554/h264Preview_01_main', 'viewer', 'p@ss word'), 'rtsp://viewer:p%40ss%20word@192.0.2.10:554/h264Preview_01_main');
    assert.equal(addStreamCredentials('rtmp://192.0.2.10:1935/bcs/channel0_main.bcs?channel=0&stream=0', 'viewer', 'a!b#c'), 'rtmp://192.0.2.10:1935/bcs/channel0_main.bcs?channel=0&stream=0&user=viewer&password=a!b#c');
});

test('substream: RTSP _sub by default, RTMP sub.bcs on request, RTSP when there is no RTMP substream', () => {
    const s = buildStreamOptions({ channel: 2, host: H, deviceInfo: nvr, ability: abil(2, 1, 1), enc: { mainStream: { width: 3840, height: 2160, vType: 'h265' } } });
    assert.equal(substreamOption(s, 2)?.id, 'h264Preview_03_sub');
    assert.equal(substreamOption(s, 2, 'RTSP')?.id, 'h264Preview_03_sub');
    assert.equal(substreamOption(s, 2, 'RTMP')?.id, 'sub.bcs');
    assert.equal(substreamOption(s, 2, 'RTMP')?.url, 'rtmp://192.0.2.10:1935/bcs/channel2_sub.bcs?channel=2&stream=0');
    const hub = buildStreamOptions({ channel: 0, host: H, deviceInfo: { exactType: 'HOMEHUB' } });
    assert.equal(substreamOption(hub, 0, 'RTMP')?.id, 'h264Preview_01_sub');
});

test('RTSP substream: the channel _sub, not the dual-lens second lens, and the smallest RTSP stream without one', () => {
    const on0 = buildStreamOptions({ channel: 0, host: H, deviceInfo: { ...nvr, model: 'RLC-81MA' } });
    assert.equal(rtspSubstream(on0, 0)?.id, 'h264Preview_01_sub');
    const noSub = buildStreamOptions({ channel: 0, host: H }).filter(x => x.id !== 'h264Preview_01_sub');
    assert.equal(rtspSubstream(noSub, 0)?.id, 'h264Preview_01_main');
    assert.equal(rtspSubstream([], 0), undefined);
});

test('substream protocol: RTMP only when set so, unset or unknown values are RTSP', () => {
    assert.equal(parseSubstreamProtocol('RTMP'), 'RTMP');
    assert.equal(parseSubstreamProtocol('RTSP'), 'RTSP');
    for (const v of [undefined, null, '', 'rtmp', 'HLS', 1, true, ['RTMP']]) assert.equal(parseSubstreamProtocol(v), 'RTSP');
});

test('substream: RTSP while the channel type is unknown (no channel cache: it may be a Home Hub)', () => {
    const unknown = buildStreamOptions({ channel: 0, host: H, deviceInfo: {} });
    assert.ok(unknown.some(x => x.id === 'sub.bcs'));
    assert.equal(substreamOption(unknown, 0, 'RTMP', false)?.id, 'h264Preview_01_sub');
    assert.equal(substreamOption(unknown, 0, 'RTMP', true)?.id, 'sub.bcs');
    assert.deepEqual(chooseSubstream(unknown, 0, [], 'RTMP', false), { stream: unknown.find(x => x.id === 'h264Preview_01_sub'), prebuffered: false });
});

const stub = (settings: Record<string, unknown>, options: { id?: string; name?: string; prebuffer?: number }[] = []) => ({
    getSettings: async () => Object.entries(settings).map(([key, value]) => ({ key, value })),
    getVideoStreamOptions: async () => options,
});

test('prebuffered streams: Rebroadcast enabled streams, else its default and low-resolution roles, plus prebuffer marks', async () => {
    assert.deepEqual(await prebufferedStreams(stub({ 'prebuffer:enabledStreams': ['RTMP sub.bcs', 'View'], 'prebuffer:defaultStream': 'RTSP h264Preview_01_sub' })), ['RTMP sub.bcs', 'View']);
    assert.deepEqual(await prebufferedStreams(stub({ 'prebuffer:enabledStreams': '["RTMP sub.bcs"]' })), ['RTMP sub.bcs']);
    assert.deepEqual(await prebufferedStreams(stub({ 'prebuffer:enabledStreams': [], 'prebuffer:defaultStream': 'RTSP h264Preview_01_sub', 'prebuffer:lowResolutionStream': 'RTSP h264Preview_01_sub' })), ['RTSP h264Preview_01_sub']);
    assert.deepEqual(await prebufferedStreams(stub({}, [{ id: 'sub.bcs', name: 'RTMP sub.bcs', prebuffer: 10000 }, { id: 'main.bcs', name: 'RTMP main.bcs' }])), ['sub.bcs', 'RTMP sub.bcs']);
    // without Rebroadcast, or when the mixins fail: nothing is prebuffered
    assert.deepEqual(await prebufferedStreams({}), []);
    assert.deepEqual(await prebufferedStreams({ getSettings: async () => { throw new Error('x'); }, getVideoStreamOptions: async () => { throw new Error('x'); } }), []);
});

test('chosen substream follows what Rebroadcast prebuffers; the protocol breaks a tie or picks when it prebuffers neither', async () => {
    const s = buildStreamOptions({ channel: 2, host: H, deviceInfo: nvr, ability: abil(2, 1, 1) });
    const pick = async (settings: Record<string, unknown>, protocol: 'RTSP' | 'RTMP') => {
        const c = chooseSubstream(s, 2, await prebufferedStreams(stub(settings)), protocol);
        return [c.stream?.id, c.prebuffered];
    };
    assert.deepEqual(await pick({ 'prebuffer:enabledStreams': ['RTMP sub.bcs'] }, 'RTSP'), ['sub.bcs', true]);
    assert.deepEqual(await pick({ 'prebuffer:enabledStreams': ['RTSP h264Preview_03_sub'] }, 'RTMP'), ['h264Preview_03_sub', true]);
    assert.deepEqual(await pick({ 'prebuffer:enabledStreams': ['RTMP sub.bcs', 'RTSP h264Preview_03_sub'] }, 'RTMP'), ['sub.bcs', true]);
    assert.deepEqual(await pick({ 'prebuffer:enabledStreams': ['RTMP sub.bcs', 'RTSP h264Preview_03_sub'] }, 'RTSP'), ['h264Preview_03_sub', true]);
    assert.deepEqual(await pick({ 'prebuffer:enabledStreams': ['RTSP h264Preview_03_main'] }, 'RTMP'), ['sub.bcs', false]);
    assert.deepEqual(await pick({}, 'RTSP'), ['h264Preview_03_sub', false]);
});

test('stream URLs in logs: no RTSP userinfo, no RTMP query credentials', () => {
    assert.equal(redactUrl('rtsp://viewer:secret@192.0.2.10:554/h264Preview_01_sub'), 'rtsp://192.0.2.10:554/h264Preview_01_sub');
    assert.equal(redactUrl('rtmp://192.0.2.10:1935/bcs/channel0_sub.bcs?channel=0&stream=0&user=viewer&password=a!b#c'), 'rtmp://192.0.2.10:1935/bcs/channel0_sub.bcs');
    assert.equal(redactUrl('not a url'), '(unparseable URL)');
});

test('log lines: credentials masked, the rest kept', () => {
    assert.equal(maskCredentials('Sending play command with path: channel6_sub.bcs?channel=6&stream=0&user=viewer&password=s3cret'),
        'Sending play command with path: channel6_sub.bcs?channel=6&stream=0&user=viewer&password=***');
    assert.equal(maskCredentials('rtmp://192.0.2.10:1935/bcs/channel0_sub.bcs?channel=0&stream=0&user=viewer&password=a!b#c failed'),
        'rtmp://192.0.2.10:1935/bcs/channel0_sub.bcs?channel=0&stream=0&user=viewer&password=*** failed');
    assert.equal(maskCredentials('[tcp @ 0x1] rtsp://viewer:s3cret@192.0.2.10:554/h264Preview_01_sub: Connection refused'),
        '[tcp @ 0x1] rtsp://viewer:***@192.0.2.10:554/h264Preview_01_sub: Connection refused');
    assert.equal(maskCredentials('body [{"cmd":"Login","param":{"User":{"userName":"viewer","password":"s3\\"cret"}}}]'),
        'body [{"cmd":"Login","param":{"User":{"userName":"viewer","password":"***"}}}]');
    assert.equal(maskCredentials('/api.cgi?cmd=Search&token=abc123 timed out'), '/api.cgi?cmd=Search&token=*** timed out');
    // a password with & is cut at the & by the pattern; the secret itself is still removed
    assert.equal(maskCredentials('play ?user=viewer&password=a&b9 end', ['a&b9']), 'play ?user=viewer&password=*** end');
    assert.equal(maskCredentials('nothing to hide here'), 'nothing to hide here');
});

test('frame rate: the NVR encoder frameRate as video.fps on the main and sub streams, absent when not reported', () => {
    const s = buildStreamOptions({ channel: 1, host: H, deviceInfo: nvr, ability: abil(1, 1, 1), enc: { mainStream: { width: 3840, height: 2160, vType: 'h265', frameRate: 15 }, subStream: { width: 896, height: 512, frameRate: 6 } } });
    const fps = Object.fromEntries(s.map(x => [x.id, x.video.fps]));
    assert.deepEqual(fps, { 'ext.bcs': undefined, 'sub.bcs': 6, 'h265Preview_02_main': 15, 'h264Preview_02_sub': 6 });
    const none = buildStreamOptions({ channel: 1, host: H, deviceInfo: nvr, ability: abil(1, 1, 1), enc: { mainStream: { width: 3840, height: 2160, vType: 'h265' }, subStream: { frameRate: 0 } } });
    assert.ok(none.every(x => !('fps' in x.video)));
});

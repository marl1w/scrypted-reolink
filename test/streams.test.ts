import test from 'node:test';
import assert from 'node:assert/strict';
import { addStreamCredentials, buildStreamOptions } from '../src/streams';

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

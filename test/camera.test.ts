import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// The camera needs the SDK only at runtime: a minimal stand-in, enough to construct it and watch its children.
const announced = new Set<string>();
class Base {
    console = { log() { }, warn() { } };
    store = new Map<string, string>();
    storage = { getItem: (k: string) => this.store.get(k) ?? null, setItem: (k: string, v: string) => { this.store.set(k, v); } };
    constructor(public nativeId?: string) { }
}
const changed: { providerNativeId?: string; devices: { nativeId: string; interfaces: string[] }[] }[] = [];
/** Settings values the next StorageSettings starts with (the NVR reads them in its constructor). */
let seed: Record<string, unknown> = {};
const names = new Proxy({}, { get: (_t, k) => k });
const sdkStub = {
    __esModule: true,
    default: {
        deviceManager: { getNativeIds: () => [...announced], onDeviceEvent() { }, getDeviceStorage() { return undefined; }, onDevicesChanged: async (d: any) => { changed.push(d); } },
        systemManager: { getDeviceById: () => undefined, listenDevice: () => ({ removeListener() { } }) },
        mediaManager: { getFFmpegPath: async () => 'ffmpeg' },
    },
    ScryptedDeviceBase: Base,
    ScryptedInterface: names,
    ScryptedMimeTypes: names,
};
class StorageSettings {
    values: Record<string, unknown>;
    constructor(_d: unknown, defs: Record<string, { defaultValue?: unknown }>) {
        this.values = { ...Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, d.defaultValue])), ...seed };
    }
}
const origLoad = (Module as any)._load;
(Module as any)._load = function (req: string, ...rest: any[]) {
    if (req === '@scrypted/sdk') return sdkStub;
    if (req === '@scrypted/sdk/storage-settings') return { StorageSettings };
    return origLoad.call(this, req, ...rest);
};
const { ReolinkChannelCamera } = require('../src/camera');
const { ReolinkNvr } = require('../src/nvr');
import { MockNvr } from './mock-nvr';

const tick = () => new Promise(r => setTimeout(r, 5));

test('no state is written to a child before it is announced; announcing applies the states known so far', async () => {
    const nvr = {
        channelCache: () => ({ channel: 1, aiClasses: ['people', 'dog_cat'] }),
        channelStates: new Map(),
        isAnnounced: (id: string) => announced.has(id),
        smartEvents: () => [],
        substreamProtocol: 'RTSP',
        syncDevices: async () => { },
    };
    const cam = new ReolinkChannelCamera('nvr-1-ch1', nvr, 1);
    cam.nightModeState('night');
    cam.onPush({ kind: 'alarm', channel: 1, motion: true, ai: new Set(['people']), status: ['MD'] });
    await tick();
    const kids = ['nvr-1-ch1-nightmode', 'nvr-1-ch1-rawmotion', 'nvr-1-ch1-raw-person', 'nvr-1-ch1-raw-animal'];
    const dev = async (id: string) => cam.getDevice(id);
    assert.equal((await dev(kids[0])).binaryState, undefined, 'not announced: untouched');
    assert.equal((await dev(kids[1])).motionDetected, undefined);
    assert.equal((await dev(kids[2])).occupied, undefined);
    for (const k of kids) announced.add(k);
    cam.applyChildStates();
    await tick();
    assert.equal((await dev(kids[0])).binaryState, true);
    assert.equal((await dev(kids[1])).motionDetected, true);
    assert.equal((await dev(kids[2])).occupied, true);
    assert.equal((await dev(kids[3])).occupied, false);
    cam.nightModeState('led_day');
    cam.motion.reset();
    await tick();
    assert.equal((await dev(kids[0])).binaryState, false);
    assert.equal((await dev(kids[1])).motionDetected, undefined, 'disconnected: unknown');
    assert.equal((await dev(kids[2])).occupied, undefined);
    cam.dispose();
});

test('each start re-announces the devices once subscribed, so an update reaches existing cameras', async () => {
    const m = new MockNvr();
    await m.start();
    seed = { host: '127.0.0.1', username: m.user, password: m.password, baichuanPort: m.port, httpPort: 9, channels: ['0'] };
    const nvr = new ReolinkNvr('nvr-1');
    try {
        for (let i = 0; i < 200 && !changed.some(c => c.providerNativeId === 'nvr-1-ch0'); i++) await new Promise(r => setTimeout(r, 25));
        const cams = changed.find(c => c.providerNativeId === 'nvr-1');
        assert.ok(cams, 'cameras announced without a discovery');
        assert.ok(cams!.devices[0].interfaces.includes('VideoRecorder'));
        const kids = changed.find(c => c.providerNativeId === 'nvr-1-ch0')!;
        assert.deepEqual(kids.devices.map(d => d.nativeId).slice(0, 2), ['nvr-1-ch0-nightmode', 'nvr-1-ch0-rawmotion']);
        assert.equal(nvr.isAnnounced('nvr-1-ch0-nightmode'), true);
        // the recordings service asks the NVR's own HTTP session for a token lasting what it needs
        const asked: (number | undefined)[] = [];
        nvr.session.getToken = async (min?: number) => { asked.push(min); return 'T'; };
        await (nvr.recordings as any).deps.token(40 * 60_000);
        assert.deepEqual(asked, [40 * 60_000]);
        assert.equal((nvr.recordings as any).deps.slots(), 3, 'the playback slots setting, default 3');
    }
    finally {
        seed = {};
        await nvr.stop();
        await m.stop();
    }
});

test('a start keeps the siren, floodlight and class children while the abilities are not read, and drops removed crops', async () => {
    changed.length = 0;
    announced.clear();
    for (const id of ['nvr-2-ch0', 'nvr-2-ch0-siren', 'nvr-2-ch0-floodlight', 'nvr-2-ch0-raw-person', 'nvr-2-ch0-crop-old']) announced.add(id);
    const m = new MockNvr();
    await m.start();
    seed = { host: '127.0.0.1', username: m.user, password: m.password, baichuanPort: m.port, httpPort: 9, channels: ['0'] };
    const nvr = new ReolinkNvr('nvr-2');
    try {
        for (let i = 0; i < 200 && !changed.some(c => c.providerNativeId === 'nvr-2-ch0'); i++) await new Promise(r => setTimeout(r, 25));
        const kids = changed.find(c => c.providerNativeId === 'nvr-2-ch0')!.devices.map(d => d.nativeId);
        assert.deepEqual(kids, ['nvr-2-ch0-nightmode', 'nvr-2-ch0-rawmotion', 'nvr-2-ch0-raw-person', 'nvr-2-ch0-siren', 'nvr-2-ch0-floodlight']);
        assert.equal(nvr.isAnnounced('nvr-2-ch0-crop-old'), false, 'a removed crop is gone');
    }
    finally {
        seed = {};
        await nvr.stop();
        await m.stop();
    }
});

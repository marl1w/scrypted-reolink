import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { DERIVED_PROBE_TIMEOUT_MS, DERIVED_RESTART_DELAY_MS, derivedRestartPlan, DerivedCamera } from '../src/rebroadcast-watchdog';

// Crops and mirrors after their parent's Rebroadcast is restarted (2026-11-08: the NVRs' weekly restart left the
// posti auto crop and its mirror without frames until Scrypted restarted), and the probe that finds one that hung.

const PARENT = 'nvr-1-ch8';
const CROP = `${PARENT}-crop-posti-auto`;
const MIRROR = `${PARENT}-mirror-posti-auto-v2`;

// --- SDK stand-in: records VideoCamera events, serves each device's stream as the test says ---
const events: string[] = [];
const detected: [string, string[]][] = [];
/** How a device's stream request answers: a local rebroadcast url, an error, or never. */
const streams = new Map<string, 'ok' | 'error' | 'hang'>();
const announced = new Set<string>();
class Base {
    console = { log() { }, warn() { } };
    store = new Map<string, string>();
    storage = { getItem: (k: string) => this.store.get(k) ?? null, setItem: (k: string, v: string) => { this.store.set(k, v); } };
    id?: string;
    constructor(public nativeId?: string) { }
}
const names = new Proxy({}, { get: (_t, k) => k });
const sdkStub = {
    __esModule: true,
    default: {
        deviceManager: {
            getNativeIds: () => [...announced],
            onDeviceEvent(nativeId: string, iface: string, data?: any) {
                if (iface === 'VideoCamera') events.push(nativeId);
                if (iface === 'ObjectDetector') detected.push([nativeId, data?.detections?.map((d: any) => d.className)]);
            },
            getDeviceStorage() { return undefined; },
            onDevicesChanged: async () => { },
        },
        systemManager: {
            getDeviceById: (id: string) => ({
                getVideoStream: () => {
                    const s = streams.get(id) ?? 'ok';
                    if (s === 'hang') return new Promise(() => { });
                    if (s === 'error') return Promise.reject(new Error('ffmpeg exited'));
                    return Promise.resolve({ url: 'rtsp://127.0.0.1:45205/x' });
                },
            }),
            listenDevice: () => ({ removeListener() { } }),
            getSystemState: () => ({}),
        },
        mediaManager: { getFFmpegPath: async () => 'ffmpeg', convertMediaObjectToJSON: async (mo: unknown) => mo },
    },
    ScryptedDeviceBase: Base,
    ScryptedInterface: names,
    ScryptedMimeTypes: names,
};
class StorageSettings {
    values: Record<string, unknown>;
    constructor(_d: unknown, defs: Record<string, { defaultValue?: unknown }>) {
        this.values = {
            ...Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, d.defaultValue])),
            snapshotCache: false,
            crops: ['posti auto=928:576:0:0'],
            mirrors: ['posti auto v2=posti auto'],
        };
    }
}
const origLoad = (Module as any)._load;
(Module as any)._load = function (req: string, ...rest: any[]) {
    if (req === '@scrypted/sdk') return sdkStub;
    if (req === '@scrypted/sdk/storage-settings') return { StorageSettings };
    return origLoad.call(this, req, ...rest);
};
const { ReolinkChannelCamera } = require('../src/camera');

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function camera(t: { after: (fn: () => void) => void }) {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
    events.length = 0;
    streams.clear();
    for (const id of [CROP, MIRROR]) announced.add(id);
    const nvr = {
        channelCache: () => ({ channel: 8 }),
        channelStates: new Map(),
        isAnnounced: (id: string) => announced.has(id),
        smartEvents: () => [],
        substreamProtocol: 'RTMP',
        syncDevices: async () => { },
    };
    const cam = new ReolinkChannelCamera(PARENT, nvr, 8);
    cam.online = true;
    // the crop and the mirror as Scrypted created them: their ids are what the probe asks through
    (await cam.getDevice(CROP)).id = 'crop-id';
    (await cam.getDevice(MIRROR)).id = 'mirror-id';
    t.after(() => { cam.dispose(); mock.timers.reset(); });
    return cam;
}

/** Runs one probe round; a stream that hangs is given its full timeout. */
async function probe(cam: any) {
    const p = cam.probeDerived();
    await flush();
    mock.timers.tick(DERIVED_PROBE_TIMEOUT_MS);
    await flush();
    mock.timers.tick(DERIVED_PROBE_TIMEOUT_MS);
    await p;
}

test('plan: a parent restart restarts its crops, then the mirrors that read them', () => {
    const cams: DerivedCamera[] = [
        { nativeId: 'm', kind: 'mirror', streamId: 'mirror', source: 'c' },
        { nativeId: 'c', kind: 'crop', streamId: 'crop' },
    ];
    assert.deepEqual(derivedRestartPlan('p', 'p', cams), [
        { nativeId: 'c', delayMs: DERIVED_RESTART_DELAY_MS },
        { nativeId: 'm', delayMs: 2 * DERIVED_RESTART_DELAY_MS },
    ]);
});

test('plan: a crop restart restarts only the mirrors of that crop', () => {
    const cams: DerivedCamera[] = [
        { nativeId: 'c1', kind: 'crop', streamId: 'crop' },
        { nativeId: 'c2', kind: 'crop', streamId: 'crop' },
        { nativeId: 'm1', kind: 'mirror', streamId: 'mirror', source: 'c1' },
        { nativeId: 'm2', kind: 'mirror', streamId: 'mirror', source: 'c2' },
    ];
    assert.deepEqual(derivedRestartPlan('c1', 'p', cams), [{ nativeId: 'm1', delayMs: DERIVED_RESTART_DELAY_MS }]);
    assert.deepEqual(derivedRestartPlan('m1', 'p', cams), []);
});

test('the parent restarted after an NVR outage: its crop, then the mirror, get new sessions', async t => {
    const cam = await camera(t);
    cam.restartRebroadcast('the NVR is back after an outage');
    assert.deepEqual(events, [PARENT], 'the parent at once');
    mock.timers.tick(DERIVED_RESTART_DELAY_MS);
    assert.deepEqual(events, [PARENT, CROP], 'the crop once the parent is up');
    mock.timers.tick(DERIVED_RESTART_DELAY_MS);
    // the mirror is planned twice (after the parent, after the crop) for the same moment: one restart, not two
    assert.deepEqual(events, [PARENT, CROP, MIRROR], 'the mirror once the crop is up, once');
    mock.timers.tick(10 * DERIVED_RESTART_DELAY_MS);
    assert.deepEqual(events, [PARENT, CROP, MIRROR], 'nothing more');
});

test('a crop that hangs while the parent answers is restarted after two probes, and its mirror after it', async t => {
    const cam = await camera(t);
    streams.set('crop-id', 'hang');
    await probe(cam);
    assert.deepEqual(events, [], 'one failure is not a hang');
    await probe(cam);
    assert.deepEqual(events, [CROP], 'two in a row: restarted');
    mock.timers.tick(DERIVED_RESTART_DELAY_MS);
    assert.deepEqual(events, [CROP, MIRROR]);
});

test('a crop whose stream errors is restarted like one that hangs: either way nothing gets frames', async t => {
    const cam = await camera(t);
    streams.set('crop-id', 'error');
    const p = cam.probeDerived();
    await flush();
    await p;
    assert.deepEqual(events, [], 'one failure is not a hang');
    const q = cam.probeDerived();
    await flush();
    await q;
    assert.deepEqual(events, [CROP]);
    mock.timers.tick(DERIVED_RESTART_DELAY_MS);
    assert.deepEqual(events, [CROP, MIRROR]);
});

test('nothing is restarted while the parent is offline (the outage watch restarts everything when it is back)', async t => {
    const cam = await camera(t);
    cam.online = false;
    streams.set('crop-id', 'hang');
    streams.set('mirror-id', 'hang');
    for (let i = 0; i < 4; i++) await probe(cam);
    assert.deepEqual(events, []);
});

test('a mirror is not blamed for its crop: it is restarted only while the crop answers', async t => {
    const cam = await camera(t);
    streams.set('crop-id', 'hang');
    streams.set('mirror-id', 'hang');
    await probe(cam);
    await probe(cam);
    assert.deepEqual(events, [CROP], 'the crop, not the mirror');
    streams.set('crop-id', 'ok');
    mock.timers.tick(DERIVED_RESTART_DELAY_MS);
    assert.deepEqual(events, [CROP, MIRROR], 'the mirror follows its crop restart');
    // the crop answers now; the mirror still hangs on its own: restarted again only after the interval
    await probe(cam);
    await probe(cam);
    assert.deepEqual(events, [CROP, MIRROR], 'not twice inside the restart interval');
});

test('a crop that keeps failing is restarted at most once per interval, never in a loop', async t => {
    const cam = await camera(t);
    streams.set('crop-id', 'error');
    for (let i = 0; i < 10; i++) await probe(cam);
    assert.equal(events.filter(e => e === CROP).length, 1);
});

test('roles come from the configured lists: a crop and a mirror can swap roles and keep their ids', async t => {
    const cam = await camera(t);
    const { ReolinkCropCamera, ReolinkMirrorCamera } = require('../src/camera');
    // the mirror's id becomes the crop, the crop's id becomes the mirror
    cam.storageSettings.values.crops = ['villa_1_postiauto=928:576:0:0 @mirror-posti-auto-v2'];
    cam.storageSettings.values.mirrors = ['villa_2_postiauto=villa_1_postiauto @crop-posti-auto'];
    // no release in between: the cached objects are rebuilt in their new roles
    assert.ok(await cam.getDevice(MIRROR) instanceof ReolinkCropCamera, 'id ...-mirror-... is now the crop');
    assert.ok(await cam.getDevice(CROP) instanceof ReolinkMirrorCamera, 'id ...-crop-... is now the mirror');
    // restarts follow the roles too: the crop first, then the mirror that reads it
    cam.restartRebroadcast('test');
    mock.timers.tick(DERIVED_RESTART_DELAY_MS);
    assert.deepEqual(events, [PARENT, MIRROR]);
    mock.timers.tick(DERIVED_RESTART_DELAY_MS);
    assert.deepEqual(events, [PARENT, MIRROR, CROP]);
});

test('crops take the parent\'s motion and AI detections as their trigger; mirrors follow their crop, not the parent', async t => {
    const cam = await camera(t);
    const crop = await cam.getDevice(CROP);
    const mirror = await cam.getDevice(MIRROR);
    detected.length = 0;
    cam.onPush({ kind: 'alarm', channel: 8, motion: true, ai: new Set(['people']), status: ['MD'] });
    await flush();
    assert.equal(cam.motionDetected, true);
    assert.equal(crop.motionDetected, true, 'the crop is triggered with its parent');
    assert.ok(detected.some(([id, c]) => id === CROP && c.includes('people')), 'the crop gets the parent\'s detections');
    assert.ok(!detected.some(([id]) => id === MIRROR), 'the mirror gets nothing from the parent directly');
    assert.notEqual(mirror.motionDetected, true, 'the mirror repeats its crop as Coral Guard gates it, not the raw trigger');
    cam.motion.reset();
    await flush();
    assert.equal(crop.motionDetected, cam.motionDetected, 'reset reaches the crop too');
});

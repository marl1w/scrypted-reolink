import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCameraDevice, buildChildDevices, buildCropDevices, buildMirrorDevices, parseCrops, parseMirrors, parseViewCrop, cameraNativeId, channelCacheFrom, formatHealth, parseCameraNativeId } from '../src/devices';

const ability = { abilityChn: [{ supportAudioAlarm: { ver: 1 } }, {}, { floodLight: { ver: 1 } }] };

test('camera native ids are scoped per NVR and round-trip', () => {
    assert.equal(cameraNativeId('nvr-ab12', 3), 'nvr-ab12-ch3');
    assert.deepEqual(parseCameraNativeId('nvr-ab12-ch11'), { nvr: 'nvr-ab12', channel: 11 });
    assert.equal(parseCameraNativeId('nvr-ab12'), undefined);
});

test('camera device manifest', () => {
    const cache = channelCacheFrom(2, { model: 'NVR-TEST', exactType: 'NVR' }, { channel: 2, name: 'Cam B', online: 1 }, { chnTypeInfo: { typeInfo: 'CAM-TEST', firmVer: 'v1' } }, ability, ['people']);
    const d = buildCameraDevice('nvr-1', cache);
    assert.equal(d.nativeId, 'nvr-1-ch2');
    assert.equal(d.providerNativeId, 'nvr-1');
    assert.equal(d.name, 'Cam B');
    assert.equal(d.type, 'Camera');
    assert.deepEqual(d.interfaces, ['VideoCamera', 'Camera', 'MotionSensor', 'ObjectDetector', 'Settings', 'Online', 'DeviceProvider']);
    assert.equal(d.info?.model, 'CAM-TEST');
    assert.equal(cache.exactType, 'NVR');
});

test('no siren/floodlight: no DeviceProvider, default name', () => {
    const d = buildCameraDevice('nvr-1', { channel: 1, ability });
    assert.equal(d.name, 'Channel 2');
    assert.equal(d.interfaces.includes('DeviceProvider'), false);
});

test('siren and floodlight children use the stock suffixes and types', () => {
    assert.deepEqual(buildChildDevices('nvr-1-ch0', 'Cam A', { channel: 0, ability }).map(d => [d.nativeId, d.name, d.type, d.interfaces]), [['nvr-1-ch0-siren', 'Cam A Siren', 'Siren', ['OnOff']]]);
    assert.deepEqual(buildChildDevices('nvr-1-ch2', 'Cam B', { channel: 2, ability }).map(d => [d.nativeId, d.type]), [['nvr-1-ch2-floodlight', 'Light']]);
});

test('health line', () => {
    assert.equal(formatHealth({ pushState: 'subscribed', channels: 12, lastEventAt: 1000, httpSessions: 1, reconnects: 2, now: 13000 }),
        'Push: subscribed · 12 channels · last event 12 s ago · HTTP sessions 1 · reconnects 2');
    assert.match(formatHealth({ pushState: 'backoff', channels: 0, httpSessions: 0, reconnects: 0, lastError: 'boom' }), /never .* last error: boom$/);
});

test('camera names are prefixed with the NVR name', () => {
    assert.equal(buildCameraDevice('nvr-1', { channel: 2, name: 'Door' }, 'Home NVR').name, 'Home NVR Door');
    assert.equal(buildCameraDevice('nvr-1', { channel: 2 }, 'Home NVR').name, 'Home NVR Channel 3');
    assert.equal(buildCameraDevice('nvr-1', { channel: 2, name: 'Door' }).name, 'Door');
});

test('crop entries parse to unique slugs and skip invalid ones', () => {
    const c = parseCrops(['Parking Spot=768:576:0:0', 'bad', 'Parking spot=1:1:1:1', 'Gate = 320:240:10:20']);
    assert.deepEqual(c.map(x => [x.slug, x.width, x.height, x.x, x.y]), [['parking-spot', 768, 576, 0, 0], ['gate', 320, 240, 10, 20]]);
    assert.deepEqual(buildCropDevices('nvr-1-ch8', c).map(d => [d.nativeId, d.providerNativeId, d.type]),
        [['nvr-1-ch8-crop-parking-spot', 'nvr-1-ch8', 'Camera'], ['nvr-1-ch8-crop-gate', 'nvr-1-ch8', 'Camera']]);
    assert.deepEqual(parseCrops(undefined), []);
});

test('view crop: width:height:x:y or the whole frame', () => {
    assert.deepEqual(parseViewCrop('928:576:608:0'), { width: 928, height: 576, x: 608, y: 0 });
    assert.equal(parseViewCrop(''), undefined);
    assert.equal(parseViewCrop(undefined), undefined);
    assert.equal(parseViewCrop('928:576'), undefined);
});

test('mirror cameras follow a configured crop and get presence children', () => {
    const crops = parseCrops(['home_b_drive (Baichuan)=928:576:0:0']);
    const m = parseMirrors(['home_a_drive=home_b_drive (Baichuan)', 'Other=missing', 'bad', 'home_b_drive (Baichuan)=home_b_drive (Baichuan)'], crops);
    assert.deepEqual(m, [{ slug: 'home-a-drive', name: 'home_a_drive', source: 'home-b-drive-baichuan' }]);
    const d = buildMirrorDevices('nvr-1-ch8', m);
    assert.deepEqual(d.mirrors.map(x => [x.nativeId, x.providerNativeId, x.type]), [['nvr-1-ch8-mirror-home-a-drive', 'nvr-1-ch8', 'Camera']]);
    assert.deepEqual(d.children.map(x => [x.nativeId, x.providerNativeId, x.name]), [
        ['nvr-1-ch8-mirror-home-a-drive-vehicle', 'nvr-1-ch8-mirror-home-a-drive', 'home_a_drive Vehicle Presence'],
        ['nvr-1-ch8-mirror-home-a-drive-animal', 'nvr-1-ch8-mirror-home-a-drive', 'home_a_drive Animal Presence'],
    ]);
    assert.deepEqual(parseMirrors(undefined, crops), []);
});

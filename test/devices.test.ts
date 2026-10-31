import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCameraDevice, buildChildDevices, buildCropDevices, buildMirrorDevices, parseCrops, parseMirrors, parseViewCrop, cameraNativeId, cameraSerialNumber, channelCacheFrom, distinctSerials, formatHealth, nightModeNativeId, parseCameraNativeId, rawClassNativeId, rawMotionNativeId, realId, slugTag } from '../src/devices';

const ability = { abilityChn: [{ supportAudioAlarm: { ver: 1 } }, {}, { floodLight: { ver: 1 } }] };

test('camera native ids are scoped per NVR and round-trip', () => {
    assert.equal(cameraNativeId('nvr-ab12', 3), 'nvr-ab12-ch3');
    assert.deepEqual(parseCameraNativeId('nvr-ab12-ch11'), { nvr: 'nvr-ab12', channel: 11 });
    assert.equal(parseCameraNativeId('nvr-ab12'), undefined);
});

test('camera device manifest', () => {
    const cache = channelCacheFrom(2, { model: 'NVR-TEST', exactType: 'NVR' }, { channel: 2, name: 'Cam B', online: 1, uid: '95270000TESTUID' }, { chnTypeInfo: { typeInfo: 'CAM-TEST', firmVer: 'v1' } }, ability, ['people']);
    const d = buildCameraDevice('nvr-1', cache);
    assert.equal(d.nativeId, 'nvr-1-ch2');
    assert.equal(d.providerNativeId, 'nvr-1');
    assert.equal(d.name, 'Cam B');
    assert.equal(d.type, 'Camera');
    assert.deepEqual(d.interfaces, ['VideoCamera', 'Camera', 'MotionSensor', 'ObjectDetector', 'Settings', 'Online', 'VideoClips', 'VideoRecorder', 'DeviceProvider']);
    assert.equal(d.info?.model, 'CAM-TEST');
    assert.equal(d.info?.serialNumber, '95270000TESTUID');
    assert.equal(cache.exactType, 'NVR');
    assert.equal(buildCameraDevice('nvr-1', { channel: 1 }).info?.serialNumber, undefined);
    assert.equal(channelCacheFrom(4, { serial: 'NVRSERIAL' }, { channel: 4, online: 1 }, {}, ability, []).serialNumber, 'NVRSERIAL-5', 'no UID: the NVR serial and channel');
    const noUid = channelCacheFrom(4, { serial: '00000000000000' }, { channel: 4, online: 1, uid: '' }, { cameraSerial: '141400000000001', nvrIds: { uid: '95270000EXAMPLE1' } }, ability, []);
    assert.equal(noUid.serialNumber, '141400000000001', 'no UID: the camera serial from Baichuan');
    assert.equal(noUid.uid, '', 'no UID is kept as empty, to tell it from a cache before 0.1.17');
});

test('serial number fallback order, all-zero values treated as missing', () => {
    const nvr = { serial: '00000000000000', uid: '95270000EXAMPLE1', mac: '02:00:5e:10:00:01' };
    assert.equal(cameraSerialNumber(1, { uid: '95270000CAMERA01', cameraSerial: '141400000000001' }, nvr), '95270000CAMERA01');
    assert.equal(cameraSerialNumber(1, { uid: '', cameraSerial: '141400000000001' }, nvr), '141400000000001');
    assert.equal(cameraSerialNumber(1, { cameraSerial: '000000000000000' }, nvr), '95270000EXAMPLE1-2');
    assert.equal(cameraSerialNumber(1, {}, { serial: 'NVRSERIAL', uid: nvr.uid }), 'NVRSERIAL-2');
    assert.equal(cameraSerialNumber(1, {}, { serial: nvr.serial, mac: nvr.mac }), '02005E100001-2');
    assert.equal(cameraSerialNumber(1, { model: 'B800' }, { serial: nvr.serial, mac: '00:00:00:00:00:00' }), 'B800-2');
    assert.equal(cameraSerialNumber(1, {}, { serial: nvr.serial }), undefined, 'never all zeros');
    assert.equal(realId(' 0000 '), undefined);
    assert.equal(realId('00:00:00:00:00:00'), undefined);
    assert.equal(realId('0032'), '0032');
});

test('a serial two channels share is dropped', () => {
    assert.deepEqual([...distinctSerials(new Map([[0, 'A1'], [1, 'DUP'], [2, undefined], [3, 'DUP']]))],
        [[0, 'A1'], [1, undefined], [2, undefined], [3, undefined]]);
});

test('no siren/floodlight: still a DeviceProvider (Night mode, Camera motion), default name, recordings', () => {
    const d = buildCameraDevice('nvr-1', { channel: 1, ability });
    assert.equal(d.name, 'Channel 2');
    assert.ok(d.interfaces.includes('DeviceProvider'));
    assert.ok(d.interfaces.includes('VideoClips') && d.interfaces.includes('VideoRecorder'));
});

test('Night mode and Camera motion on every camera; siren and floodlight with the stock suffixes and types', () => {
    assert.deepEqual(buildChildDevices('nvr-1-ch1', 'Cam C', { channel: 1, ability }).map(d => [d.nativeId, d.providerNativeId, d.name, d.type, d.interfaces]), [
        ['nvr-1-ch1-nightmode', 'nvr-1-ch1', 'Cam C Night mode', 'Sensor', ['BinarySensor']],
        ['nvr-1-ch1-rawmotion', 'nvr-1-ch1', 'Cam C Camera motion', 'Sensor', ['MotionSensor']],
    ]);
    assert.equal(nightModeNativeId('nvr-1-ch1'), 'nvr-1-ch1-nightmode');
    assert.equal(rawMotionNativeId('nvr-1-ch1'), 'nvr-1-ch1-rawmotion');
    assert.deepEqual(buildChildDevices('nvr-1-ch0', 'Cam A', { channel: 0, ability }).slice(2).map(d => [d.nativeId, d.name, d.type, d.interfaces]), [['nvr-1-ch0-siren', 'Cam A Siren', 'Siren', ['OnOff']]]);
    assert.deepEqual(buildChildDevices('nvr-1-ch2', 'Cam B', { channel: 2, ability }).slice(2).map(d => [d.nativeId, d.type]), [['nvr-1-ch2-floodlight', 'Light']]);
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

test('crop and mirror serials: source serial and a short tag, no names', () => {
    const crops = parseCrops(['Parking Spot=640:360:0:0']);
    const [crop] = buildCropDevices('nvr-1-ch8', crops, '141400000000001');
    assert.equal(crop.info?.serialNumber, `141400000000001-crop-${slugTag('parking-spot')}`);
    assert.match(crop.info!.serialNumber!, /^141400000000001-crop-[0-9a-f]{6}$/);
    const m = buildMirrorDevices('nvr-1-ch8', parseMirrors(['Home A Drive=Parking Spot'], crops), '141400000000001');
    assert.match(m.mirrors[0].info!.serialNumber!, /^141400000000001-mirror-[0-9a-f]{6}$/);
    assert.notEqual(slugTag('parking-spot'), slugTag('gate'));
    assert.equal(buildCropDevices('nvr-1-ch8', crops).at(0)?.info?.serialNumber, undefined);
});

test('a Camera <class> child per supported AI class, named as the MQTT add-on names its entities', () => {
    const kids = buildChildDevices('nvr-1-ch1', 'Cam C', { channel: 1, ability, aiClasses: ['people', 'vehicle', 'dog_cat', 'face', 'package', 'bad-Class'] });
    assert.deepEqual(kids.filter(d => d.nativeId.includes('-raw-')).map(d => [d.nativeId, d.name, d.type, d.interfaces]), [
        ['nvr-1-ch1-raw-person', 'Cam C Camera person', 'Sensor', ['OccupancySensor']],
        ['nvr-1-ch1-raw-vehicle', 'Cam C Camera vehicle', 'Sensor', ['OccupancySensor']],
        ['nvr-1-ch1-raw-animal', 'Cam C Camera animal', 'Sensor', ['OccupancySensor']],
        ['nvr-1-ch1-raw-face', 'Cam C Camera face', 'Sensor', ['OccupancySensor']],
        ['nvr-1-ch1-raw-package', 'Cam C Camera package', 'Sensor', ['OccupancySensor']],
    ]);
    assert.equal(rawClassNativeId('x', 'some_class'), 'x-raw-some_class');
    assert.equal(buildChildDevices('nvr-1-ch1', 'Cam C', { channel: 1, ability }).filter(d => d.nativeId.includes('-raw-')).length, 0);
});

test('children of fields not read yet are kept as announced; read fields decide', () => {
    const existing = ['nvr-1-ch0-siren', 'nvr-1-ch0-floodlight', 'nvr-1-ch0-raw-person', 'nvr-1-ch0-raw-some_class', 'nvr-1-ch1-siren'];
    const unknown = buildChildDevices('nvr-1-ch0', 'Cam A', { channel: 0 }, existing);
    assert.deepEqual(unknown.map(d => [d.nativeId, d.name]), [
        ['nvr-1-ch0-nightmode', 'Cam A Night mode'], ['nvr-1-ch0-rawmotion', 'Cam A Camera motion'],
        ['nvr-1-ch0-raw-person', 'Cam A Camera person'], ['nvr-1-ch0-raw-some_class', 'Cam A Camera some class'],
        ['nvr-1-ch0-siren', 'Cam A Siren'], ['nvr-1-ch0-floodlight', 'Cam A Floodlight'],
    ]);
    const known = buildChildDevices('nvr-1-ch0', 'Cam A', { channel: 0, ability: { abilityChn: [{}] }, aiClasses: [] }, existing);
    assert.deepEqual(known.map(d => d.nativeId), ['nvr-1-ch0-nightmode', 'nvr-1-ch0-rawmotion'], 'read: removed');
});

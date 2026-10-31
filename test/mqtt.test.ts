import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// the add-on only needs the SDK at runtime; these tests use the pure entity list
const origLoad = (Module as any)._load;
(Module as any)._load = function (req: string, ...rest: any[]) {
    if (req === '@scrypted/sdk') return { __esModule: true, default: { deviceManager: {}, systemManager: { getDeviceById: () => undefined } } };
    return origLoad.call(this, req, ...rest);
};
const { rawEntities } = require('../src/mqtt');

test('raw entities: camera motion plus one occupancy per supported AI class, named as Home Assistant ids them', () => {
    const e = rawEntities('Front Door', ['people', 'vehicle', 'dog_cat', 'Bad Class']);
    assert.deepEqual(e.map((x: any) => [x.key, x.name, x.object_id, x.device_class]), [
        ['motion', 'Camera motion', 'front_door_camera_motion', 'motion'],
        ['people', 'Camera person', 'front_door_camera_person', 'occupancy'],
        ['vehicle', 'Camera vehicle', 'front_door_camera_vehicle', 'occupancy'],
        ['dog_cat', 'Camera animal', 'front_door_camera_animal', 'occupancy'],
    ]);
});

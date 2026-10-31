import { AddonEntity, MqttAddon, slug } from './mqtt-addon';

/** This plugin's add-on for the Scrypted MQTT bridge; started by the plugin. */
export const reolinkMqtt = new MqttAddon('reolink', console);

const CLASS_LABEL: Record<string, string> = { people: 'person', vehicle: 'vehicle', dog_cat: 'animal', face: 'face', package: 'package' };

/** Raw camera motion and one entity per AI class the channel supports; ids as Home Assistant names them. */
export function rawEntities(cameraName: string, classes: string[]): AddonEntity[] {
    const base = slug(cameraName);
    const entity = (key: string, label: string, deviceClass: string): AddonEntity => ({
        key, name: `Camera ${label}`, platform: 'binary_sensor', device_class: deviceClass,
        ...(base ? { object_id: `${base}_camera_${slug(label)}` } : {}),
    });
    return [
        entity('motion', 'motion', 'motion'),
        ...classes.filter(c => /^[a-z0-9][a-z0-9_]{0,63}$/.test(c)).map(c => entity(c, CLASS_LABEL[c] ?? c.replace(/_/g, ' '), 'occupancy')),
    ];
}

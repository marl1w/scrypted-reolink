import { rawClasses, rawClassLabel } from './devices';
import { AddonEntity, MqttAddon, slug } from './mqtt-addon';

/** This plugin's add-on for the Scrypted MQTT bridge; started by the plugin. */
export const reolinkMqtt = new MqttAddon('reolink', console);

/** Raw camera motion and one entity per AI class the channel supports; ids as Home Assistant names them. */
export function rawEntities(cameraName: string, classes: string[]): AddonEntity[] {
    const base = slug(cameraName);
    const entity = (key: string, label: string, deviceClass: string): AddonEntity => ({
        key, name: `Camera ${label}`, platform: 'binary_sensor', device_class: deviceClass,
        ...(base ? { object_id: `${base}_camera_${slug(label)}` } : {}),
    });
    return [
        entity('motion', 'motion', 'motion'),
        ...rawClasses(classes).map(c => entity(c, rawClassLabel(c), 'occupancy')),
    ];
}

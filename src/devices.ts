// Pure device manifests (no SDK runtime calls), so they can be unit tested.
// Plain strings equal to the SDK enum values: this module must load without the Scrypted runtime.
import { createHash } from 'node:crypto';
import type { Ability, ChannelStatus, DevInfo } from './http/nvr-api';
import { hasFloodlight, hasSiren } from './http/nvr-api';

export interface DeviceManifest {
    nativeId: string;
    providerNativeId?: string;
    name: string;
    type: string;
    interfaces: string[];
    info?: Record<string, string | undefined>;
}

/** Camera native id: scoped by the NVR so that several NVRs never collide. */
export function cameraNativeId(nvrNativeId: string, channel: number) {
    return `${nvrNativeId}-ch${channel}`;
}

export function parseCameraNativeId(nativeId: string): { nvr: string; channel: number } | undefined {
    const m = /^(.*)-ch(\d+)$/.exec(nativeId);
    return m ? { nvr: m[1], channel: parseInt(m[2], 10) } : undefined;
}

export interface ChannelCache {
    channel: number;
    name?: string;
    online?: boolean;
    model?: string;
    firmware?: string;
    /** shown as the serial number (HomeKit: else "Default-SerialNumber"); see cameraSerialNumber */
    serialNumber?: string;
    /** the camera's UID from GetChannelstatus, '' for none (some models, B800); absent in caches before 0.1.17 */
    uid?: string;
    /** the camera's own serial number, over Baichuan (cmd 318); kept once seen, an offline camera does not answer */
    cameraSerial?: string;
    exactType?: string;
    aiClasses?: string[];
    ability?: Ability;
    enc?: any;
    updatedAt?: number;
}

export function cameraInterfaces(cache: ChannelCache): string[] {
    const ifs: string[] = [
        'VideoCamera',
        'Camera',
        'MotionSensor',
        'ObjectDetector',
        'Settings',
        'Online',
        'VideoClips',
        'VideoRecorder',
        // Night mode and Camera motion children on every camera; siren and floodlight where supported
        'DeviceProvider',
    ];
    return ifs;
}

/** Camera names carry the NVR name, so channels with the same name on two NVRs stay distinct. */
export function buildCameraDevice(nvrNativeId: string, cache: ChannelCache, nvrName?: string): DeviceManifest {
    const channelName = cache.name || `Channel ${cache.channel + 1}`;
    return {
        nativeId: cameraNativeId(nvrNativeId, cache.channel),
        providerNativeId: nvrNativeId,
        name: nvrName ? `${nvrName} ${channelName}` : channelName,
        type: 'Camera',
        interfaces: cameraInterfaces(cache),
        info: { manufacturer: 'Reolink', model: cache.model, firmware: cache.firmware, serialNumber: cache.serialNumber },
    };
}

export const nightModeNativeId = (cameraNativeIdValue: string) => `${cameraNativeIdValue}-nightmode`;
export const rawMotionNativeId = (cameraNativeIdValue: string) => `${cameraNativeIdValue}-rawmotion`;

const RAW_CLASS_LABEL: Record<string, string> = { people: 'person', vehicle: 'vehicle', dog_cat: 'animal', face: 'face', package: 'package' };

/** AI classes with a raw child / add-on entity: the device's own names, kept to safe identifiers. */
export const rawClasses = (aiClasses: string[] | undefined) => (aiClasses ?? []).filter(c => /^[a-z0-9][a-z0-9_]{0,63}$/.test(c));

/** A device AI class as people name it (people -> person, dog_cat -> animal), as the MQTT add-on names its entities. */
export const rawClassLabel = (cls: string) => RAW_CLASS_LABEL[cls] ?? cls.replace(/_/g, ' ');

export const rawClassNativeId = (cameraNativeIdValue: string, cls: string) => `${cameraNativeIdValue}-raw-${rawClassLabel(cls).replace(/ /g, '_')}`;

/**
 * Night mode (on while the camera is in IR / black and white, from the NVR's day/night push), Camera motion and
 * Camera <class> per supported AI class (the camera's raw levels from each push: no hold, no trigger rule, no day/night
 * ignore), then siren and floodlight with the stock suffixes and types.
 */
export function buildChildDevices(cameraNativeIdValue: string, cameraName: string, cache: ChannelCache, existing: string[] = []): DeviceManifest[] {
    const id = cameraNativeIdValue;
    const rawPrefix = `${id}-raw-`;
    // a field not read yet (no ability, no AI classes) keeps the children announced before, rather than removing them
    const raw = cache.aiClasses
        ? rawClasses(cache.aiClasses).map(c => ({ nativeId: rawClassNativeId(id, c), label: rawClassLabel(c) }))
        : existing.filter(n => n.startsWith(rawPrefix) && /^[a-z0-9_]+$/.test(n.slice(rawPrefix.length))).map(n => ({ nativeId: n, label: n.slice(rawPrefix.length).replace(/_/g, ' ') }));
    const out: DeviceManifest[] = [
        { nativeId: nightModeNativeId(id), providerNativeId: id, name: `${cameraName} Night mode`, type: 'Sensor', interfaces: ['BinarySensor'] },
        { nativeId: rawMotionNativeId(id), providerNativeId: id, name: `${cameraName} Camera motion`, type: 'Sensor', interfaces: ['MotionSensor'] },
        // one per AI class the channel supports: the camera's raw level, named as the add-on's "Camera person" entities
        ...raw.map(r => ({ nativeId: r.nativeId, providerNativeId: id, name: `${cameraName} Camera ${r.label}`, type: 'Sensor', interfaces: ['OccupancySensor'] })),
    ];
    const known = !!cache.ability;
    if (known ? hasSiren(cache.ability, cache.channel) : existing.includes(`${id}-siren`))
        out.push({ nativeId: `${id}-siren`, providerNativeId: id, name: `${cameraName} Siren`, type: 'Siren', interfaces: ['OnOff'] });
    if (known ? hasFloodlight(cache.ability, cache.channel) : existing.includes(`${id}-floodlight`))
        out.push({ nativeId: `${id}-floodlight`, providerNativeId: id, name: `${cameraName} Floodlight`, type: 'Light', interfaces: ['OnOff'] });
    return out;
}

/**
 * `id` is the child's native id after the camera's (`<camera>-<id>`): by default `crop-<slug>` or `mirror-<slug>`.
 * An entry can keep an existing device's id with a trailing ` @<id>` (`crop-...` or `mirror-...`), so a device
 * keeps its Scrypted id - and with it its HomeKit pairing and its Home Assistant device - when it is renamed or
 * changes role: the role is the entry's list, never the id.
 */
export interface CropSpec { slug: string; name: string; id: string; width: number; height: number; x: number; y: number }

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const CHILD_ID = /^(?:crop|mirror)-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `<rest> @<id>`: the entry without the id, and the id when it is a valid one (an invalid one skips the entry). */
function splitId(entry: string): { rest: string; id?: string; bad?: boolean } {
    const m = /^(.*?)\s+@(\S+)\s*$/.exec(entry);
    if (!m) return { rest: entry };
    return CHILD_ID.test(m[2]) ? { rest: m[1], id: m[2] } : { rest: m[1], bad: true };
}

/**
 * Crop cameras configured on a camera, one per entry `Name=width:height:x:y` (pixels of the substream), optionally
 * followed by ` @<id>`. Invalid entries, repeated names and repeated ids are skipped.
 */
export function parseCrops(entries: unknown): CropSpec[] {
    const out: CropSpec[] = [];
    for (const e of Array.isArray(entries) ? entries : []) {
        const { rest, id: given, bad } = splitId(String(e));
        if (bad) continue;
        const m = /^\s*([^=]+?)\s*=\s*(\d+):(\d+):(\d+):(\d+)\s*$/.exec(rest);
        if (!m) continue;
        const name = m[1];
        const slug = slugOf(name);
        const id = given ?? `crop-${slug}`;
        if (!slug || out.some(c => c.slug === slug || c.id === id)) continue;
        out.push({ slug, name, id, width: +m[2], height: +m[3], x: +m[4], y: +m[5] });
    }
    return out;
}

/** A crop's or mirror's native id: `<camera>-<id>`. */
export const childNativeId = (cameraNativeIdValue: string, id: string) => `${cameraNativeIdValue}-${id}`;

/** A short stable tag for a crop or mirror serial: the slug embeds user-chosen names. */
export const slugTag = (slug: string) => createHash('sha1').update(slug).digest('hex').slice(0, 6);

/** `<camera serial>-crop-<tag>` / `-mirror-<tag>` from the id, so a device that keeps its id keeps its serial too. */
function childSerial(serialNumber: string | undefined, id: string): string | undefined {
    const m = /^(crop|mirror)-(.+)$/.exec(id);
    return serialNumber && m ? `${serialNumber}-${m[1]}-${slugTag(m[2])}` : undefined;
}

/**
 * The role of a derived camera, announced as its `info.model`. Its native id cannot tell: an entry ending in ` @<id>`
 * keeps the id the device had in its earlier role (a mirror on `crop-...`, a crop on `mirror-...`).
 */
export const DERIVED_MODEL = { crop: 'Crop', mirror: 'Mirror' } as const;

/**
 * Crops have no coordinates of their own to tell where the camera saw motion (Reolink AI reports className and
 * score only), so each crop takes its parent's raw motion and AI detections as its trigger, and Coral Guard on the
 * crop verifies whether the subject is in the crop's picture.
 */
export function buildCropDevices(cameraNativeIdValue: string, crops: CropSpec[], serialNumber?: string): DeviceManifest[] {
    return crops.map(c => ({
        nativeId: childNativeId(cameraNativeIdValue, c.id),
        providerNativeId: cameraNativeIdValue,
        name: c.name,
        type: 'Camera',
        interfaces: ['VideoCamera', 'MotionSensor', 'ObjectDetector', 'Settings'],
        // the role, for consumers: the native id keeps the id a device had before it changed role (crop-... as a mirror)
        info: { manufacturer: 'Reolink', model: DERIVED_MODEL.crop, serialNumber: childSerial(serialNumber, c.id) },
    }));
}

/** The camera's own view: `width:height:x:y` in substream pixels, or undefined for the whole frame. */
export function parseViewCrop(value: unknown): Omit<CropSpec, 'slug' | 'name' | 'id'> | undefined {
    const m = /^\s*(\d+):(\d+):(\d+):(\d+)\s*$/.exec(String(value ?? ''));
    return m ? { width: +m[1], height: +m[2], x: +m[3], y: +m[4] } : undefined;
}

/** `source` is the crop's slug, `sourceId` its id. */
export interface MirrorSpec { slug: string; name: string; id: string; source: string; sourceId: string }

/**
 * Mirror cameras, one per entry `Name=<crop name>`, optionally followed by ` @<id>`: the same stream, motion and
 * presence as one of this camera's crops, as a second accessory (a HomeKit accessory pairs into one Home only).
 * Entries naming no configured crop, and names or ids a crop or another mirror already has, are skipped.
 */
export function parseMirrors(entries: unknown, crops: CropSpec[]): MirrorSpec[] {
    const out: MirrorSpec[] = [];
    for (const e of Array.isArray(entries) ? entries : []) {
        const { rest, id: given, bad } = splitId(String(e));
        if (bad) continue;
        const m = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(rest);
        if (!m) continue;
        const slug = slugOf(m[1]);
        const id = given ?? `mirror-${slug}`;
        const source = crops.find(c => c.slug === slugOf(m[2]));
        if (!slug || !source || out.some(x => x.slug === slug || x.id === id) || crops.some(c => c.slug === slug || c.id === id)) continue;
        out.push({ slug, name: m[1], id, source: source.slug, sourceId: source.id });
    }
    return out;
}

export const MIRROR_PRESENCE = ['Vehicle', 'Animal'] as const;

export function buildMirrorDevices(cameraNativeIdValue: string, mirrors: MirrorSpec[], serialNumber?: string): { mirrors: DeviceManifest[]; children: DeviceManifest[] } {
    const out = { mirrors: [] as DeviceManifest[], children: [] as DeviceManifest[] };
    for (const m of mirrors) {
        const nativeId = childNativeId(cameraNativeIdValue, m.id);
        out.mirrors.push({
            nativeId,
            providerNativeId: cameraNativeIdValue,
            name: m.name,
            type: 'Camera',
            interfaces: ['VideoCamera', 'Camera', 'MotionSensor', 'OccupancySensor', 'ObjectDetector', 'Settings', 'DeviceProvider'],
            info: { manufacturer: 'Reolink', model: DERIVED_MODEL.mirror, serialNumber: childSerial(serialNumber, m.id) },
        });
        // Named "<camera> Vehicle Presence" so the patched HomeKit plugin puts them inside the camera tile.
        for (const g of MIRROR_PRESENCE)
            out.children.push({ nativeId: `${nativeId}-${g.toLowerCase()}`, providerNativeId: nativeId, name: `${m.name} ${g} Presence`, type: 'Sensor', interfaces: ['OccupancySensor'] });
    }
    return out;
}

/** Empty, all-zero ("00000000000000", "00:00:00:00:00:00") or absent: the NVRs report their serial so. */
export function realId(s: string | undefined): string | undefined {
    const t = s?.trim();
    return t && !/^[0:\-]*$/.test(t) ? t : undefined;
}

/** The NVR identifiers a channel without one of its own falls back to. */
export interface NvrIds {
    /** GetDevInfo serial (all zeros on the NVRs seen so far) */
    serial?: string;
    /** Baichuan cmd 114 */
    uid?: string;
    /** Baichuan cmd 76 */
    mac?: string;
}

/**
 * Serial number of a channel's camera, first that is real: its UID (kept first: what 0.1.15 showed), its own
 * serial from Baichuan, else the NVR's serial, UID or MAC with the channel: unique on the NVR, and stable.
 * Last resort, before the first Baichuan session: the model and the channel. Never all zeros.
 */
export function cameraSerialNumber(channel: number, cam: { uid?: string; cameraSerial?: string; model?: string }, nvr: NvrIds): string | undefined {
    const own = realId(cam.uid) ?? realId(cam.cameraSerial);
    if (own) return own;
    const host = realId(nvr.serial) ?? realId(nvr.uid) ?? realId(nvr.mac)?.replace(/[:\-]/g, '').toUpperCase() ?? realId(cam.model);
    return host ? `${host}-${channel + 1}` : undefined;
}

/**
 * Camera serials from Baichuan, without values two channels share: some models report one placeholder serial
 * for every unit (seen on two Duo 2 cameras), which would make the serial ambiguous.
 */
export function distinctSerials(serials: Map<number, string | undefined>): Map<number, string | undefined> {
    const count = new Map<string, number>();
    for (const s of serials.values()) if (s) count.set(s, (count.get(s) ?? 0) + 1);
    return new Map([...serials].map(([ch, s]) => [ch, s && count.get(s) === 1 ? s : undefined]));
}

/** Channel cache from discovery results. Model follows the stock rule: the channel's typeInfo. */
export function channelCacheFrom(channel: number, nvr: DevInfo, status: ChannelStatus | undefined, details: { chnTypeInfo?: any; enc?: any; cameraSerial?: string; nvrIds?: NvrIds }, ability: Ability | undefined, aiClasses: string[], now = Date.now()): ChannelCache {
    const uid = realId(status?.uid) ?? '';
    return {
        channel,
        name: status?.name,
        online: status ? status.online === 1 : undefined,
        model: details.chnTypeInfo?.typeInfo ?? status?.typeInfo ?? nvr.model,
        firmware: details.chnTypeInfo?.firmVer,
        serialNumber: cameraSerialNumber(channel, { uid, cameraSerial: details.cameraSerial, model: details.chnTypeInfo?.typeInfo ?? status?.typeInfo }, { ...details.nvrIds, serial: nvr.serial }),
        uid,
        cameraSerial: details.cameraSerial,
        exactType: nvr.exactType,
        aiClasses,
        // Keep the shape abilityChn[channel] so the stock ability rules work unchanged.
        ability: ability ? { ...ability } : undefined,
        enc: details.enc,
        updatedAt: now,
    };
}

export interface HealthInput {
    pushState: string;
    channels: number;
    lastEventAt?: number;
    httpSessions: number;
    reconnects: number;
    lastError?: string;
    now?: number;
}

export function formatHealth(h: HealthInput): string {
    const now = h.now ?? Date.now();
    const age = h.lastEventAt ? `${Math.max(0, Math.round((now - h.lastEventAt) / 1000))} s ago` : 'never';
    return `Push: ${h.pushState} · ${h.channels} channels · last event ${age} · HTTP sessions ${h.httpSessions} · reconnects ${h.reconnects}`
        + (h.lastError ? ` · last error: ${h.lastError}` : '');
}

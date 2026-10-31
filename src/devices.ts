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
    ];
    if (hasSiren(cache.ability, cache.channel) || hasFloodlight(cache.ability, cache.channel))
        ifs.push('DeviceProvider');
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

/** Siren and floodlight children, with the stock suffixes and types. */
export function buildChildDevices(cameraNativeIdValue: string, cameraName: string, cache: ChannelCache): DeviceManifest[] {
    const out: DeviceManifest[] = [];
    if (hasSiren(cache.ability, cache.channel))
        out.push({ nativeId: `${cameraNativeIdValue}-siren`, providerNativeId: cameraNativeIdValue, name: `${cameraName} Siren`, type: 'Siren', interfaces: ['OnOff'] });
    if (hasFloodlight(cache.ability, cache.channel))
        out.push({ nativeId: `${cameraNativeIdValue}-floodlight`, providerNativeId: cameraNativeIdValue, name: `${cameraName} Floodlight`, type: 'Light', interfaces: ['OnOff'] });
    return out;
}

export interface CropSpec { slug: string; name: string; width: number; height: number; x: number; y: number }

/**
 * Crop cameras configured on a camera, one per entry `Name=width:height:x:y` (pixels of the substream).
 * Invalid entries are skipped.
 */
export function parseCrops(entries: unknown): CropSpec[] {
    const out: CropSpec[] = [];
    for (const e of Array.isArray(entries) ? entries : []) {
        const m = /^\s*([^=]+?)\s*=\s*(\d+):(\d+):(\d+):(\d+)\s*$/.exec(String(e));
        if (!m) continue;
        const name = m[1];
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!slug || out.some(c => c.slug === slug)) continue;
        out.push({ slug, name, width: +m[2], height: +m[3], x: +m[4], y: +m[5] });
    }
    return out;
}

export const cropNativeId = (cameraNativeIdValue: string, slug: string) => `${cameraNativeIdValue}-crop-${slug}`;

/** A short stable tag for a crop or mirror serial: the slug embeds user-chosen names. */
export const slugTag = (slug: string) => createHash('sha1').update(slug).digest('hex').slice(0, 6);

export function buildCropDevices(cameraNativeIdValue: string, crops: CropSpec[], serialNumber?: string): DeviceManifest[] {
    return crops.map(c => ({
        nativeId: cropNativeId(cameraNativeIdValue, c.slug),
        providerNativeId: cameraNativeIdValue,
        name: c.name,
        type: 'Camera',
        interfaces: ['VideoCamera', 'Settings'],
        info: { manufacturer: 'Reolink', serialNumber: serialNumber && `${serialNumber}-crop-${slugTag(c.slug)}` },
    }));
}

/** The camera's own view: `width:height:x:y` in substream pixels, or undefined for the whole frame. */
export function parseViewCrop(value: unknown): Omit<CropSpec, 'slug' | 'name'> | undefined {
    const m = /^\s*(\d+):(\d+):(\d+):(\d+)\s*$/.exec(String(value ?? ''));
    return m ? { width: +m[1], height: +m[2], x: +m[3], y: +m[4] } : undefined;
}

export interface MirrorSpec { slug: string; name: string; source: string }

/**
 * Mirror cameras, one per entry `Name=<crop name>`: the same stream, motion and presence as one of this
 * camera's crops, as a second accessory (a HomeKit accessory pairs into one Home only). Entries naming no
 * configured crop are skipped.
 */
export function parseMirrors(entries: unknown, crops: CropSpec[]): MirrorSpec[] {
    const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const out: MirrorSpec[] = [];
    for (const e of Array.isArray(entries) ? entries : []) {
        const m = /^\s*([^=]+?)\s*=\s*(.+?)\s*$/.exec(String(e));
        if (!m) continue;
        const slug = slugOf(m[1]);
        const source = crops.find(c => c.slug === slugOf(m[2]));
        if (!slug || !source || out.some(x => x.slug === slug) || crops.some(c => c.slug === slug)) continue;
        out.push({ slug, name: m[1], source: source.slug });
    }
    return out;
}

export const mirrorNativeId = (cameraNativeIdValue: string, slug: string) => `${cameraNativeIdValue}-mirror-${slug}`;

export const MIRROR_PRESENCE = ['Vehicle', 'Animal'] as const;

export function buildMirrorDevices(cameraNativeIdValue: string, mirrors: MirrorSpec[], serialNumber?: string): { mirrors: DeviceManifest[]; children: DeviceManifest[] } {
    const out = { mirrors: [] as DeviceManifest[], children: [] as DeviceManifest[] };
    for (const m of mirrors) {
        const nativeId = mirrorNativeId(cameraNativeIdValue, m.slug);
        out.mirrors.push({
            nativeId,
            providerNativeId: cameraNativeIdValue,
            name: m.name,
            type: 'Camera',
            interfaces: ['VideoCamera', 'Camera', 'MotionSensor', 'OccupancySensor', 'ObjectDetector', 'Settings', 'DeviceProvider'],
            info: { manufacturer: 'Reolink', serialNumber: serialNumber && `${serialNumber}-mirror-${slugTag(m.slug)}` },
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

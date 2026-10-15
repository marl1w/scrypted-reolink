// Pure device manifests (no SDK runtime calls), so they can be unit tested.
// Plain strings equal to the SDK enum values: this module must load without the Scrypted runtime.
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
        info: { manufacturer: 'Reolink', model: cache.model, firmware: cache.firmware },
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

export function buildCropDevices(cameraNativeIdValue: string, crops: CropSpec[]): DeviceManifest[] {
    return crops.map(c => ({
        nativeId: cropNativeId(cameraNativeIdValue, c.slug),
        providerNativeId: cameraNativeIdValue,
        name: c.name,
        type: 'Camera',
        interfaces: ['VideoCamera', 'Settings'],
    }));
}

/** Channel cache from discovery results. Model follows the stock rule: the channel's typeInfo. */
export function channelCacheFrom(channel: number, nvr: DevInfo, status: ChannelStatus | undefined, details: { chnTypeInfo?: any; enc?: any }, ability: Ability | undefined, aiClasses: string[], now = Date.now()): ChannelCache {
    return {
        channel,
        name: status?.name,
        online: status ? status.online === 1 : undefined,
        model: details.chnTypeInfo?.typeInfo ?? status?.typeInfo ?? nvr.model,
        firmware: details.chnTypeInfo?.firmVer,
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

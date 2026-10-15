import sdk, { Camera, DeviceProvider, EventListenerRegister, MediaObject, MediaStreamUrl, MotionSensor, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, OccupancySensor, OnOff, Online, PictureOptions, RequestMediaStreamOptions, RequestPictureOptions, ResponseMediaStreamOptions, ScryptedDevice, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import type { PushEvent } from './baichuan/events';
import { MotionController, MotionTrigger } from './motion';
import { KeyframeCache } from './snapshot-cache';
import { cropNativeId, MIRROR_PRESENCE, mirrorNativeId, parseCrops, parseMirrors, parseViewCrop } from './devices';
import { addStreamCredentials, buildStreamOptions, StreamOption } from './streams';
import type { ReolinkNvr } from './nvr';

const SNAPSHOT_REUSE_MS = 300;
const SNAPSHOT_WAIT_MS = 1500;

export class ReolinkChannelCamera extends ScryptedDeviceBase implements VideoCamera, Camera, MotionSensor, ObjectDetector, Settings, Online, DeviceProvider {
    storageSettings = new StorageSettings(this, {
        motionTimeout: {
            title: 'Motion Timeout',
            description: 'Seconds motion stays on after the last motion or AI push. Extended by every new push.',
            type: 'number',
            defaultValue: 50,
        },
        motionTrigger: {
            title: 'Motion Trigger',
            description: 'Motion + AI uses raw motion and AI classes. AI Only ignores raw motion.',
            choices: ['Motion + AI', 'AI Only'],
            defaultValue: 'Motion + AI',
        },
        dayNightIgnoreSeconds: {
            title: 'Ignore Motion After Day/Night Switch',
            description: 'Seconds after a day/night switch during which raw motion (not AI) is ignored. 0 turns it off.',
            type: 'number',
            defaultValue: 0,
        },
        snapshotCache: {
            title: 'Snapshot Cache',
            description: 'Keep the low-resolution stream open and decode the next keyframe on request, as go2rtc does. Off uses the NVR snapshot API.',
            type: 'boolean',
            defaultValue: false,
            onPut: (_o, v) => v ? this.snapshots.start() : this.snapshots.stop(),
        },
        crops: {
            title: 'Crop Cameras',
            description: 'Extra cameras cut from this one: Name=width:height:x:y in substream pixels. The crop itself is the Rebroadcast output prefix of the crop camera (-vf crop=...); the crop camera reads this camera through Scrypted, adding no NVR connection.',
            multiple: true,
            combobox: true,
            defaultValue: [],
            onPut: () => this.nvr.syncDevices(),
        },
        viewCrop: {
            title: 'View Crop',
            description: 'Show only part of the frame as this camera: width:height:x:y in substream pixels, empty for the whole frame. Adds a "View" stream, the substream cropped by the Rebroadcast output prefix of that stream (-vf crop=... plus an H.264 encode); snapshots are cropped the same way. Crop cameras still read the whole substream.',
            defaultValue: '',
        },
        mirrors: {
            title: 'Mirror Cameras',
            description: 'Name=<crop camera name>: the same stream, motion and presence as that crop camera, as another accessory (a HomeKit accessory pairs into one Home only). Nothing is encoded or analysed twice.',
            multiple: true,
            combobox: true,
            defaultValue: [],
            onPut: () => this.nvr.syncDevices(),
        },
        dayNight: {
            title: 'Day/Night',
            readonly: true,
            defaultValue: '',
        },
    });

    readonly motion: MotionController;
    readonly snapshots: KeyframeCache;
    private children = new Map<string, ScryptedDeviceBase>();

    constructor(nativeId: string, readonly nvr: ReolinkNvr, readonly channel: number) {
        super(nativeId);
        this.motion = new MotionController(() => ({
            timeoutMs: (Number(this.storageSettings.values.motionTimeout) || 50) * 1000,
            dayNightIgnoreMs: (Number(this.storageSettings.values.dayNightIgnoreSeconds) || 0) * 1000,
            trigger: this.storageSettings.values.motionTrigger as MotionTrigger,
            repeatMs: 1000,
        }), {
            setMotion: on => { this.motionDetected = on; },
            detections: classes => {
                const od: ObjectsDetected = {
                    timestamp: Date.now(),
                    detections: classes.map(className => ({ className, score: 1 })),
                    sourceId: this.pluginId,
                };
                sdk.deviceManager.onDeviceEvent(this.nativeId, ScryptedInterface.ObjectDetector, od);
            },
            dayNight: mode => { this.storageSettings.values.dayNight = mode; },
        });
        this.snapshots = new KeyframeCache({
            ffmpegPath: () => sdk.mediaManager.getFFmpegPath(),
            source: () => this.snapshotSource(),
            log: m => this.console.warn(m),
            videoFilter: () => {
                const v = this.viewCrop();
                return v && `crop=${v.width}:${v.height}:${v.x}:${v.y}`;
            },
        });
        if (this.storageSettings.values.snapshotCache) this.snapshots.start();
    }

    viewCrop() {
        return parseViewCrop(this.storageSettings.values.viewCrop);
    }

    private viewOption(): ResponseMediaStreamOptions | undefined {
        const v = this.viewCrop();
        return v && { id: 'view', name: 'View', container: 'rtsp', video: { codec: 'h264', width: v.width, height: v.height } };
    }

    /**
     * The substream as this device's mixins serve it (the Rebroadcast prebuffer, so no new NVR connection),
     * labelled as another stream: the View stream and the crop cameras are built on it.
     */
    async readSubstream(options: RequestMediaStreamOptions | undefined, opts: ResponseMediaStreamOptions): Promise<MediaObject> {
        const self = sdk.systemManager.getDeviceById<VideoCamera>(this.id);
        const mo = await self.getVideoStream({ ...options, id: this.snapshotStream().id, destination: 'local' } as RequestMediaStreamOptions);
        const ff = await sdk.mediaManager.convertMediaObjectToJSON<any>(mo, ScryptedMimeTypes.FFmpegInput);
        return sdk.mediaManager.createFFmpegMediaObject({ ...ff, mediaStreamOptions: { ...ff.mediaStreamOptions, ...opts } });
    }

    /** The lowest-resolution RTSP stream: keyframes are cheap to decode and match what HomeKit shows. */
    snapshotStream(): StreamOption {
        const rtsp = this.streams().filter(s => s.container === 'rtsp' && s.url);
        rtsp.sort((a, b) => (a.video?.width ?? 1e9) - (b.video?.width ?? 1e9));
        const s = rtsp.find(x => x.id.endsWith(`_${String(this.channel + 1).padStart(2, '0')}_sub`)) ?? rtsp[0];
        if (!s) throw new Error('no RTSP stream');
        return s;
    }

    /**
     * Prefer Scrypted's local rebroadcast of the substream (the prebuffer already holds the one NVR connection),
     * asked for through the device's mixins; fall back to the NVR itself and retry the rebroadcast later.
     */
    private async snapshotSource(): Promise<{ url: string; label: string; retryMs?: number }> {
        const s = this.snapshotStream();
        try {
            const dev = sdk.systemManager.getDeviceById<VideoCamera>(this.id);
            const mo = await Promise.race([
                dev.getVideoStream({ id: s.id, prebuffer: 0, destination: 'local' } as RequestMediaStreamOptions),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
            ]);
            const ff = await sdk.mediaManager.convertMediaObjectToJSON<any>(mo, ScryptedMimeTypes.FFmpegInput);
            const url = String(ff?.url || '');
            if (/^rtsp:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url))
                return { url, label: 'rebroadcast' };
        }
        catch (e) {
            this.console.warn(`snapshot cache: rebroadcast unavailable (${(e as Error).message}), reading the NVR`);
        }
        return { url: addStreamCredentials(s.url, this.nvr.username, this.nvr.password), label: 'nvr', retryMs: 60000 };
    }

    onPush(ev: PushEvent) {
        this.motion.handle(ev);
    }

    private streams(): StreamOption[] {
        const c = this.nvr.channelCache(this.channel);
        return buildStreamOptions({
            channel: this.channel,
            deviceInfo: { model: c?.model, exactType: c?.exactType },
            ability: c?.ability,
            enc: c?.enc,
            host: this.nvr.host,
            rtspPort: this.nvr.rtspPort,
            rtmpPort: this.nvr.rtmpPort,
        });
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        const view = this.viewOption();
        return view ? [...this.streams(), view] : this.streams();
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const view = this.viewOption();
        if (view && options?.id === view.id) return this.readSubstream(options, view);
        const vsos = this.streams();
        const vso = vsos.find(s => s.id === options?.id) || vsos[0];
        const ret: MediaStreamUrl = {
            container: vso.container,
            url: addStreamCredentials(vso.url, this.nvr.username, this.nvr.password),
            mediaStreamOptions: vso,
        };
        return sdk.mediaManager.createMediaObject(ret, ScryptedMimeTypes.MediaStreamUrl);
    }

    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        // As go2rtc does: decode the next keyframe (or one that just arrived); the NVR snapshot API is the fallback.
        let jpeg = this.snapshots.running ? await this.snapshots.snapshot(SNAPSHOT_REUSE_MS, SNAPSHOT_WAIT_MS).catch(() => undefined) : undefined;
        if (!jpeg) jpeg = await this.nvr.snapshot(this.channel, options?.timeout);
        return sdk.mediaManager.createMediaObject(jpeg, 'image/jpeg');
    }

    async getPictureOptions(): Promise<PictureOptions[]> {
        return [];
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        return { classes: this.nvr.channelCache(this.channel)?.aiClasses ?? [] };
    }

    async getDetectionInput(): Promise<MediaObject> {
        throw new Error('detection input not available');
    }

    async getSettings(): Promise<Setting[]> {
        const c = this.nvr.channelCache(this.channel);
        return [
            ...await this.storageSettings.getSettings(),
            { key: 'info', title: 'Channel', readonly: true, value: `NVR channel ${this.channel} · ${c?.model ?? 'unknown model'} · ${c?.online === false ? 'offline' : 'online'}` },
            { key: 'snapshotInfo', title: 'Snapshot Cache Status', readonly: true, value: this.snapshotStatus() },
        ];
    }

    private snapshotStatus(): string {
        if (!this.snapshots.running) return 'off';
        const age = this.snapshots.age();
        return `${age === undefined ? 'no image yet' : `last keyframe ${(age / 1000).toFixed(1)} s ago`} · ${this.snapshots.keyframes} keyframes · ${this.snapshots.restarts} restarts · ${this.snapshots.diag()}`;
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        await this.storageSettings.putSetting(key, value);
    }

    async getDevice(nativeId: string): Promise<any> {
        let d = this.children.get(nativeId);
        if (!d) {
            if (nativeId.includes('-mirror-')) d = new ReolinkMirrorCamera(nativeId, this);
            else if (nativeId.includes('-crop-')) d = new ReolinkCropCamera(nativeId, this);
            else if (nativeId.endsWith('-siren')) d = new ReolinkSiren(nativeId, this);
            else if (nativeId.endsWith('-floodlight')) d = new ReolinkFloodlight(nativeId, this);
            if (d) this.children.set(nativeId, d);
        }
        return d;
    }

    async releaseDevice(_id: string, nativeId: string): Promise<void> {
        (this.children.get(nativeId) as ReolinkMirrorCamera | undefined)?.dispose?.();
        this.children.delete(nativeId);
    }

    dispose() {
        for (const d of this.children.values()) (d as ReolinkMirrorCamera).dispose?.();
        this.motion.dispose();
        this.snapshots.stop();
    }
}

export class ReolinkSiren extends ScryptedDeviceBase implements OnOff {
    constructor(nativeId: string, readonly camera: ReolinkChannelCamera) { super(nativeId); }
    async turnOn() { await this.camera.nvr.api.setSiren(this.camera.channel, true); this.on = true; }
    async turnOff() { await this.camera.nvr.api.setSiren(this.camera.channel, false); this.on = false; }
}

export class ReolinkFloodlight extends ScryptedDeviceBase implements OnOff {
    constructor(nativeId: string, readonly camera: ReolinkChannelCamera) { super(nativeId); }
    async turnOn() { await this.camera.nvr.api.setWhiteLed(this.camera.channel, true); this.on = true; }
    async turnOff() { await this.camera.nvr.api.setWhiteLed(this.camera.channel, false); this.on = false; }
}

/**
 * A camera cut from its parent camera. It reads the parent through Scrypted (the parent's prebuffer, via its
 * mixins), so it adds no NVR connection and no fixed rebroadcast URL; the crop filter is the Rebroadcast
 * output prefix of this device. Sensorless: it has no motion of its own.
 */
export class ReolinkCropCamera extends ScryptedDeviceBase implements VideoCamera, Settings {
    constructor(nativeId: string, readonly camera: ReolinkChannelCamera) { super(nativeId); }

    private spec() {
        return parseCrops(this.camera.storageSettings.values.crops).find(c => cropNativeId(this.camera.nativeId!, c.slug) === this.nativeId);
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        const c = this.spec();
        return [{ id: 'crop', name: 'Crop', container: 'rtsp', video: { codec: 'h264', width: c?.width, height: c?.height } }];
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const [opts] = await this.getVideoStreamOptions();
        return this.camera.readSubstream(options, opts);
    }

    async getSettings(): Promise<Setting[]> {
        const c = this.spec();
        return [{
            key: 'crop', title: 'Crop', readonly: true,
            value: c ? `${this.camera.name} ${c.width}x${c.height} at ${c.x},${c.y} (Rebroadcast output prefix: -vf crop=${c.width}:${c.height}:${c.x}:${c.y} plus an H.264 encode)` : 'not configured on the parent',
        }];
    }

    async putSetting(): Promise<void> { }
}

const MIRROR_RETRY_MS = 30000;

/**
 * Another accessory for one of the parent's crop cameras: it serves the crop camera's stream as that camera's
 * mixins serve it (already cropped and encoded, so this device's Rebroadcast only copies it), and repeats its
 * motion, occupancy, detections and Coral Guard presence. Nothing is encoded or analysed a second time.
 */
export class ReolinkMirrorCamera extends ScryptedDeviceBase implements VideoCamera, Camera, MotionSensor, OccupancySensor, ObjectDetector, Settings, DeviceProvider {
    private listeners: EventListenerRegister[] = [];
    private boundTo?: string;
    private missing: string[] = [];
    private timer?: NodeJS.Timeout;
    private presence = new Map<string, MirrorPresence>();
    private disposed = false;

    constructor(nativeId: string, readonly camera: ReolinkChannelCamera) {
        super(nativeId);
        this.bindSoon(0);
    }

    private spec() {
        const crops = parseCrops(this.camera.storageSettings.values.crops);
        return parseMirrors(this.camera.storageSettings.values.mirrors, crops).find(m => mirrorNativeId(this.camera.nativeId!, m.slug) === this.nativeId);
    }

    private async source() {
        const s = this.spec();
        if (!s) throw new Error('not configured on the parent');
        const crop = await this.camera.getDevice(cropNativeId(this.camera.nativeId!, s.source)) as ScryptedDeviceBase | undefined;
        const dev = crop?.id && sdk.systemManager.getDeviceById<ScryptedDevice & VideoCamera & Camera & MotionSensor & OccupancySensor & ObjectDetector>(crop.id);
        if (!dev) throw new Error(`crop camera ${s.source} not found`);
        return dev;
    }

    private bindSoon(ms: number) {
        clearTimeout(this.timer);
        if (this.disposed) return;
        this.timer = setTimeout(() => this.bind().catch(e => {
            this.console.warn(`mirror: ${(e as Error).message}, retrying`);
            this.bindSoon(MIRROR_RETRY_MS);
        }), ms);
    }

    private unbind() {
        for (const l of this.listeners) l.removeListener();
        this.listeners = [];
        this.boundTo = undefined;
    }

    /** Follows the source's state; Coral Guard's presence sensors may appear later, so missing ones are retried. */
    private async bind() {
        const src = await this.source();
        if (this.boundTo === src.id && !this.missing.length) return;
        this.unbind();
        const sm = sdk.systemManager;
        this.motionDetected = !!src.motionDetected;
        this.occupied = !!src.occupied;
        this.listeners.push(
            sm.listenDevice(src.id, ScryptedInterface.MotionSensor, (_s, _d, data) => { this.motionDetected = !!data; }),
            sm.listenDevice(src.id, ScryptedInterface.OccupancySensor, (_s, _d, data) => { this.occupied = !!data; }),
            sm.listenDevice(src.id, ScryptedInterface.ObjectDetector, (_s, _d, data) => { sdk.deviceManager.onDeviceEvent(this.nativeId, ScryptedInterface.ObjectDetector, data); }),
        );
        const state = sm.getSystemState();
        this.missing = [];
        for (const g of MIRROR_PRESENCE) {
            const name = `${src.name} ${g} Presence`;
            const id = Object.keys(state).find(i => state[i]?.name?.value === name && (state[i]?.interfaces?.value || []).includes(ScryptedInterface.OccupancySensor));
            const child = this.presenceChild(`${this.nativeId}-${g.toLowerCase()}`);
            if (!id) {
                this.missing.push(name);
                continue;
            }
            child.occupied = !!sm.getDeviceById<OccupancySensor>(id).occupied;
            this.listeners.push(sm.listenDevice(id, ScryptedInterface.OccupancySensor, (_s, _d, data) => { child.occupied = !!data; }));
        }
        this.boundTo = src.id;
        this.console.log(`mirror: following ${src.name}${this.missing.length ? ` (not found yet: ${this.missing.join(', ')})` : ''}`);
        if (this.missing.length) this.bindSoon(MIRROR_RETRY_MS);
    }

    private presenceChild(nativeId: string) {
        let c = this.presence.get(nativeId);
        if (!c) this.presence.set(nativeId, c = new MirrorPresence(nativeId));
        return c;
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        const s = this.spec();
        const c = s && parseCrops(this.camera.storageSettings.values.crops).find(x => x.slug === s.source);
        return [{ id: 'mirror', name: 'Mirror', container: 'rtsp', video: { codec: 'h264', width: c?.width, height: c?.height } }];
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const src = await this.source();
        const mo = await src.getVideoStream({ ...options, id: 'crop', destination: 'local' } as RequestMediaStreamOptions);
        const ff = await sdk.mediaManager.convertMediaObjectToJSON<any>(mo, ScryptedMimeTypes.FFmpegInput);
        const [opts] = await this.getVideoStreamOptions();
        return sdk.mediaManager.createFFmpegMediaObject({ ...ff, mediaStreamOptions: { ...ff.mediaStreamOptions, ...opts } });
    }

    async takePicture(options?: RequestPictureOptions): Promise<MediaObject> {
        return (await this.source()).takePicture(options);
    }

    async getPictureOptions(): Promise<PictureOptions[]> {
        return [];
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        const src = await this.source().catch(() => undefined);
        return (await src?.getObjectTypes?.().catch(() => undefined)) ?? { classes: [] };
    }

    async getDetectionInput(): Promise<MediaObject> {
        throw new Error('detection input not available');
    }

    async getSettings(): Promise<Setting[]> {
        const s = this.spec();
        const src = await this.source().catch(() => undefined);
        return [{
            key: 'mirror', title: 'Mirror', readonly: true,
            value: s ? `${src?.name ?? s.source}: same stream, motion, detections and presence${this.missing.length ? ` · not found yet: ${this.missing.join(', ')}` : ''}` : 'not configured on the parent',
        }];
    }

    async putSetting(): Promise<void> { }

    async getDevice(nativeId: string): Promise<any> {
        return this.presenceChild(nativeId);
    }

    async releaseDevice(_id: string, nativeId: string): Promise<void> {
        this.presence.delete(nativeId);
    }

    dispose() {
        this.disposed = true;
        clearTimeout(this.timer);
        this.unbind();
    }
}

export class MirrorPresence extends ScryptedDeviceBase implements OccupancySensor {
    constructor(nativeId: string) { super(nativeId); }
}

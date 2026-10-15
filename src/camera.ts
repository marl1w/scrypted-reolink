import sdk, { Camera, DeviceProvider, MediaObject, MediaStreamUrl, MotionSensor, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, OnOff, Online, PictureOptions, RequestMediaStreamOptions, RequestPictureOptions, ResponseMediaStreamOptions, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import type { PushEvent } from './baichuan/events';
import { MotionController, MotionTrigger } from './motion';
import { KeyframeCache } from './snapshot-cache';
import { cropNativeId, parseCrops } from './devices';
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
        });
        if (this.storageSettings.values.snapshotCache) this.snapshots.start();
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
        return this.streams();
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
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
            if (nativeId.includes('-crop-')) d = new ReolinkCropCamera(nativeId, this);
            else if (nativeId.endsWith('-siren')) d = new ReolinkSiren(nativeId, this);
            else if (nativeId.endsWith('-floodlight')) d = new ReolinkFloodlight(nativeId, this);
            if (d) this.children.set(nativeId, d);
        }
        return d;
    }

    async releaseDevice(_id: string, nativeId: string): Promise<void> {
        this.children.delete(nativeId);
    }

    dispose() {
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
        const parent = sdk.systemManager.getDeviceById<VideoCamera>(this.camera.id);
        const sub = this.camera.snapshotStream();
        const mo = await parent.getVideoStream({ ...options, id: sub.id, destination: 'local' } as RequestMediaStreamOptions);
        const ff = await sdk.mediaManager.convertMediaObjectToJSON<any>(mo, ScryptedMimeTypes.FFmpegInput);
        const [opts] = await this.getVideoStreamOptions();
        return sdk.mediaManager.createFFmpegMediaObject({ ...ff, mediaStreamOptions: { ...ff.mediaStreamOptions, ...opts } });
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

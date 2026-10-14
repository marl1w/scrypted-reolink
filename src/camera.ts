import sdk, { Camera, DeviceProvider, MediaObject, MediaStreamUrl, MotionSensor, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, OnOff, Online, PictureOptions, RequestMediaStreamOptions, RequestPictureOptions, ResponseMediaStreamOptions, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import type { PushEvent } from './baichuan/events';
import { MotionController, MotionTrigger } from './motion';
import { addStreamCredentials, buildStreamOptions, StreamOption } from './streams';
import type { ReolinkNvr } from './nvr';

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
        dayNight: {
            title: 'Day/Night',
            readonly: true,
            defaultValue: '',
        },
    });

    readonly motion: MotionController;
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
        const jpeg = await this.nvr.snapshot(this.channel, options?.timeout);
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
        ];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        await this.storageSettings.putSetting(key, value);
    }

    async getDevice(nativeId: string): Promise<any> {
        let d = this.children.get(nativeId);
        if (!d) {
            if (nativeId.endsWith('-siren')) d = new ReolinkSiren(nativeId, this);
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

import sdk, { BinarySensor, Camera, DeviceProvider, EventListenerRegister, FFmpegInput, MediaObject, MediaStreamUrl, MotionSensor, ObjectDetectionTypes, ObjectDetector, ObjectsDetected, OccupancySensor, OnOff, Online, PictureOptions, RecordingStreamThumbnailOptions, RequestMediaStreamOptions, RequestPictureOptions, RequestRecordingStreamOptions, ResponseMediaStreamOptions, ScryptedDevice, ScryptedDeviceBase, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera, VideoClip, VideoClipOptions, VideoClips, VideoClipThumbnailOptions, VideoRecorder } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { Cmd } from './baichuan/constants';
import { floodlightXml, sirenXml } from './baichuan/events';
import { rawEntities, reolinkMqtt } from './mqtt';
import type { PushEvent } from './baichuan/events';
import { MotionController, MotionTrigger } from './motion';
import { KeyframeCache } from './snapshot-cache';
import { cropNativeId, MIRROR_PRESENCE, mirrorNativeId, nightModeNativeId, parseCrops, parseMirrors, parseViewCrop, rawClasses, rawClassNativeId, rawMotionNativeId } from './devices';
import { isNight, MediaLinkKind, recordingStreamFor, RecordingStreamType } from './recordings';
import { linkExpiry, mediaLink } from './media-http';
import type { NvrRecordings, RecordingInput } from './recorder';
import { addStreamCredentials, buildStreamOptions, chooseSubstream, prebufferedStreams, PrebufferView, redactUrl, rtspSubstream, StreamOption } from './streams';
import type { ReolinkNvr } from './nvr';
import { RebroadcastHangWatch } from './rebroadcast-watchdog';

const SNAPSHOT_REUSE_MS = 300;
/** Recording thumbnails are taken at this granularity. */
const THUMBNAIL_BUCKET_MS = 10_000;
const SNAPSHOT_WAIT_MS = 1500;
/** The keyframe cache retries Rebroadcast after reading the NVR for this long, doubling up to the max. */
const REBROADCAST_RETRY_MS = 60_000;
const REBROADCAST_RETRY_MAX_MS = 600_000;
/** After a Rebroadcast restart, the snapshot cache tries Rebroadcast again this soon instead of the backed-off retry. */
const REBROADCAST_RESTART_RETRY_MS = 15_000;
/** Caches start within this spread, not all at once (one NVR, many channels). */
const CACHE_START_SPREAD_MS = 5000;
/** A repeated warning (substream not prebuffered, cache reading the NVR) is logged at most this often. */
const WARN_EVERY_MS = 600_000;

export class ReolinkChannelCamera extends ScryptedDeviceBase implements VideoCamera, Camera, MotionSensor, ObjectDetector, Settings, Online, DeviceProvider, VideoClips, VideoRecorder {
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
            dayNight: mode => this.nightModeState(mode),
            raw: (motion, classes) => this.publishRaw(motion, classes),
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
        if (this.storageSettings.values.snapshotCache) this.snapshots.start(Math.random() * CACHE_START_SPREAD_MS);
        this.watchSettings();
        // states read from the NVR before this device was created
        const st = nvr.channelStates.get(channel);
        if (st?.dayNight !== undefined) this.nightModeState(st.dayNight);
        if (st?.recording !== undefined) this.recordingState(st.recording);
    }

    /** A child's device once it has been announced to Scrypted; undefined before, so no state is written to it. */
    private async announcedChild<T>(nativeId: string): Promise<T | undefined> {
        return this.nvr.isAnnounced(nativeId) ? this.getDevice(nativeId) : undefined;
    }

    /** Day/night as the NVR reports it (push, or the read at subscription): the setting and the Night mode child. */
    nightModeState(mode: string) {
        if (this.storageSettings.values.dayNight !== mode) this.storageSettings.values.dayNight = mode;
        this.dayNightKnown = mode;
        const night = isNight(mode);
        this.announcedChild<ReolinkNightMode>(nightModeNativeId(this.nativeId!)).then(n => {
            if (n && n.binaryState !== night) n.binaryState = night;
        }).catch(() => { /* not announced yet */ });
    }

    /** Day/night reported in this run, for children announced later. */
    private dayNightKnown?: string;

    /** Children were just announced: they get the states known so far. */
    applyChildStates() {
        if (this.dayNightKnown !== undefined) this.nightModeState(this.dayNightKnown);
        if (this.rawKnown) this.publishRaw(this.rawLast.motion, this.rawLast.classes);
    }

    /** Whether the NVR records this channel (cmd 81 `enable`). */
    recordingState(on: boolean) {
        if (this.recordingActive !== on) this.recordingActive = on;
    }

    /** Smart events (line crossing, intrusion...) this channel supports; the others are never reported. */
    smartEvents(): string[] {
        return this.nvr.smartEvents(this.channel);
    }

    private warnedAt = new Map<string, number>();

    /** A warning logged at most every WARN_EVERY_MS per key. */
    private warnEvery(key: string, msg: string) {
        const now = Date.now();
        if (now - (this.warnedAt.get(key) ?? -Infinity) < WARN_EVERY_MS) return;
        this.warnedAt.set(key, now);
        this.console.warn(msg);
    }

    viewCrop() {
        return parseViewCrop(this.storageSettings.values.viewCrop);
    }

    private rawKnown = false;
    private rawConfigKey = '';
    private rawLast: { motion: boolean | undefined; classes: string[] } = { motion: undefined, classes: [] };

    /** The floodlight's state as the NVR pushes it (it also switches by itself, on motion or schedule). */
    floodlightState(on: boolean) {
        this.getDevice(`${this.nativeId}-floodlight`).then((f?: ReolinkFloodlight) => f?.reported(on))
            .catch(() => { /* no floodlight on this channel */ });
    }

    /** The siren's state as the NVR pushes it (cmd 547), also when the camera sounds it by itself. */
    sirenState(on: boolean) {
        this.getDevice(`${this.nativeId}-siren`).then((s?: ReolinkSiren) => {
            if (s && s.on !== on) s.on = on;
        }).catch(() => { /* no siren on this channel */ });
    }

    /** Subscribed again: until the next push says otherwise, nothing is active. */
    rawSubscribed() {
        if (!this.rawKnown) this.publishRaw(false, []);
    }

    /** The channel's AI classes may have changed (discovery): republish the entities with the last known state. */
    rawRediscovered() {
        if (this.rawKnown) this.publishRaw(this.rawLast.motion, this.rawLast.classes);
    }

    /**
     * The camera's own motion and AI classes, exact: the Camera motion child, and entities of this camera in the
     * Scrypted MQTT bridge. Undefined motion: the connection is lost, the level is unknown.
     */
    private publishRaw(motion: boolean | undefined, classes: string[]) {
        this.rawKnown = motion !== undefined;
        this.rawLast = { motion, classes };
        this.announcedChild<ReolinkRawMotion>(rawMotionNativeId(this.nativeId!)).then(m => {
            if (m && m.motionDetected !== motion) m.motionDetected = motion;
        }).catch(() => { /* not announced yet */ });
        for (const c of rawClasses(this.nvr.channelCache(this.channel)?.aiClasses)) {
            const on = motion === undefined ? undefined : classes.includes(c);
            this.announcedChild<ReolinkRawClass>(rawClassNativeId(this.nativeId!, c)).then(o => {
                if (o && o.occupied !== on) o.occupied = on;
            }).catch(() => { /* not announced yet */ });
        }
        if (!this.id) return;
        const declared = this.nvr.channelCache(this.channel)?.aiClasses ?? [];
        const key = `${this.name}|${declared.join(',')}`;
        if (key !== this.rawConfigKey) {
            this.rawConfigKey = key;
            reolinkMqtt.config(this.id, rawEntities(this.name || this.id, declared));
        }
        reolinkMqtt.state(this.id, 'motion', motion ?? null);
        for (const c of declared) reolinkMqtt.state(this.id, c, motion === undefined ? null : classes.includes(c));
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
        const mo = await self.getVideoStream({ ...options, id: (await this.substream(true)).id, destination: 'local' } as RequestMediaStreamOptions);
        const ff = await sdk.mediaManager.convertMediaObjectToJSON<any>(mo, ScryptedMimeTypes.FFmpegInput);
        return sdk.mediaManager.createFFmpegMediaObject({ ...ff, mediaStreamOptions: { ...ff.mediaStreamOptions, ...opts } });
    }

    /** The lowest-resolution RTSP stream: keyframes are cheap to decode and match what HomeKit shows. */
    snapshotStream(): StreamOption {
        const s = rtspSubstream(this.streams(), this.channel);
        if (!s) throw new Error('no RTSP stream');
        return s;
    }

    /** Names and ids of the streams Rebroadcast prebuffers; cached until this device's settings change. */
    private prebuffered?: Promise<string[]>;
    private settingsListener?: EventListenerRegister;
    private settingsTimer?: NodeJS.Timeout;

    private prebufferedNames(): Promise<string[]> {
        this.watchSettings();
        if (!this.prebuffered) {
            const dev = sdk.systemManager.getDeviceById<PrebufferView>(this.id);
            let timer: NodeJS.Timeout | undefined;
            const p = Promise.race([
                prebufferedStreams(dev),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 5000); }),
            ]).finally(() => clearTimeout(timer));
            this.prebuffered = p;
            p.catch(e => {
                if (this.prebuffered === p) this.prebuffered = undefined;
                this.warnEvery('prebuffered', `Rebroadcast settings unreadable (${(e as Error).message})`);
            });
        }
        return this.prebuffered.catch(() => []);
    }

    /**
     * Rebroadcast's settings live on this device (its mixins): a change there, or here, may change the substream it
     * prebuffers, and then the keyframe cache reads the new one.
     */
    private watchSettings() {
        if (this.settingsListener || !this.id) return;
        this.settingsListener = sdk.systemManager.listenDevice(this.id, ScryptedInterface.Settings, () => {
            this.prebuffered = undefined;
            // one change puts several settings: act once they have settled
            clearTimeout(this.settingsTimer);
            this.settingsTimer = setTimeout(() => this.followSubstream().catch(e => this.console.warn(`substream: ${(e as Error).message}`)), 2000);
        });
    }

    /** The cache's stream when it last started; restarted when the substream to read is another one. */
    private cacheStreamId?: string;

    /** The substream may have changed (Rebroadcast settings, Substream Protocol): a running cache reads it again. */
    async followSubstream(force = false) {
        this.prebuffered = undefined;
        if (!this.snapshots.running) return;
        const id = (await this.substream()).id;
        // a cache that has not read yet picks the current substream when it does
        if (!force && (this.cacheStreamId === undefined || id === this.cacheStreamId)) return;
        this.console.log(`snapshot cache: substream ${this.cacheStreamId ?? '?'} -> ${id}, restarting`);
        this.snapshots.restart();
    }

    /**
     * The substream Rebroadcast prebuffers (sub.bcs or h264Preview_NN_sub), read through it so no NVR connection is
     * added; the NVR's Substream Protocol breaks a tie and picks when Rebroadcast prebuffers neither. A reader
     * starting asks with fresh (rare, and a settings event may not reach this device for every mixin).
     */
    async substream(fresh = false): Promise<StreamOption> {
        if (fresh) this.prebuffered = undefined;
        const c = chooseSubstream(this.streams(), this.channel, await this.prebufferedNames(), this.nvr.substreamProtocol, !!this.nvr.channelCache(this.channel));
        if (!c.stream) throw new Error('no substream');
        if (!c.prebuffered)
            this.warnEvery(`substream:${c.stream.id}`, `substream ${c.stream.name} is not prebuffered by Rebroadcast: each reader (keyframe cache, View, crops) opens another NVR connection. Add it to the Rebroadcast Prebuffered Streams of this camera.`);
        return c.stream;
    }

    /** Rebroadcast failures in a row: the retry of a fallback to the NVR grows with them. */
    private rebroadcastFailures = 0;
    private rebroadcastHang = new RebroadcastHangWatch();
    /** Rebroadcast was just restarted: the next fallback to the NVR is retried soon. */
    private rebroadcastRestarted = false;

    /**
     * Makes Rebroadcast drop this camera's sessions and start new ones (a VideoCamera event): a session that hung while
     * the NVR was away is never restarted by Rebroadcast itself.
     */
    restartRebroadcast(reason: string) {
        this.rebroadcastHang.restarted();
        this.rebroadcastFailures = 0;
        this.rebroadcastRestarted = true;
        this.console.warn(`restarting Rebroadcast: ${reason}`);
        sdk.deviceManager.onDeviceEvent(this.nativeId, ScryptedInterface.VideoCamera, undefined);
    }

    /**
     * Prefer Scrypted's local rebroadcast of the substream (the prebuffer already holds the one NVR connection),
     * asked for through the device's mixins; fall back to the NVR's RTSP substream and retry the rebroadcast later.
     */
    private async snapshotSource(): Promise<{ url: string; label: string; retryMs?: number }> {
        const s = this.snapshotStream();
        let reason: string;
        let timer: NodeJS.Timeout | undefined;
        try {
            const sub = await this.substream(true);
            this.cacheStreamId = sub.id;
            const dev = sdk.systemManager.getDeviceById<VideoCamera>(this.id);
            const mo = await Promise.race([
                dev.getVideoStream({ id: sub.id, prebuffer: 0, destination: 'local' } as RequestMediaStreamOptions),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10000); }),
            ]);
            const ff = await sdk.mediaManager.convertMediaObjectToJSON<any>(mo, ScryptedMimeTypes.FFmpegInput);
            const url = String(ff?.url || '');
            if (/^rtsp:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
                this.rebroadcastFailures = 0;
                this.rebroadcastRestarted = false;
                this.rebroadcastHang.ok();
                return { url, label: 'rebroadcast' };
            }
            reason = `not a local rebroadcast: ${redactUrl(url)}`;
        }
        catch (e) {
            reason = (e as Error).message.replace(/\b[a-z]+:\/\/\S+/gi, redactUrl);
            if (reason === 'timeout' && this.rebroadcastHang.timedOut(!!this.online))
                this.restartRebroadcast('it timed out twice in a row while the NVR is online');
        }
        finally {
            clearTimeout(timer);
        }
        const retryMs = this.rebroadcastRestarted ? REBROADCAST_RESTART_RETRY_MS
            : Math.min(REBROADCAST_RETRY_MS * 2 ** this.rebroadcastFailures++, REBROADCAST_RETRY_MAX_MS);
        this.rebroadcastRestarted = false;
        this.warnEvery('snapshot-fallback', `snapshot cache: rebroadcast unavailable (${reason}), reading the NVR (${s.id}), next try in ${retryMs / 1000} s`);
        return { url: addStreamCredentials(s.url, this.nvr.username, this.nvr.password), label: 'nvr', retryMs };
    }

    onPush(ev: PushEvent) {
        if (ev.smart?.length) {
            const supported = this.smartEvents();
            ev = { ...ev, smart: ev.smart.filter(c => supported.includes(c)) };
        }
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
        return { classes: [...this.nvr.channelCache(this.channel)?.aiClasses ?? [], ...this.smartEvents()] };
    }

    async getDetectionInput(): Promise<MediaObject> {
        throw new Error('detection input not available');
    }

    private recorder(): NvrRecordings {
        const r = this.nvr.recordings;
        if (!r) throw new Error('NVR not configured');
        return r;
    }

    /** An FFmpegInput of a recording; `startTime` travels in its metadata for getRecordingStreamCurrentTime. */
    private recordingMedia(input: RecordingInput, stream: RecordingStreamType, startTime: number, duration?: number): Promise<MediaObject> {
        const ff: FFmpegInput = {
            url: input.url,
            inputArguments: input.inputArguments,
            container: input.container,
            mediaStreamOptions: {
                id: stream,
                name: stream === 'main' ? 'Main Stream (recording)' : 'Substream (recording)',
                container: input.container,
                video: {},
                audio: {},
                metadata: { recordingStartTime: startTime, recordingDuration: duration },
            } as ResponseMediaStreamOptions,
        };
        return sdk.mediaManager.createFFmpegMediaObject(ff);
    }

    /**
     * Signed links to clips and their thumbnails, served by the plugin: below its endpoint path (for Scrypted's UI,
     * which loads them from its own origin), or `absolute` on its local endpoint. Undefined when Scrypted gives none.
     */
    private async mediaLinks(absolute = false): Promise<((kind: MediaLinkKind, clipId: string) => string) | undefined> {
        const em = sdk.endpointManager;
        const base = await (absolute ? em.getLocalEndpoint(undefined, { public: true }) : em.getPath(undefined, { public: true }))
            .catch(e => { this.console.warn(`clip links: no plugin endpoint: ${(e as Error).message}`); return undefined; });
        if (!base) return undefined;
        const key = this.nvr.clipKey(), exp = linkExpiry(Date.now());
        return (kind, clipId) => mediaLink(base, { kind, nvr: this.nvr.nativeId!, channel: this.channel, clipId, exp }, key);
    }

    async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
        const clips = await this.recorder().clips(this.channel, { startTime: options?.startTime, endTime: options?.endTime, count: options?.count });
        // Scrypted's UI plays resources.video and shows resources.thumbnail directly (it never asks for the media objects)
        const link = await this.mediaLinks();
        return clips.map(c => ({
            ...c, thumbnailId: c.id, videoId: c.id,
            resources: link ? { thumbnail: { href: link('thumb', c.id) }, video: { href: link('clip', c.id) } } : undefined,
        }));
    }

    /**
     * A clip as video/mp4 a browser plays: a link to the plugin's own endpoint, which remuxes the NVR's playback stream
     * to fragmented MP4 while the clip plays (no converter from an FFmpegInput to a playable type exists). Converts to
     * a local URL (what Scrypted's UI asks for) and a URL, both the plugin's local endpoint.
     */
    async getVideoClip(videoId: string): Promise<MediaObject> {
        // throws on an id that is forged or of another camera: no link is signed for it
        this.recorder().decodeClip(this.channel, videoId);
        const link = await this.mediaLinks(true);
        if (!link) throw new Error('clip unavailable: the plugin has no endpoint');
        const url = link('clip', videoId);
        return sdk.mediaManager.createMediaObject(Buffer.from(url), 'video/mp4', {
            sourceId: this.id,
            toMimeTypes: [ScryptedMimeTypes.LocalUrl, ScryptedMimeTypes.Url],
            convert: async () => Buffer.from(url) as any,
        });
    }

    async getVideoClipThumbnail(thumbnailId: string, _options?: VideoClipThumbnailOptions): Promise<MediaObject> {
        const jpeg = await this.recorder().clipThumbnail(this.channel, thumbnailId);
        return sdk.mediaManager.createMediaObject(jpeg, 'image/jpeg');
    }

    async removeVideoClips(..._videoClipIds: string[]): Promise<void> {
        throw new Error('not supported: NVR recordings are never deleted from here');
    }

    private recordingStream(options?: RequestMediaStreamOptions): RecordingStreamType {
        const v = this.nvr.channelCache(this.channel)?.enc?.mainStream?.vType;
        return recordingStreamFor(options, v === 'h265' || v === 'hevc');
    }

    async getRecordingStream(options: RequestRecordingStreamOptions, _recordingStream?: MediaObject): Promise<MediaObject> {
        const stream = this.recordingStream(options);
        const r = this.recorder();
        const at = await r.recordingAt(this.channel, stream, options.startTime);
        const duration = options.duration && options.duration > 0 ? options.duration / 1000 : undefined;
        // the row was just listed by the NVR: a refusal on it is about the route, not a deleted recording
        const input = await r.input(this.channel, at.row, at.seek, duration, { verified: true });
        return this.recordingMedia(input, stream, Math.max(options.startTime, at.row.start), options.duration);
    }

    /** Best effort: where the stream started (the NVR does not report playback progress). */
    async getRecordingStreamCurrentTime(recordingStream: MediaObject): Promise<number> {
        const ff = await sdk.mediaManager.convertMediaObjectToJSON<FFmpegInput>(recordingStream, ScryptedMimeTypes.FFmpegInput);
        const t = Number((ff?.mediaStreamOptions as any)?.metadata?.recordingStartTime);
        if (!Number.isFinite(t)) throw new Error('not a recording stream of this camera');
        return t;
    }

    async getRecordingStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        const enc = this.nvr.channelCache(this.channel)?.enc;
        const dim = (s?: { width?: number; height?: number }) => s?.width && s?.height ? { width: s.width, height: s.height } : {};
        return [
            { id: 'main', name: 'Main Stream (recording)', container: 'flv', video: dim(enc?.mainStream), tool: 'ffmpeg' } as ResponseMediaStreamOptions,
            { id: 'sub', name: 'Substream (recording)', container: 'flv', video: dim(enc?.subStream), tool: 'ffmpeg' } as ResponseMediaStreamOptions,
        ];
    }

    async getRecordingStreamThumbnail(time: number, _options?: RecordingStreamThumbnailOptions): Promise<MediaObject> {
        const r = this.recorder();
        // 10 s buckets: a timeline asking every second shares one decode per bucket
        const t = Math.floor(time / THUMBNAIL_BUCKET_MS) * THUMBNAIL_BUCKET_MS;
        const jpeg = await r.thumbnail(`${this.channel}|at|${t}`, async () => {
            const at = await r.recordingAt(this.channel, 'sub', t);
            return r.input(this.channel, at.row, at.seek, undefined, { thumbnail: true, verified: true });
        });
        return sdk.mediaManager.createMediaObject(jpeg, 'image/jpeg');
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
            else if (nativeId === nightModeNativeId(this.nativeId!)) d = new ReolinkNightMode(nativeId);
            else if (nativeId === rawMotionNativeId(this.nativeId!)) d = new ReolinkRawMotion(nativeId);
            else if (nativeId.startsWith(`${this.nativeId}-raw-`)) d = new ReolinkRawClass(nativeId);
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
        clearTimeout(this.settingsTimer);
        this.settingsListener?.removeListener();
        this.settingsListener = undefined;
    }
}

/** The camera's raw motion level from each push, exact: the camera's own MotionSensor holds and filters it. */
export class ReolinkRawMotion extends ScryptedDeviceBase implements MotionSensor {
    constructor(nativeId: string) { super(nativeId); }
}

/** One AI class of the camera, its raw level from each push (Camera person, Camera vehicle...); unknown while disconnected. */
export class ReolinkRawClass extends ScryptedDeviceBase implements OccupancySensor {
    constructor(nativeId: string) { super(nativeId); }
}

/** On while the camera is in night mode (IR, black and white); unknown until the NVR has said. */
export class ReolinkNightMode extends ScryptedDeviceBase implements BinarySensor {
    constructor(nativeId: string) { super(nativeId); }
}

/**
 * Siren and floodlight switch over the NVR's Baichuan session (as reolink_aio does): the HTTP AudioAlarmPlay and
 * SetWhiteLed are refused by NVR channels (rspCode -26).
 */
export class ReolinkSiren extends ScryptedDeviceBase implements OnOff {
    constructor(nativeId: string, readonly camera: ReolinkChannelCamera) { super(nativeId); }
    async turnOn() {
        const push = this.camera.nvr.pushClient(), ch = this.camera.channel;
        // some firmware refuses a manual play: two timed plays instead, as reolink_aio falls back
        await push.channelCommand(Cmd.AudioAlarmPlay, ch, sirenXml(ch, true))
            .catch(() => push.channelCommand(Cmd.AudioAlarmPlay, ch, sirenXml(ch, true, 2)));
        this.on = true;
    }
    async turnOff() {
        const ch = this.camera.channel;
        await this.camera.nvr.pushClient().channelCommand(Cmd.AudioAlarmPlay, ch, sirenXml(ch, false));
        this.on = false;
    }
}

export class ReolinkFloodlight extends ScryptedDeviceBase implements OnOff {
    constructor(nativeId: string, readonly camera: ReolinkChannelCamera) { super(nativeId); }
    /** A manual switch lights for at most FLOODLIGHT_ON_S: while it should stay on, it is switched on again before that. */
    private keepOn?: NodeJS.Timeout;

    private send(on: boolean) {
        const ch = this.camera.channel;
        return this.camera.nvr.pushClient().channelCommand(Cmd.FloodlightManual, ch, floodlightXml(ch, on, FLOODLIGHT_ON_S));
    }

    async turnOn() {
        await this.send(true);
        this.on = true;
        clearInterval(this.keepOn);
        this.keepOn = setInterval(() => this.send(true).catch(e => this.console.warn(`floodlight keep-on: ${(e as Error).message}`)), FLOODLIGHT_REFRESH_MS);
    }

    async turnOff() {
        clearInterval(this.keepOn);
        this.keepOn = undefined;
        await this.send(false);
        this.on = false;
    }

    /**
     * The state the NVR pushes (cmd 291). Off while we keep it on means something else switched it off (the NVR,
     * the app, a rule): stop keeping it on, or the next refresh would light it again behind everyone's back.
     */
    reported(on: boolean) {
        if (!on) {
            clearInterval(this.keepOn);
            this.keepOn = undefined;
        }
        if (this.on !== on) this.on = on;
    }
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
/** Duration of a manual floodlight switch, and how often a light that should stay on is switched on again. */
const FLOODLIGHT_ON_S = 180;
const FLOODLIGHT_REFRESH_MS = 150_000;

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

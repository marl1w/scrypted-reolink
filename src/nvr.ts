import sdk, { DeviceProvider, Online, ScryptedDeviceBase, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { randomBytes } from 'node:crypto';
import { BaichuanClient } from './baichuan/client';
import { Cmd } from './baichuan/constants';
import { formatEvent, parseFloodlightStatus, parseSirenStatus, PushEvent } from './baichuan/events';
import { parseDayNightState, parseMac, parseRecordEnable, parseSmartAiSupport, parseUid, parseVersionInfo, smartAiClasses } from './baichuan/info';
import { Frame } from './baichuan/frame';
import { ReolinkChannelCamera } from './camera';
import { buildCameraDevice, buildChildDevices, buildCropDevices, buildMirrorDevices, cameraNativeId, cameraSerialNumber, ChannelCache, channelCacheFrom, distinctSerials, formatHealth, NvrIds, parseCameraNativeId, parseCrops, parseMirrors, realId } from './devices';
import { discoveredChannels, NvrApi, supportedAiClasses } from './http/nvr-api';
import { HttpSession } from './http/session';
import { NvrRecordings } from './recorder';
import { NvrOutageWatch } from './rebroadcast-watchdog';
import { parseSubstreamProtocol, SUBSTREAM_PROTOCOLS, SubstreamProtocol } from './streams';

const CACHE_PREFIX = 'chcache:';
/** After an outage, one camera's Rebroadcast is restarted every this long, not all at once. */
const RESTART_STAGGER_MS = 3000;
const NVR_IDS = 'nvrIds';
/** Smart AI support bits per channel (Baichuan cmd 199 `smartAI`), JSON `{ "<channel>": bits }`. */
const SMART_AI = 'smartAi';
/** This install's key for signing clip ids (hex), created once. */
const CLIP_KEY = 'clipKey';

/**
 * One Reolink NVR: exactly one Baichuan push connection and at most one HTTP API session,
 * shared by every channel camera, snapshot, siren and floodlight below it.
 */
export class ReolinkNvr extends ScryptedDeviceBase implements DeviceProvider, Settings, Online {
    storageSettings = new StorageSettings(this, {
        host: { title: 'Host', placeholder: '192.0.2.10', onPut: () => this.restart() },
        username: { title: 'Username', onPut: () => this.restart() },
        password: { title: 'Password', type: 'password', onPut: () => this.restart() },
        httpPort: { title: 'HTTP Port', type: 'number', defaultValue: 80, subgroup: 'Advanced', onPut: () => this.restart() },
        baichuanPort: { title: 'Baichuan Port', type: 'number', defaultValue: 9000, subgroup: 'Advanced', onPut: () => this.restart() },
        rtspPort: { title: 'RTSP Port', type: 'number', defaultValue: 554, subgroup: 'Advanced' },
        rtmpPort: { title: 'RTMP Port', type: 'number', defaultValue: 1935, subgroup: 'Advanced' },
        substreamProtocol: {
            title: 'Substream Protocol',
            description: 'The substream the cameras read through Rebroadcast (keyframe cache, View, crops) when Rebroadcast prebuffers neither or both of RTSP h264Preview_NN_sub and RTMP sub.bcs; otherwise they follow the one it prebuffers. RTMP has evenly timed audio; the NVR\'s RTSP stamps audio frames with their send time, which stutters wherever the audio is re-timed or transcoded.',
            choices: [...SUBSTREAM_PROTOCOLS],
            defaultValue: 'RTSP',
            subgroup: 'Advanced',
            onPut: () => this.followSubstreams(),
        },
        channels: {
            title: 'Channels',
            description: 'Channel numbers (0-based) to expose as cameras. Filled by discovery; add numbers by hand if a channel is missing.',
            multiple: true,
            combobox: true,
            defaultValue: [],
            onPut: () => this.syncDevices(),
        },
        discover: {
            title: 'Discover Channels',
            type: 'button',
            onPut: () => this.discover(),
        },
        logEvents: { title: 'Log Push Events', type: 'boolean', subgroup: 'Advanced' },
        playbackSlots: {
            title: 'Recording Playback Streams',
            description: 'Recording streams and thumbnails this plugin opens on the NVR at once. Set it to what the NVR allows minus what other consumers (the Reolink app, Home Assistant, Stamina) play back at the same time.',
            type: 'number',
            defaultValue: 3,
            subgroup: 'Advanced',
        },
    });

    session?: HttpSession;
    private _api?: NvrApi;
    /** Recordings search and playback, on the shared HTTP session and Baichuan connection. */
    recordings?: NvrRecordings;
    /** Night mode and recording state per channel as last read, for cameras created after the read. */
    readonly channelStates = new Map<number, { dayNight?: string; recording?: boolean }>();
    private statesRead?: Promise<void>;
    /** Smart AI support bits per channel, parsed once from storage and updated by readStates. */
    private smart?: Record<string, number>;
    /** Native ids announced to Scrypted: no state is written to a child before it exists. */
    private announced = new Set<string>();
    push?: BaichuanClient;
    /** Restarts every camera's Rebroadcast once the NVR is back after an outage (see rebroadcast-watchdog.ts). */
    private outageWatch?: NvrOutageWatch;
    /** Staggered Rebroadcast restarts still to run after an outage. */
    private restartTimers: NodeJS.Timeout[] = [];
    private cameras = new Map<string, ReolinkChannelCamera>();
    private lastEventAt?: number;
    private identity?: Promise<boolean>;
    private identityRead = false;

    constructor(nativeId: string) {
        super(nativeId);
        this.start();
    }

    get host() { return String(this.storageSettings.values.host || ''); }
    get username() { return String(this.storageSettings.values.username || ''); }
    get password() { return String(this.storageSettings.values.password || ''); }
    get rtspPort() { return Number(this.storageSettings.values.rtspPort) || 554; }
    get rtmpPort() { return Number(this.storageSettings.values.rtmpPort) || 1935; }
    get playbackSlots() { return Math.max(1, Math.min(16, Math.floor(Number(this.storageSettings.values.playbackSlots) || 3))); }
    get substreamProtocol(): SubstreamProtocol { return parseSubstreamProtocol(this.storageSettings.values.substreamProtocol); }

    get api(): NvrApi {
        if (!this._api) throw new Error('NVR not configured');
        return this._api;
    }

    private start() {
        if (!this.host || !this.username) {
            this.online = false;
            return;
        }
        this.session = new HttpSession({ host: this.host, port: Number(this.storageSettings.values.httpPort) || 80, username: this.username, password: this.password });
        this._api = new NvrApi(this.session);
        const session = this.session;
        this.recordings = new NvrRecordings({
            api: () => this.api,
            token: min => session.getToken(min),
            slots: () => this.playbackSlots,
            target: () => ({ host: this.host, port: Number(this.storageSettings.values.httpPort) || 80, rtmpPort: this.rtmpPort, username: this.username, password: this.password }),
            baichuan: () => this.push?.state === 'subscribed' ? this.push : undefined,
            uid: ch => this.channelCache(ch)?.uid,
            clipKey: () => this.clipKey(),
            ffmpegPath: () => sdk.mediaManager.getFFmpegPath(),
            log: m => this.console.log(m),
        });
        const push = new BaichuanClient({ host: this.host, port: Number(this.storageSettings.values.baichuanPort) || 9000, username: this.username, password: this.password });
        this.push = push;
        const outage = new NvrOutageWatch(ms => {
            this.console.log(`NVR back after ${Math.round(ms / 1000)} s: restarting the cameras' Rebroadcast sessions, one every ${RESTART_STAGGER_MS / 1000} s`);
            [...this.cameras.values()].forEach((c, i) => {
                const t = setTimeout(() => {
                    this.restartTimers = this.restartTimers.filter(x => x !== t);
                    c.restartRebroadcast('the NVR is back after an outage');
                }, i * RESTART_STAGGER_MS);
                this.restartTimers.push(t);
            });
        });
        this.outageWatch = outage;
        push.on('state', s => {
            this.console.log(`push ${s}`);
            this.online = s === 'subscribed';
            outage.state(s === 'subscribed');
            if (s !== 'subscribed') for (const c of this.cameras.values()) c.motion.reset();
            else for (const c of this.cameras.values()) c.rawSubscribed();
            this.updateCameraOnline();
            // once per start: serials only change when a camera is replaced, and Discover reads them again
            if (s === 'subscribed' && !this.identityRead) {
                this.identityRead = true;
                // once per start, changed or not: an update may add interfaces or children to existing devices
                this.refreshIdentity().catch(e => this.console.warn(`serial numbers: ${(e as Error).message}`))
                    .then(() => this.storageSettings.values.channels?.length ? this.syncDevices() : undefined)
                    .catch(e => this.console.warn(`devices: ${(e as Error).message}`))
                    .then(() => this.readChannelStates());
            }
            else if (s === 'subscribed') {
                void this.readChannelStates();
            }
        });
        push.on('warn', e => this.console.warn(`push: ${e.message}`));
        push.on('login', d => this.console.log(`push login ok, ${d.channelNum ?? '?'} channels`));
        push.on('event', ev => this.onPush(ev));
        push.on('push', (f: Frame, xml: string) => {
            const camera = (ch: number) => this.cameras.get(cameraNativeId(this.nativeId!, ch));
            if (f.cmd === Cmd.FloodlightStatus) {
                try {
                    for (const s of parseFloodlightStatus(xml)) camera(s.channel)?.floodlightState(s.on);
                }
                catch (e) {
                    this.console.warn(`floodlight status: ${(e as Error).message}`);
                }
            }
            else if (f.cmd === Cmd.SirenStatus) {
                try {
                    for (const s of parseSirenStatus(xml)) camera(s.channel)?.sirenState(s.on);
                }
                catch (e) {
                    this.console.warn(`siren status: ${(e as Error).message}`);
                }
            }
        });
        push.start();
        if (!this.storageSettings.values.channels?.length)
            this.discover().catch(e => this.console.warn(`discovery failed: ${e.message}`));
    }

    async stop() {
        const p = this.push, s = this.session;
        this.outageWatch?.dispose();
        this.outageWatch = undefined;
        for (const t of this.restartTimers) clearTimeout(t);
        this.restartTimers = [];
        this.push = undefined;
        this.session = undefined;
        this._api = undefined;
        this.recordings = undefined;
        this.identityRead = false;
        await Promise.all([p?.stop(), s?.stop()]);
    }

    async restart() {
        await this.stop();
        this.start();
    }

    private onPush(ev: PushEvent) {
        this.lastEventAt = Date.now();
        if (this.storageSettings.values.logEvents) this.console.log(formatEvent(ev));
        if (ev.kind === 'daynight' && ev.dayNight) this.channelStates.set(ev.channel, { ...this.channelStates.get(ev.channel), dayNight: ev.dayNight });
        this.cameras.get(cameraNativeId(this.nativeId!, ev.channel))?.onPush(ev);
    }

    /** The live Baichuan session, for commands; throws while there is none. */
    pushClient(): BaichuanClient {
        if (!this.push) throw new Error('NVR not configured');
        return this.push;
    }

    channelCache(channel: number): ChannelCache | undefined {
        try {
            const raw = this.storage.getItem(CACHE_PREFIX + channel);
            return raw ? JSON.parse(raw) : undefined;
        }
        catch { return undefined; }
    }

    private setChannelCache(c: ChannelCache) {
        this.storage.setItem(CACHE_PREFIX + c.channel, JSON.stringify(c));
    }

    private nvrIds(): NvrIds {
        try { return JSON.parse(this.storage.getItem(NVR_IDS) || '{}'); }
        catch { return {}; }
    }

    /** The NVR's UID and MAC and each camera's own serial, over Baichuan (no HTTP login), into the shown serials. */
    refreshIdentity(): Promise<boolean> {
        this.identity ??= this.readIdentity().finally(() => { this.identity = undefined; });
        return this.identity;
    }

    private async readIdentity(): Promise<boolean> {
        const push = this.pushClient();
        const read = (cmd: number, channel?: number) => push.query(cmd, channel).catch(() => '');
        const ids = this.nvrIds();
        ids.uid = realId(parseUid(await read(Cmd.Uid))) ?? ids.uid;
        ids.mac = realId(parseMac(await read(Cmd.LocalLink))) ?? ids.mac;
        this.storage.setItem(NVR_IDS, JSON.stringify(ids));
        const chans: number[] = (this.storageSettings.values.channels ?? []).map((x: any) => parseInt(String(x), 10)).filter((n: number) => !isNaN(n));
        const seen = new Map<number, string | undefined>();
        // an offline camera does not answer: it keeps the serial it reported last
        for (const ch of chans)
            seen.set(ch, realId(parseVersionInfo(await read(Cmd.VersionInfo, ch)).serialNumber) ?? this.channelCache(ch)?.cameraSerial);
        const serials = distinctSerials(seen);
        let changed = false;
        for (const ch of chans) {
            const cache = this.channelCache(ch);
            if (!cache) continue;
            // caches from 0.1.16 have no uid: their serial is the UID unless it is the "<NVR serial>-<n>" fallback
            const uid = cache.uid ?? (cache.serialNumber?.includes('-') ? '' : cache.serialNumber ?? '');
            const serialNumber = cameraSerialNumber(ch, { uid, cameraSerial: serials.get(ch), model: cache.model }, ids);
            changed ||= serialNumber !== cache.serialNumber;
            this.setChannelCache({ ...cache, uid, cameraSerial: serials.get(ch), serialNumber });
        }
        return changed;
    }

    /**
     * Read once per Baichuan session, all read-only: smart AI support (cmd 199), then per channel the day/night state
     * (cmd 296, so Night mode is known before the first switch) and whether it records (cmd 81). No HTTP login.
     */
    readChannelStates(): Promise<void> {
        this.statesRead ??= this.readStates().finally(() => { this.statesRead = undefined; });
        return this.statesRead;
    }

    private async readStates() {
        const push = this.push;
        if (!push || push.state !== 'subscribed') return;
        const smart = parseSmartAiSupport(await push.query(Cmd.Support).catch(() => ''));
        if (smart.size) {
            const before = this.storage.getItem(SMART_AI);
            const now = JSON.stringify(Object.fromEntries(smart));
            if (before !== now) {
                this.storage.setItem(SMART_AI, now);
                this.smart = Object.fromEntries(smart);
                const supported = [...smart].filter(([, b]) => smartAiClasses(b).length).map(([ch, b]) => `ch${ch} ${smartAiClasses(b).join(',')}`);
                this.console.log(`smart events: ${supported.join('; ') || 'none supported'}`);
            }
        }
        const chans: number[] = (this.storageSettings.values.channels ?? []).map((x: any) => parseInt(String(x), 10)).filter((n: number) => !isNaN(n));
        for (const ch of chans) {
            if (this.push !== push || push.state !== 'subscribed') return;
            if (this.channelCache(ch)?.online === false) continue;
            const dayNight = parseDayNightState(await push.query(Cmd.DayNight, ch).catch(() => ''));
            const recording = parseRecordEnable(await push.query(Cmd.Record, ch).catch(() => ''));
            const st = this.channelStates.get(ch) ?? {};
            if (dayNight !== undefined) st.dayNight = dayNight;
            if (recording !== undefined) st.recording = recording;
            this.channelStates.set(ch, st);
            const cam = this.cameras.get(cameraNativeId(this.nativeId!, ch));
            if (dayNight !== undefined) cam?.nightModeState(dayNight);
            if (recording !== undefined) cam?.recordingState(recording);
        }
    }

    /** Smart events a channel supports, from its cmd 199 `smartAI` bits. */
    smartEvents(channel: number): string[] {
        if (!this.smart) {
            try { this.smart = JSON.parse(this.storage.getItem(SMART_AI) || '{}'); }
            catch { this.smart = {}; }
        }
        return smartAiClasses(this.smart![channel]);
    }

    /** This install's key for signing clip ids and media links. */
    clipKey(): Buffer {
        let k = this.storage.getItem(CLIP_KEY);
        if (!k || !/^[0-9a-f]{64}$/.test(k)) {
            k = randomBytes(32).toString('hex');
            this.storage.setItem(CLIP_KEY, k);
        }
        return Buffer.from(k, 'hex');
    }

    /** Whether a native id has been announced to Scrypted (by this run's syncDevices, or a previous run). */
    isAnnounced(nativeId: string): boolean {
        if (!this.announced.size) for (const id of sdk.deviceManager.getNativeIds()) if (id) this.announced.add(id);
        return this.announced.has(nativeId);
    }

    snapshot(channel: number, timeoutMs?: number) {
        if (!this.session) throw new Error('NVR not configured');
        return this.session.snapshot(channel, timeoutMs);
    }

    /** GetDevInfo + GetChannelstatus + GetAbility, then one batched request per channel. All on the shared session. */
    async discover() {
        const api = this.api;
        const [dev, status, ability] = [await api.devInfo(), await api.channelStatus(), await api.ability().catch(() => undefined)];
        const found = discoveredChannels(status);
        const manual: number[] = (this.storageSettings.values.channels ?? []).map((x: any) => parseInt(String(x), 10)).filter((n: number) => !isNaN(n));
        const all = [...new Set([...found.map(s => s.channel), ...manual])].sort((a, b) => a - b);
        const nvrIds = { ...this.nvrIds(), serial: dev.serial };
        this.storage.setItem(NVR_IDS, JSON.stringify(nvrIds));
        for (const ch of all) {
            try {
                const d = await api.channelDetails(ch);
                const cameraSerial = this.channelCache(ch)?.cameraSerial;
                this.setChannelCache(channelCacheFrom(ch, dev, status.find(s => s.channel === ch), { ...d, cameraSerial, nvrIds }, ability, supportedAiClasses(d.ai)));
            }
            catch (e) {
                this.console.warn(`channel ${ch} details failed: ${(e as Error).message}`);
            }
        }
        this.console.log(`discovered channels: ${all.join(', ') || 'none'}`);
        for (const c of this.cameras.values()) c.rawRediscovered();
        this.storageSettings.values.channels = all.map(String);
        if (this.push?.state === 'subscribed')
            await this.refreshIdentity().catch(e => this.console.warn(`serial numbers: ${(e as Error).message}`));
        await this.syncDevices();
    }

    async syncDevices() {
        const chans: number[] = (this.storageSettings.values.channels ?? []).map((x: any) => parseInt(String(x), 10)).filter((n: number) => !isNaN(n));
        const devices = chans.map(ch => buildCameraDevice(this.nativeId!, this.channelCache(ch) ?? { channel: ch }, this.providedName || this.name));
        await sdk.deviceManager.onDevicesChanged({ providerNativeId: this.nativeId, devices: devices as any });
        for (const ch of chans) {
            const cache = this.channelCache(ch) ?? { channel: ch };
            const camId = cameraNativeId(this.nativeId!, ch);
            const name = devices.find(d => d.nativeId === camId)!.name;
            const storage = sdk.deviceManager.getDeviceStorage(camId);
            const crops = parseCrops(JSON.parse(storage?.getItem('crops') || '[]'));
            const mirrors = buildMirrorDevices(camId, parseMirrors(JSON.parse(storage?.getItem('mirrors') || '[]'), crops), cache.serialNumber);
            this.isAnnounced(camId);
            const children = [...buildChildDevices(camId, name, cache, [...this.announced]), ...buildCropDevices(camId, crops, cache.serialNumber), ...mirrors.mirrors];
            // always sent, even when only the fixed children are left: removed crops and mirrors go with it
            await sdk.deviceManager.onDevicesChanged({ providerNativeId: camId, devices: children as any });
            for (const m of mirrors.mirrors)
                await sdk.deviceManager.onDevicesChanged({ providerNativeId: m.nativeId, devices: mirrors.children.filter(c => c.providerNativeId === m.nativeId) as any });
            for (const a of [...this.announced]) if (a.startsWith(`${camId}-`)) this.announced.delete(a);
            for (const d of [{ nativeId: camId }, ...children, ...mirrors.children]) this.announced.add(d.nativeId);
        }
        this.updateCameraOnline();
        // children announced only now get the states known so far
        for (const c of this.cameras.values()) c.applyChildStates();
    }

    /** The Substream Protocol changed: running keyframe caches read the substream again. */
    private followSubstreams() {
        for (const c of this.cameras.values())
            c.followSubstream(true).catch(e => c.console.warn(`substream: ${(e as Error).message}`));
    }

    private updateCameraOnline() {
        for (const c of this.cameras.values())
            c.online = this.push?.state === 'subscribed' && this.channelCache(c.channel)?.online !== false;
    }

    async getDevice(nativeId: string): Promise<any> {
        let cam = this.cameras.get(nativeId);
        if (!cam) {
            const p = parseCameraNativeId(nativeId);
            if (!p) return undefined;
            cam = new ReolinkChannelCamera(nativeId, this, p.channel);
            this.cameras.set(nativeId, cam);
            this.updateCameraOnline();
        }
        return cam;
    }

    async releaseDevice(_id: string, nativeId: string): Promise<void> {
        this.cameras.get(nativeId)?.dispose();
        this.cameras.delete(nativeId);
    }

    async getSettings(): Promise<Setting[]> {
        const health = formatHealth({
            pushState: this.push?.state ?? 'not configured',
            channels: (this.storageSettings.values.channels ?? []).length,
            lastEventAt: this.lastEventAt,
            httpSessions: this.session?.sessionsInUse ?? 0,
            reconnects: this.push?.stats.reconnects ?? 0,
            lastError: this.push?.stats.lastError ?? this.session?.lastError,
        });
        return [
            { key: 'health', title: 'Health', readonly: true, value: health },
            ...await this.storageSettings.getSettings(),
        ];
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        await this.storageSettings.putSetting(key, value);
    }
}

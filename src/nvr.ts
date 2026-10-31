import sdk, { DeviceProvider, Online, ScryptedDeviceBase, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { BaichuanClient } from './baichuan/client';
import { Cmd } from './baichuan/constants';
import { formatEvent, parseFloodlightStatus, parseSirenStatus, PushEvent } from './baichuan/events';
import { parseMac, parseUid, parseVersionInfo } from './baichuan/info';
import { Frame } from './baichuan/frame';
import { ReolinkChannelCamera } from './camera';
import { buildCameraDevice, buildChildDevices, buildCropDevices, buildMirrorDevices, cameraNativeId, cameraSerialNumber, ChannelCache, channelCacheFrom, distinctSerials, formatHealth, NvrIds, parseCameraNativeId, parseCrops, parseMirrors, realId } from './devices';
import { discoveredChannels, NvrApi, supportedAiClasses } from './http/nvr-api';
import { HttpSession } from './http/session';
import { parseSubstreamProtocol, SUBSTREAM_PROTOCOLS, SubstreamProtocol } from './streams';

const CACHE_PREFIX = 'chcache:';
const NVR_IDS = 'nvrIds';

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
    });

    session?: HttpSession;
    private _api?: NvrApi;
    push?: BaichuanClient;
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
        const push = new BaichuanClient({ host: this.host, port: Number(this.storageSettings.values.baichuanPort) || 9000, username: this.username, password: this.password });
        this.push = push;
        push.on('state', s => {
            this.console.log(`push ${s}`);
            this.online = s === 'subscribed';
            if (s !== 'subscribed') for (const c of this.cameras.values()) c.motion.reset();
            else for (const c of this.cameras.values()) c.rawSubscribed();
            this.updateCameraOnline();
            // once per start: serials only change when a camera is replaced, and Discover reads them again
            if (s === 'subscribed' && !this.identityRead) {
                this.identityRead = true;
                this.refreshIdentity().then(changed => { if (changed) return this.syncDevices(); })
                    .catch(e => this.console.warn(`serial numbers: ${(e as Error).message}`));
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
        this.push = undefined;
        this.session = undefined;
        this._api = undefined;
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
            const children = [...buildChildDevices(camId, name, cache), ...buildCropDevices(camId, crops, cache.serialNumber), ...mirrors.mirrors];
            if (children.length)
                await sdk.deviceManager.onDevicesChanged({ providerNativeId: camId, devices: children as any });
            for (const m of mirrors.mirrors)
                await sdk.deviceManager.onDevicesChanged({ providerNativeId: m.nativeId, devices: mirrors.children.filter(c => c.providerNativeId === m.nativeId) as any });
        }
        this.updateCameraOnline();
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

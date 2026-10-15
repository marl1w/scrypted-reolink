import sdk, { DeviceProvider, Online, ScryptedDeviceBase, Setting, Settings, SettingValue } from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { BaichuanClient } from './baichuan/client';
import { formatEvent, PushEvent } from './baichuan/events';
import { ReolinkChannelCamera } from './camera';
import { buildCameraDevice, buildChildDevices, buildCropDevices, buildMirrorDevices, cameraNativeId, ChannelCache, channelCacheFrom, formatHealth, parseCameraNativeId, parseCrops, parseMirrors } from './devices';
import { discoveredChannels, NvrApi, supportedAiClasses } from './http/nvr-api';
import { HttpSession } from './http/session';

const CACHE_PREFIX = 'chcache:';

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

    constructor(nativeId: string) {
        super(nativeId);
        this.start();
    }

    get host() { return String(this.storageSettings.values.host || ''); }
    get username() { return String(this.storageSettings.values.username || ''); }
    get password() { return String(this.storageSettings.values.password || ''); }
    get rtspPort() { return Number(this.storageSettings.values.rtspPort) || 554; }
    get rtmpPort() { return Number(this.storageSettings.values.rtmpPort) || 1935; }

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
            this.updateCameraOnline();
        });
        push.on('warn', e => this.console.warn(`push: ${e.message}`));
        push.on('login', d => this.console.log(`push login ok, ${d.channelNum ?? '?'} channels`));
        push.on('event', ev => this.onPush(ev));
        push.start();
        if (!this.storageSettings.values.channels?.length)
            this.discover().catch(e => this.console.warn(`discovery failed: ${e.message}`));
    }

    async stop() {
        const p = this.push, s = this.session;
        this.push = undefined;
        this.session = undefined;
        this._api = undefined;
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
        for (const ch of all) {
            try {
                const d = await api.channelDetails(ch);
                this.setChannelCache(channelCacheFrom(ch, dev, status.find(s => s.channel === ch), d, ability, supportedAiClasses(d.ai)));
            }
            catch (e) {
                this.console.warn(`channel ${ch} details failed: ${(e as Error).message}`);
            }
        }
        this.console.log(`discovered channels: ${all.join(', ') || 'none'}`);
        this.storageSettings.values.channels = all.map(String);
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
            const mirrors = buildMirrorDevices(camId, parseMirrors(JSON.parse(storage?.getItem('mirrors') || '[]'), crops));
            const children = [...buildChildDevices(camId, name, cache), ...buildCropDevices(camId, crops), ...mirrors.mirrors];
            if (children.length)
                await sdk.deviceManager.onDevicesChanged({ providerNativeId: camId, devices: children as any });
            for (const m of mirrors.mirrors)
                await sdk.deviceManager.onDevicesChanged({ providerNativeId: m.nativeId, devices: mirrors.children.filter(c => c.providerNativeId === m.nativeId) as any });
        }
        this.updateCameraOnline();
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

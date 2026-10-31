import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceProvider, HttpRequest, HttpRequestHandler, HttpResponse, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting } from '@scrypted/sdk';
import { randomBytes } from 'node:crypto';
import packageJson from '../package.json';
import { handleMediaRequest } from './media-http';
import { reolinkMqtt } from './mqtt';
import { ReolinkNvr } from './nvr';

class ReolinkBaichuanPlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator, HttpRequestHandler {
    private nvrs = new Map<string, ReolinkNvr>();

    constructor(nativeId?: string) {
        super(nativeId);
        this.console.log(`Reolink (Baichuan) ${packageJson.version} loaded`);
        reolinkMqtt.start();
        const shutdown = () => { for (const n of this.nvrs.values()) void n.stop(); };
        process.once('SIGTERM', shutdown);
        process.once('beforeExit', shutdown);
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            { key: 'name', title: 'Name', placeholder: 'NVR' },
            { key: 'host', title: 'Host', placeholder: '192.0.2.10' },
            { key: 'username', title: 'Username' },
            { key: 'password', title: 'Password', type: 'password' },
        ];
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const nativeId = `nvr-${randomBytes(4).toString('hex')}`;
        // Device storage exists only once the device is discovered, so store the settings afterwards.
        await sdk.deviceManager.onDeviceDiscovered({
            nativeId,
            name: String(settings.name || 'Reolink NVR'),
            type: ScryptedDeviceType.API,
            interfaces: [ScryptedInterface.DeviceProvider, ScryptedInterface.Settings, ScryptedInterface.Online],
        });
        const nvr = await this.getDevice(nativeId) as ReolinkNvr;
        for (const k of ['host', 'username', 'password'])
            if (settings[k] !== undefined) nvr.storage.setItem(k, String(settings[k]));
        await nvr.restart();
        return nativeId;
    }

    async getDevice(nativeId: string): Promise<any> {
        let n = this.nvrs.get(nativeId);
        if (!n && nativeId.startsWith('nvr-')) {
            n = new ReolinkNvr(nativeId);
            this.nvrs.set(nativeId, n);
        }
        return n;
    }

    /** Clips and clip thumbnails behind signed links (see media-http.ts). */
    async onRequest(request: HttpRequest, response: HttpResponse): Promise<void> {
        const handled = await handleMediaRequest(request, response, id => this.nvrs.get(id));
        if (!handled) response.send('not found', { code: 404 });
    }

    async releaseDevice(_id: string, nativeId: string): Promise<void> {
        const n = this.nvrs.get(nativeId);
        this.nvrs.delete(nativeId);
        await n?.stop();
    }
}

export default ReolinkBaichuanPlugin;

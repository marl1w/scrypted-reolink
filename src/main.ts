import sdk, { DeviceCreator, DeviceCreatorSettings, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting } from '@scrypted/sdk';
import { randomBytes } from 'node:crypto';
import packageJson from '../package.json';
import { ReolinkNvr } from './nvr';

class ReolinkBaichuanPlugin extends ScryptedDeviceBase implements DeviceProvider, DeviceCreator {
    private nvrs = new Map<string, ReolinkNvr>();

    constructor(nativeId?: string) {
        super(nativeId);
        this.console.log(`Reolink (Baichuan) ${packageJson.version} loaded`);
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
        const storage = sdk.deviceManager.getDeviceStorage(nativeId);
        for (const k of ['host', 'username', 'password'])
            if (settings[k] !== undefined) storage.setItem(k, String(settings[k]));
        await sdk.deviceManager.onDeviceDiscovered({
            nativeId,
            name: String(settings.name || 'Reolink NVR'),
            type: ScryptedDeviceType.API,
            interfaces: [ScryptedInterface.DeviceProvider, ScryptedInterface.Settings, ScryptedInterface.Online],
        });
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

    async releaseDevice(_id: string, nativeId: string): Promise<void> {
        const n = this.nvrs.get(nativeId);
        this.nvrs.delete(nativeId);
        await n?.stop();
    }
}

export default ReolinkBaichuanPlugin;

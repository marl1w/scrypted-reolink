import { ApiResult, HttpSession } from './session';

// Typed wrappers over the NVR JSON API, all through the one shared HttpSession.

export interface DevInfo {
    model?: string;
    exactType?: string;
    type?: string;
    firmVer?: string;
    hardVer?: string;
    serial?: string;
    name?: string;
    channelNum?: number;
    pakSuffix?: string;
    [k: string]: unknown;
}

export interface ChannelStatus {
    channel: number;
    name?: string;
    online?: number;
    typeInfo?: string;
    uid?: string;
    sleep?: number;
}

export interface ChnTypeInfo {
    typeInfo?: string;
    firmVer?: string;
    pakSuffix?: string;
}

export interface EncStream {
    width?: number;
    height?: number;
    vType?: string;
    frameRate?: number;
    bitRate?: number;
}

export interface Enc {
    channel?: number;
    mainStream?: EncStream;
    subStream?: EncStream;
}

/** The `Ability` object: `{ abilityChn: [...], supportAudioAlarm?, ... }`. */
export type Ability = Record<string, any> & { abilityChn?: Record<string, any>[] };

export interface AiSupport { [cls: string]: { support?: number; alarm_state?: number } | number | undefined }

const find = (rs: ApiResult[], cmd: string) => rs.find(r => r?.cmd === cmd);

export class NvrApi {
    constructor(readonly session: HttpSession) { }

    async devInfo(): Promise<DevInfo> {
        return (await this.session.one({ cmd: 'GetDevInfo' }))?.DevInfo ?? {};
    }

    async channelStatus(): Promise<ChannelStatus[]> {
        return (await this.session.one({ cmd: 'GetChannelstatus' }))?.status ?? [];
    }

    async ability(): Promise<Ability> {
        return (await this.session.one({ cmd: 'GetAbility', param: { User: { userName: this.session.opts.username } } }))?.Ability ?? {};
    }

    /**
     * Everything needed to describe one channel, in one HTTP request:
     * GetChnTypeInfo, GetEnc and GetAiState (support flags only; never polled).
     */
    async channelDetails(channel: number): Promise<{ chnTypeInfo?: ChnTypeInfo; enc?: Enc; ai?: AiSupport }> {
        const rs = await this.session.call([
            { cmd: 'GetChnTypeInfo', param: { channel } },
            { cmd: 'GetEnc', action: 1, param: { channel } },
            { cmd: 'GetAiState', param: { channel } },
        ]);
        return {
            chnTypeInfo: find(rs, 'GetChnTypeInfo')?.value,
            enc: find(rs, 'GetEnc')?.value?.Enc,
            ai: find(rs, 'GetAiState')?.value,
        };
    }

    /** Same bodies as the stock plugin (AudioAlarmPlay, manual switch). */
    async setSiren(channel: number, on: boolean): Promise<void> {
        await this.session.one({ cmd: 'AudioAlarmPlay', param: { channel, alarm_mode: 'manul', manual_switch: on ? 1 : 0 } });
    }

    async setWhiteLed(channel: number, on?: boolean, brightness?: number): Promise<void> {
        const WhiteLed: Record<string, number> = { channel };
        if (on !== undefined) WhiteLed.state = on ? 1 : 0;
        if (brightness !== undefined) WhiteLed.bright = brightness;
        await this.session.one({ cmd: 'SetWhiteLed', param: { WhiteLed } });
    }
}

/** Channels the NVR reports as connected (stock: status entries with a uid). */
export function discoveredChannels(status: ChannelStatus[]): ChannelStatus[] {
    return status.filter(s => !!s.uid || s.online === 1).sort((a, b) => a.channel - b.channel);
}

/** AI classes the channel supports, from GetAiState (stock getObjectTypes logic). */
export function supportedAiClasses(ai?: AiSupport): string[] {
    if (!ai) return [];
    return Object.entries(ai)
        .filter(([k, v]) => k !== 'channel' && typeof v === 'object' && v && !!v.support)
        .map(([k]) => k);
}

export function hasSiren(ability: Ability | undefined, channel: number): boolean {
    const main = ability?.supportAudioAlarm;
    const chn = ability?.abilityChn?.[channel]?.supportAudioAlarm;
    return !!((main && main.ver !== 0) || (chn && chn.ver !== 0));
}

export function hasFloodlight(ability: Ability | undefined, channel: number): boolean {
    const c = ability?.abilityChn?.[channel];
    if (!c) return false;
    return (c.floodLight?.ver ?? 0) > 0 || (c.supportFLswitch?.ver ?? 0) > 0 || (c.supportFLBrightness?.ver ?? 0) > 0;
}

// VideoCamera stream options, ported 1:1 from the stock @scrypted/reolink plugin
// (ReolinkCamera.getConstructedVideoStreamOptions, version 0.0.112) so that Rebroadcast and HomeKit
// see the same stream ids, names, containers, codecs and resolutions for the same NVR channel.

import type { Ability, DevInfo, Enc } from './http/nvr-api';

export interface StreamOption {
    id: string;
    name: string;
    container: 'rtsp' | 'rtmp';
    video: { codec?: string; width?: number; height?: number };
    url: string;
}

export interface StreamInputs {
    /** 0-based NVR channel (stock rtspChannel). */
    channel: number;
    /** Stock passes the NVR GetDevInfo with model replaced by the channel's GetChnTypeInfo.typeInfo. */
    deviceInfo?: Pick<DevInfo, 'model' | 'exactType'>;
    ability?: Ability;
    enc?: Enc;
    host: string;
    rtspPort?: number;
    rtmpPort?: number;
}

const DUAL_LENS_MODELS = ['Reolink TrackMix PoE', 'Reolink TrackMix WiFi', 'RLC-81MA', 'Trackmix Series W760'];

export function buildStreamOptions(i: StreamInputs): StreamOption[] {
    const rtspChannel = i.channel;
    const channel = (rtspChannel + 1).toString().padStart(2, '0');
    const rtspAddress = `${i.host}:${i.rtspPort || 554}`;
    const rtmpAddress = `${i.host}:${i.rtmpPort || 1935}`;

    const rtmpMain: StreamOption = { name: '', id: 'main.bcs', container: 'rtmp', video: { width: 2560, height: 1920 }, url: '' };
    const rtmpExt: StreamOption = { name: '', id: 'ext.bcs', container: 'rtmp', video: { width: 896, height: 672 }, url: '' };
    const rtmpSub: StreamOption = { name: '', id: 'sub.bcs', container: 'rtmp', video: { width: 640, height: 480 }, url: '' };
    const rtspMain: StreamOption = { name: '', id: `h264Preview_${channel}_main`, container: 'rtsp', video: { codec: 'h264', width: 2560, height: 1920 }, url: '' };
    const rtspSub: StreamOption = { name: '', id: `h264Preview_${channel}_sub`, container: 'rtsp', video: { codec: 'h264', width: 640, height: 480 }, url: '' };

    const chn = i.ability?.abilityChn?.[rtspChannel];
    // abilityChn->live: 0 none, 1 main/extern/sub, 2 main/sub
    const live = chn?.live?.ver;
    // abilityChn->mainEncType: 0 H264, 1 H265
    const mainEncType = chn?.mainEncType?.ver;

    const streams: StreamOption[] = [];
    if (i.deviceInfo?.exactType === 'HOMEHUB')
        streams.push(rtspMain, rtspSub);
    else if (live === 2) {
        if (mainEncType === 1) streams.push(rtmpSub, rtspMain, rtspSub);
        else streams.push(rtmpMain, rtmpSub, rtspMain, rtspSub);
    }
    else if (mainEncType === 1)
        streams.push(rtmpExt, rtmpSub, rtspMain, rtspSub);
    else
        streams.push(rtmpMain, rtmpExt, rtmpSub, rtspMain, rtspSub);

    if (i.deviceInfo?.model && DUAL_LENS_MODELS.includes(i.deviceInfo.model)) {
        streams.push({ name: '', id: 'autotrack.bcs', container: 'rtmp', video: { width: 896, height: 512 }, url: '' });
        if (rtspChannel === 0) {
            streams.push(
                { name: '', id: 'h264Preview_02_main', container: 'rtsp', video: { codec: 'h264', width: 3840, height: 2160 }, url: '' },
                { name: '', id: 'h264Preview_02_sub', container: 'rtsp', video: { codec: 'h264', width: 640, height: 480 }, url: '' },
            );
        }
    }

    for (const s of streams) {
        if (s.container === 'rtmp') {
            const u = new URL(`rtmp://${rtmpAddress}/bcs/channel${rtspChannel}_${s.id}`);
            u.searchParams.set('channel', rtspChannel.toString());
            u.searchParams.set('stream', '0');
            s.url = u.toString();
            s.name = `RTMP ${s.id}`;
        }
        else {
            s.url = new URL(`rtsp://${rtspAddress}/${s.id}`).toString();
            s.name = `RTSP ${s.id}`;
        }
    }

    const mainStream = i.enc?.mainStream;
    if (mainStream?.width && mainStream?.height) {
        for (const s of streams) {
            if (s.id === 'main.bcs' || s.id === `h264Preview_${channel}_main`) {
                s.video.width = mainStream.width;
                s.video.height = mainStream.height;
            }
            if (mainStream.vType === 'h265' || mainStream.vType === 'hevc') {
                if (s.id === `h264Preview_${channel}_main`) {
                    s.video.codec = 'h265';
                    s.id = `h265Preview_${channel}_main`;
                    s.name = `RTSP ${s.id}`;
                    s.url = `rtsp://${rtspAddress}/${s.id}`;
                }
            }
        }
    }
    return streams;
}

/** Credentials as the stock plugin adds them when a stream is opened. */
export function addStreamCredentials(url: string, username: string, password: string): string {
    const u = new URL(url);
    if (u.protocol !== 'rtmp:') {
        u.username = username;
        u.password = password || '';
        return u.toString();
    }
    // Reolink's RTMP server compares raw query bytes: append without percent-encoding (stock #1509).
    return `${url}${url.includes('?') ? '&' : '?'}user=${username}&password=${password}`;
}

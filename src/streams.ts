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

export const SUBSTREAM_PROTOCOLS = ['RTSP', 'RTMP'] as const;
export type SubstreamProtocol = typeof SUBSTREAM_PROTOCOLS[number];

/** The stored Substream Protocol: RTMP only when set so, anything else (unset, unknown) is RTSP. */
export function parseSubstreamProtocol(v: unknown): SubstreamProtocol {
    return v === 'RTMP' ? 'RTMP' : 'RTSP';
}

/** The channel's lowest-resolution RTSP stream, its `_sub` when present. */
export function rtspSubstream(streams: StreamOption[], channel: number): StreamOption | undefined {
    const rtsp = streams.filter(s => s.container === 'rtsp' && s.url);
    rtsp.sort((a, b) => (a.video?.width ?? 1e9) - (b.video?.width ?? 1e9));
    return rtsp.find(x => x.id.endsWith(`_${String(channel + 1).padStart(2, '0')}_sub`)) ?? rtsp[0];
}

/**
 * The substream over the chosen protocol: the stream the Rebroadcast prebuffer is expected to hold, so the
 * plugin's own readers (keyframe cache, View, crops) ask for that one and add no NVR connection.
 *
 * The same H.264 + AAC encoder output either way, but the NVR's RTSP server stamps each AAC frame with the time it
 * sends it, not with its sample count: 1024-sample frames arrive 0 to 170 ms apart and carry those times, and
 * any consumer that re-times or transcodes the audio (go2rtc's Opus for WebRTC, HomeKit) plays the overlaps and
 * holes as stutter. RTMP (`sub.bcs`) carries exact 64 ms steps. Without an RTMP substream (Home Hub) RTSP is used,
 * and so it is while the channel type is unknown (typeKnown false: not discovered yet, it may be a Home Hub).
 */
export function substreamOption(streams: StreamOption[], channel: number, protocol: SubstreamProtocol = 'RTSP', typeKnown = true): StreamOption | undefined {
    if (protocol === 'RTMP' && typeKnown) {
        const rtmp = streams.find(s => s.id === 'sub.bcs' && s.url);
        if (rtmp) return rtmp;
    }
    return rtspSubstream(streams, channel);
}

/** Rebroadcast's camera settings (seen through the camera's mixins) whose values are stream names. */
const PREBUFFER_ENABLED = 'prebuffer:enabledStreams';
const PREBUFFER_ROLES = ['prebuffer:defaultStream', 'prebuffer:lowResolutionStream'];

/** The camera as its mixins show it: Rebroadcast adds its settings and marks the streams it prebuffers. */
export interface PrebufferView {
    getSettings?(): Promise<{ key?: string; value?: unknown }[]>;
    getVideoStreamOptions?(): Promise<{ id?: string; name?: string; prebuffer?: number }[]>;
}

/**
 * Names and ids of the streams Rebroadcast prebuffers: its Prebuffered Streams (`prebuffer:enabledStreams`,
 * stream names such as `RTMP sub.bcs`), else the streams of the default and low-resolution roles, plus any
 * stream option it marks with a prebuffer time. Empty without Rebroadcast.
 */
export async function prebufferedStreams(dev: PrebufferView): Promise<string[]> {
    const [settings, options] = await Promise.all([
        dev.getSettings?.().catch(() => undefined),
        dev.getVideoStreamOptions?.().catch(() => undefined),
    ]);
    const get = (key: string) => settings?.find(s => s.key === key)?.value;
    const list = (v: unknown): string[] => {
        if (typeof v === 'string' && v.startsWith('[')) {
            try { v = JSON.parse(v); }
            catch { return []; }
        }
        return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && !!x);
    };
    let names = list(get(PREBUFFER_ENABLED));
    if (!names.length) names = PREBUFFER_ROLES.flatMap(k => list(get(k)));
    for (const o of options ?? [])
        if ((o.prebuffer ?? 0) > 0) names.push(...[o.id, o.name].filter((x): x is string => !!x));
    return [...new Set(names)];
}

export interface SubstreamChoice {
    stream?: StreamOption;
    /** Rebroadcast prebuffers it: reading it adds no NVR connection. */
    prebuffered: boolean;
}

/**
 * The substream Rebroadcast prebuffers (RTMP `sub.bcs` or the RTSP `_sub`), so the plugin's readers follow
 * Rebroadcast rather than a setting that may not match it. The protocol breaks a tie and picks when Rebroadcast
 * prebuffers neither (then each reader costs an NVR connection, and prebuffered is false).
 */
export function chooseSubstream(streams: StreamOption[], channel: number, prebuffered: string[], protocol: SubstreamProtocol = 'RTSP', typeKnown = true): SubstreamChoice {
    const listed = (s?: StreamOption): s is StreamOption => !!s && (prebuffered.includes(s.id) || prebuffered.includes(s.name));
    const found = [streams.find(s => s.id === 'sub.bcs' && s.url), rtspSubstream(streams, channel)].filter(listed);
    if (found.length === 1) return { stream: found[0], prebuffered: true };
    return { stream: substreamOption(streams, channel, protocol, typeKnown), prebuffered: found.length > 1 };
}

/** A stream URL for a log line: scheme, host and path only (RTSP userinfo and RTMP query credentials dropped). */
export function redactUrl(url: string): string {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}${u.pathname}`;
    }
    catch { return '(unparseable URL)'; }
}

/**
 * Credentials masked in a log line, keeping the rest readable: URL userinfo becomes `user:***@`, `password=`/`token=`
 * values become `***`, a JSON "password" value too, and first the given secrets wherever they appear.
 */
export function maskCredentials(s: string, secrets: (string | undefined)[] = []): string {
    let out = s;
    for (const sec of secrets) if (sec && sec.length >= 3) out = out.split(sec).join('***');
    return out
        .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]*):[^\s@/'"]*@/gi, '$1:***@')
        .replace(/\b(password|passwd|pwd|token)=[^\s&'"]*/gi, '$1=***')
        .replace(/("password"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"***"');
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

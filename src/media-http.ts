import type { HttpRequest, HttpResponse } from '@scrypted/sdk';
import type { NvrRecordings } from './recorder';
import { MediaLink, MediaLinkKind, mediaLinkQuery, parseMediaLink, scrubUrls, verifyMediaLink } from './recordings';

// Clips and clip thumbnails served by the plugin itself, under its public endpoint, for Scrypted's own UI (which plays
// a clip's `resources.video.href` in a <video> and shows `resources.thumbnail.href` in an <img>). The endpoint needs
// no Scrypted login, so every link is signed with the install's key and expires.

/** A link stays valid this long, rounded up to the hour so the same clip keeps the same URL (browsers cache it). */
const LINK_TTL_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;

const PATHS: Record<MediaLinkKind, string> = { clip: 'clip.mp4', thumb: 'thumb.jpg' };

/** Expiry (epoch seconds) of a link made now. */
export function linkExpiry(nowMs: number): number {
    return Math.ceil((nowMs + LINK_TTL_MS) / HOUR_MS) * HOUR_MS / 1000;
}

/** A signed link below the plugin's endpoint path (`base`, relative or absolute, with or without its final slash). */
export function mediaLink(base: string, l: MediaLink, key: Buffer): string {
    return `${base.replace(/\/?$/, '/')}${PATHS[l.kind]}?${mediaLinkQuery(l, key)}`;
}

export interface MediaHost {
    recordings?: NvrRecordings;
    clipKey(): Buffer;
}

function sendError(res: HttpResponse, code: number, msg: string) {
    res.send(msg, { code, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/**
 * Serves a signed clip (fragmented MP4, streamed while the NVR plays it back) or clip thumbnail (JPEG). Answers false
 * when the path is not one of these. A browser's `Range: bytes=0-1` probe gets the first two bytes of any MP4 without
 * opening the NVR; other ranges past 0 cannot be served from a live remux (416).
 */
export async function handleMediaRequest(req: HttpRequest, res: HttpResponse, nvr: (nativeId: string) => MediaHost | undefined, now = Date.now): Promise<boolean> {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const name = u.pathname.split('/').pop();
    const kind = (Object.keys(PATHS) as MediaLinkKind[]).find(k => PATHS[k] === name);
    if (!kind) return false;
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
        sendError(res, 405, 'method not allowed');
        return true;
    }
    const link = parseMediaLink(kind, u.searchParams);
    const host = link && nvr(link.nvr);
    if (!link || !host || !verifyMediaLink(link, host.clipKey(), now())) {
        sendError(res, 403, 'invalid or expired link');
        return true;
    }
    const r = host.recordings;
    if (!r) {
        sendError(res, 503, 'NVR not configured');
        return true;
    }
    try {
        if (kind === 'thumb') {
            const jpeg = await r.clipThumbnail(link.channel, link.clipId);
            res.send(jpeg, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
            return true;
        }
        r.decodeClip(link.channel, link.clipId);
        const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'none' };
        const range = req.headers?.range ?? req.headers?.Range;
        if (range && /^bytes=0-1$/.test(range.trim())) {
            // an MP4 starts with the size of its ftyp box, under 64 KiB: two zero bytes
            res.send(Buffer.alloc(2), { code: 206, headers: { ...headers, 'Content-Range': 'bytes 0-1/*' } });
            return true;
        }
        if (range && !/^bytes=0-\d*$/.test(range.trim())) {
            res.send('', { code: 416, headers: { ...headers, 'Content-Range': 'bytes */*' } });
            return true;
        }
        if (req.method === 'HEAD') {
            res.send('', { headers });
            return true;
        }
        const clip = await r.clipMp4(link.channel, link.clipId);
        res.sendStream(clip.stream, { headers });
    }
    catch (e) {
        const msg = scrubUrls((e as Error).message);
        sendError(res, /playback busy/.test(msg) ? 503 : /invalid clip id/.test(msg) ? 403 : /not found/.test(msg) ? 404 : 502, msg);
    }
    return true;
}

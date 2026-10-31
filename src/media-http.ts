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

/** A clip's bytes are kept this long after its last reader went away (then its ffmpeg is stopped, if still running). */
const CLIP_KEEP_MS = 60_000;
/** A clip stops being remuxed past this many bytes (hours of substream). */
const CLIP_MAX_BYTES = 256 * 1024 * 1024;
/** Clips kept at once; past that, the least recently read idle one goes. */
const CLIPS_KEPT = 4;

/**
 * A clip being remuxed, with every byte so far. A browser's <video> drops its connection when paused or off screen and
 * resumes later with `Range: bytes=N-`: a live remux alone cannot answer that, so the bytes are kept while it is read.
 */
export class ClipBuffer {
    private chunks: Buffer[] = [];
    size = 0;
    done = false;
    private readers = 0;
    lastRead: number;
    private waiters: (() => void)[] = [];
    private idle?: ReturnType<typeof setTimeout>;

    constructor(private clip: { stream: AsyncGenerator<Buffer, void>; stop: () => void }, private now: () => number, private onIdle: () => void) {
        this.lastRead = now();
        this.armIdle();
        void this.pump();
    }

    private async pump() {
        try {
            for await (const b of this.clip.stream) {
                this.chunks.push(b);
                this.size += b.length;
                this.wake();
                if (this.size > CLIP_MAX_BYTES) break;
            }
        }
        catch { }
        finally {
            this.clip.stop();
            this.done = true;
            this.wake();
        }
    }

    private wake() {
        for (const w of this.waiters.splice(0)) w();
    }

    private armIdle() {
        clearTimeout(this.idle);
        this.idle = setTimeout(() => this.readers ? undefined : this.onIdle(), CLIP_KEEP_MS);
        this.idle.unref?.();
    }

    stop() {
        clearTimeout(this.idle);
        this.clip.stop();
    }

    get idleNow() {
        return this.readers === 0;
    }

    /** The bytes from `from` on, following the remux until it ends (or only up to `end`, inclusive, when given). */
    async *read(from: number, end = Infinity): AsyncGenerator<Buffer, void> {
        this.readers++;
        try {
            let pos = 0, i = 0;
            while (true) {
                for (; i < this.chunks.length && pos <= end; pos += this.chunks[i++].length) {
                    const c = this.chunks[i], a = Math.max(0, from - pos), b = Math.min(c.length, end + 1 - pos);
                    if (a < b) yield a === 0 && b === c.length ? c : c.subarray(a, b);
                }
                if (this.done || pos > end) return;
                await new Promise<void>(r => this.waiters.push(r));
            }
        }
        finally {
            this.readers--;
            this.lastRead = this.now();
            this.armIdle();
        }
    }
}

/** Clips being served, by link (NVR, channel, clip). */
export const clipBuffers = new Map<string, ClipBuffer>();

/** The clip's buffer, starting its remux when there is none; a fresh one makes room by dropping idle ones. */
async function clipBuffer(key: string, r: NvrRecordings, channel: number, clipId: string, now: () => number): Promise<ClipBuffer> {
    const had = clipBuffers.get(key);
    if (had) return had;
    const idle = [...clipBuffers].filter(([, b]) => b.idleNow).sort((x, y) => x[1].lastRead - y[1].lastRead);
    while (clipBuffers.size >= CLIPS_KEPT && idle.length) {
        const [k, b] = idle.shift()!;
        b.stop();
        clipBuffers.delete(k);
    }
    const clip = await r.clipMp4(channel, clipId);
    // another request may have started the same clip meanwhile
    const raced = clipBuffers.get(key);
    if (raced) {
        clip.stop();
        return raced;
    }
    const b: ClipBuffer = new ClipBuffer(clip, now, () => {
        b.stop();
        if (clipBuffers.get(key) === b) clipBuffers.delete(key);
    });
    clipBuffers.set(key, b);
    return b;
}

/**
 * Serves a signed clip (fragmented MP4, streamed while the NVR plays it back) or clip thumbnail (JPEG). Answers false
 * when the path is not one of these. A clip's bytes are kept while it is read (see ClipBuffer), so `Range: bytes=N-`
 * is served from them; once the whole clip is in, it has a length and any range is served. A browser's
 * `Range: bytes=0-1` probe of a clip not started yet gets two bytes without opening the NVR.
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
        const key = `${link.nvr}|${link.channel}|${link.clipId}`;
        const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' };
        const rangeHeader = String(req.headers?.range ?? req.headers?.Range ?? '').trim();
        const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
        if (rangeHeader && !m) {
            res.send('', { code: 416, headers: { ...headers, 'Content-Range': 'bytes */*' } });
            return true;
        }
        const from = m ? Number(m[1]) : 0, to = m?.[2] ? Number(m[2]) : undefined;
        let b = clipBuffers.get(key);
        if (!b && m && from === 0 && to === 1) {
            // an MP4 starts with the size of its ftyp box, under 64 KiB: two zero bytes
            res.send(Buffer.alloc(2), { code: 206, headers: { ...headers, 'Content-Range': 'bytes 0-1/*' } });
            return true;
        }
        if (req.method === 'HEAD') {
            res.send('', { headers: { ...headers, 'Accept-Ranges': b?.done ? 'bytes' : 'none', ...b?.done ? { 'Content-Length': String(b.size) } : {} } });
            return true;
        }
        if (!b && from > 0) {
            res.send('', { code: 416, headers: { ...headers, 'Content-Range': 'bytes */*' } });
            return true;
        }
        b ??= await clipBuffer(key, r, link.channel, link.clipId, now);
        if (b.done) {
            const last = Math.min(to ?? Infinity, b.size - 1);
            if (from > last) {
                res.send('', { code: 416, headers: { ...headers, 'Content-Range': `bytes */${b.size}` } });
                return true;
            }
            const whole = !m;
            res.sendStream(b.read(from, last), {
                code: whole ? 200 : 206,
                headers: { ...headers, 'Accept-Ranges': 'bytes', 'Content-Length': String(last - from + 1), ...whole ? {} : { 'Content-Range': `bytes ${from}-${last}/${b.size}` } },
            });
            return true;
        }
        if (from > b.size) {
            res.send('', { code: 416, headers: { ...headers, 'Content-Range': 'bytes */*' } });
            return true;
        }
        // still being remuxed: the length is not known yet, so a resumed range runs to the end of what comes
        res.sendStream(b.read(from, to), {
            code: from > 0 ? 206 : 200,
            headers: { ...headers, 'Accept-Ranges': 'none', ...from > 0 ? { 'Content-Range': `bytes ${from}-${to ?? from + CLIP_MAX_BYTES}/*` } : {} },
        });
    }
    catch (e) {
        const msg = scrubUrls((e as Error).message);
        sendError(res, /playback busy/.test(msg) ? 503 : /invalid clip id/.test(msg) ? 403 : /not found/.test(msg) ? 404 : 502, msg);
    }
    return true;
}

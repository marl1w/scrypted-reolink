import type { HttpRequest, HttpResponse } from '@scrypted/sdk';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { FileHandle, mkdir, open, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** A clip's file is kept this long after its last reader went away (then its ffmpeg is stopped, if still running). */
const CLIP_KEEP_MS = 10 * 60_000;
/** A remux nobody has read for this long gives its NVR playback slot to a new clip that needs one. */
const CLIP_EVICT_MS = 5_000;
/** Clip files kept at most; past it the one unread the longest goes. */
const MAX_SPOOLS = 4;
/** A clip stops being remuxed past this many bytes (hours of substream); its length is then what was written. */
const CLIP_MAX_BYTES = 256 * 1024 * 1024;

let spoolDirReady: Promise<string> | undefined;
/** Where clips are spooled, in the plugin's volume; emptied once per start (files left by a previous run). */
function spoolDir(): Promise<string> {
    const dir = join(process.env.SCRYPTED_PLUGIN_VOLUME || join(tmpdir(), 'scrypted-reolink'), 'clips');
    spoolDirReady ??= rm(dir, { recursive: true, force: true }).then(() => mkdir(dir, { recursive: true })).then(() => dir)
        .catch(e => { spoolDirReady = undefined; throw e; });
    return spoolDirReady;
}

/**
 * A clip being remuxed, spooled to a file. A browser's <video> drops its connection when paused or off screen and
 * resumes later with `Range: bytes=N-`: a live remux alone cannot answer that, so the bytes are kept while it is read.
 */
export class ClipSpool {
    size = 0;
    done = false;
    private readers = 0;
    /** When it was created or last read. */
    usedAt = Date.now();
    private waiters: (() => void)[] = [];
    private idle?: ReturnType<typeof setTimeout>;

    constructor(private clip: { stream: AsyncGenerator<Buffer, void>; stop: () => void }, private file: string, private fh: FileHandle, private onIdle: () => void) {
        this.armIdle();
        void this.pump();
    }

    private async pump() {
        try {
            for await (const b of this.clip.stream) {
                const part = b.subarray(0, CLIP_MAX_BYTES - this.size);
                await this.fh.write(part);
                this.size += part.length;
                this.wake();
                if (this.size >= CLIP_MAX_BYTES) break;
            }
        }
        catch { }
        finally {
            this.clip.stop();
            await this.fh.close().catch(() => undefined);
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

    /** Nobody reads it, nor has for `ms`. */
    idleFor(ms: number): boolean {
        return this.readers === 0 && Date.now() - this.usedAt >= ms;
    }

    /** Stops its remux and deletes its file. */
    remove() {
        clearTimeout(this.idle);
        this.clip.stop();
        void unlink(this.file).catch(() => undefined);
    }

    /** Resolves once a byte at `pos` is written, or the clip is complete. */
    async until(pos: number) {
        while (!this.done && this.size <= pos) await new Promise<void>(r => this.waiters.push(r));
    }

    /** The bytes from `from` on, following the remux until it ends (or only up to `end`, inclusive). A reader from now on. */
    read(from: number, end = Infinity): AsyncGenerator<Buffer, void> {
        this.readers++;
        this.usedAt = Date.now();
        return this.reader(from, end);
    }

    private async *reader(from: number, end: number): AsyncGenerator<Buffer, void> {
        try {
            let pos = from;
            while (true) {
                const stop = Math.min(end + 1, this.size);
                if (pos < stop) {
                    for await (const c of createReadStream(this.file, { start: pos, end: stop - 1 })) {
                        pos += (c as Buffer).length;
                        yield c as Buffer;
                    }
                }
                if (pos > end || (this.done && pos >= this.size)) return;
                await this.until(pos);
            }
        }
        finally {
            this.readers--;
            this.usedAt = Date.now();
            this.armIdle();
        }
    }
}

/** Clips being served, by link (NVR, channel, clip), and the ones starting. */
export const clipSpools = new Map<string, ClipSpool>();
const starting = new Map<string, Promise<ClipSpool>>();

/** Removes the clip unread the longest among those `which` accepts, if one has been unread for CLIP_EVICT_MS. */
function evictOne(which: (s: ClipSpool) => boolean): boolean {
    let oldest: [string, ClipSpool] | undefined;
    for (const e of clipSpools)
        if (which(e[1]) && e[1].idleFor(CLIP_EVICT_MS) && (!oldest || e[1].usedAt < oldest[1].usedAt)) oldest = e;
    if (!oldest) return false;
    oldest[1].remove();
    clipSpools.delete(oldest[0]);
    return true;
}

/** The clip's spool, starting its remux when there is none (once, however many requests ask at the same time). */
function clipSpool(key: string, r: NvrRecordings, channel: number, clipId: string): Promise<ClipSpool> {
    const had = clipSpools.get(key);
    if (had) return Promise.resolve(had);
    let p = starting.get(key);
    if (!p) {
        p = startSpool(key, r, channel, clipId).finally(() => starting.delete(key));
        starting.set(key, p);
    }
    return p;
}

async function startSpool(key: string, r: NvrRecordings, channel: number, clipId: string): Promise<ClipSpool> {
    const dir = await spoolDir();
    let clip;
    while (true) {
        try {
            clip = await r.clipMp4(channel, clipId);
            break;
        }
        catch (e) {
            // the NVR's slots are taken: a remux nobody watches gives its slot back (one viewer moves from clip to clip)
            if (!/playback busy/.test((e as Error).message) || !evictOne(s => !s.done)) throw e;
        }
    }
    while (clipSpools.size >= MAX_SPOOLS && evictOne(() => true));
    const file = join(dir, `${randomBytes(8).toString('hex')}.mp4`);
    let fh: FileHandle;
    try { fh = await open(file, 'w'); }
    catch (e) { clip.stop(); throw e; }
    const s: ClipSpool = new ClipSpool(clip, file, fh, () => {
        s.remove();
        if (clipSpools.get(key) === s) clipSpools.delete(key);
    });
    clipSpools.set(key, s);
    return s;
}

/**
 * Serves a signed clip (fragmented MP4, streamed while the NVR plays it back) or clip thumbnail (JPEG). Answers false
 * when the path is not one of these. A clip is spooled while it is read (see ClipSpool): a range is served from the
 * bytes written so far, with the length once the clip is complete. A browser's `Range: bytes=0-1` probe of a clip not
 * started yet gets two bytes without opening the NVR.
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
        const headers = { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
        const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers?.range ?? req.headers?.Range ?? '').trim());
        // an unparseable range, or one ending before it starts, is ignored (RFC 9110, 14.2)
        const range = m && (!m[2] || Number(m[2]) >= Number(m[1])) ? { from: Number(m[1]), to: m[2] ? Number(m[2]) : Infinity } : undefined;
        let s = clipSpools.get(key);
        const fresh = !s && !starting.has(key);
        if (fresh && range?.from === 0 && range.to === 1) {
            // an MP4 starts with the size of its ftyp box, under 64 KiB: two zero bytes
            res.send(Buffer.alloc(2), { code: 206, headers: { ...headers, 'Content-Range': 'bytes 0-1/*' } });
            return true;
        }
        if (req.method === 'HEAD') {
            res.send('', { headers: { ...headers, ...s?.done ? { 'Content-Length': String(s.size) } : {} } });
            return true;
        }
        if (fresh && range && range.from > 0) {
            // nothing to resume from; the length is not known
            res.send('', { code: 416, headers });
            return true;
        }
        s ??= await clipSpool(key, r, link.channel, link.clipId);
        if (!range || (!s.done && range.from === 0 && range.to === Infinity)) {
            // the whole clip: with its length once complete, else following the remux (no end can be promised yet)
            res.sendStream(s.read(0), { headers: { ...headers, ...s.done ? { 'Content-Length': String(s.size) } : {} } });
            return true;
        }
        if (!s.done && range.from > s.size) {
            res.send('', { code: 416, headers });
            return true;
        }
        await s.until(range.from);
        if (range.from >= s.size) {
            res.send('', { code: 416, headers: { ...headers, 'Content-Range': `bytes */${s.size}` } });
            return true;
        }
        // what is written so far; a browser asks for the rest when it gets there
        const last = Math.min(range.to, s.size - 1);
        res.sendStream(s.read(range.from, last), {
            code: 206,
            headers: { ...headers, 'Content-Length': String(last - range.from + 1), 'Content-Range': `bytes ${range.from}-${last}/${s.done ? s.size : '*'}` },
        });
    }
    catch (e) {
        const msg = scrubUrls((e as Error).message);
        sendError(res, /playback busy/.test(msg) ? 503 : /invalid clip id/.test(msg) ? 403 : /not found/.test(msg) ? 404 : 502, msg);
    }
    return true;
}

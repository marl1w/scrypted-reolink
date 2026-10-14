import { ChildProcess, spawn } from 'node:child_process';

const AUD = Buffer.from([0x00, 0x00, 0x01, 0x09]);
const MAX_PENDING = 4 * 1024 * 1024;

/** NAL unit types (H.264) present in an Annex B access unit. */
export function nalTypes(au: Buffer): number[] {
    const out: number[] = [];
    for (let i = 0; i + 3 < au.length; i++) {
        if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
            out.push(au[i + 3] & 0x1f);
            i += 3;
        }
    }
    return out;
}

/**
 * Splits an Annex B H.264 stream with access unit delimiters into access units.
 * Emulation prevention guarantees 00 00 01 never occurs inside a NAL, so every AUD start code is a boundary.
 */
export class AccessUnitSplitter {
    private buf: Buffer = Buffer.alloc(0);

    push(chunk: Buffer): Buffer[] {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        const out: Buffer[] = [];
        let start = this.buf.indexOf(AUD);
        if (start < 0) {
            if (this.buf.length > MAX_PENDING) this.buf = Buffer.alloc(0);
            return out;
        }
        for (;;) {
            const next = this.buf.indexOf(AUD, start + AUD.length);
            if (next < 0) break;
            out.push(Buffer.from(this.buf.subarray(start, next)));
            start = next;
        }
        this.buf = this.buf.subarray(start);
        if (this.buf.length > MAX_PENDING) this.buf = Buffer.alloc(0);
        return out;
    }
}

// ffmpeg children must not outlive the plugin process (a reload would leave them streaming).
const live = new Set<ChildProcess>();
process.once('exit', () => { for (const p of live) p.kill('SIGKILL'); });

export interface KeyframeCacheOptions {
    ffmpegPath: () => Promise<string>;
    url: () => string;
    log: (msg: string) => void;
    now?: () => number;
    restartMinMs?: number;
    restartMaxMs?: number;
}

/**
 * Snapshots the way go2rtc takes them: the low-resolution stream stays open without decoding, and a request
 * decodes exactly one keyframe in a short-lived ffmpeg. Ending the decoder's input after that single frame
 * flushes it at once, so the image is as new as the keyframe (a long-running decoder fed keyframes only
 * holds several of them back in its reorder buffer, seconds behind).
 */
export class KeyframeCache {
    private proc?: ChildProcess;
    private latest?: { au: Buffer; at: number };
    private waiters: ((au?: Buffer) => void)[] = [];
    private stopped = true;
    private restartTimer?: NodeJS.Timeout;
    private backoff: number;
    keyframes = 0;
    restarts = 0;

    constructor(private o: KeyframeCacheOptions) {
        this.backoff = o.restartMinMs ?? 2000;
    }

    private now() { return (this.o.now ?? Date.now)(); }

    start() {
        if (!this.stopped) return;
        this.stopped = false;
        void this.spawn();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.restartTimer);
        this.proc?.kill('SIGKILL');
        this.proc = undefined;
    }

    get running() { return !this.stopped; }

    /** Age in ms of the newest keyframe, or undefined when there is none. */
    age(): number | undefined {
        return this.latest ? this.now() - this.latest.at : undefined;
    }

    /** The newest keyframe if it is at most reuseMs old, else the next one to arrive within waitMs. */
    async keyframe(reuseMs: number, waitMs: number): Promise<Buffer | undefined> {
        if (this.latest && this.now() - this.latest.at <= reuseMs) return this.latest.au;
        if (this.stopped || waitMs <= 0) return undefined;
        return new Promise(resolve => {
            const w = (au?: Buffer) => { clearTimeout(t); this.waiters = this.waiters.filter(x => x !== w); resolve(au); };
            const t = setTimeout(() => w(undefined), waitMs);
            this.waiters.push(w);
        });
    }

    /** A JPEG of the next keyframe (or one at most reuseMs old), or undefined when none arrives in waitMs. */
    async snapshot(reuseMs: number, waitMs: number): Promise<Buffer | undefined> {
        const au = await this.keyframe(reuseMs, waitMs);
        if (!au) return undefined;
        // Concurrent requests for the same keyframe share one decode.
        if (this.decoding?.au !== au) this.decoding = { au, jpeg: this.decode(au) };
        return this.decoding.jpeg;
    }

    private decoding?: { au: Buffer; jpeg: Promise<Buffer | undefined> };

    /** Feed one access unit (used by the stream reader and by tests); only keyframes are kept. */
    accept(au: Buffer) {
        if (!nalTypes(au).includes(5)) return;
        this.latest = { au, at: this.now() };
        this.keyframes++;
        this.backoff = this.o.restartMinMs ?? 2000;
        const w = this.waiters;
        this.waiters = [];
        for (const f of w) f(au);
    }

    private async decode(au: Buffer): Promise<Buffer | undefined> {
        const ffmpeg = await this.o.ffmpegPath();
        return new Promise(resolve => {
            const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-i', 'pipe:0',
                '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
            live.add(p);
            const chunks: Buffer[] = [];
            const t = setTimeout(() => p.kill('SIGKILL'), 3000);
            p.stdout!.on('data', (c: Buffer) => chunks.push(c));
            p.on('exit', () => {
                clearTimeout(t);
                live.delete(p);
                const jpeg = Buffer.concat(chunks);
                resolve(jpeg.length > 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8 ? jpeg : undefined);
            });
            p.stdin!.on('error', () => { });
            p.stdin!.end(au);
        });
    }

    private async spawn() {
        if (this.stopped) return;
        let ffmpeg: string;
        try {
            ffmpeg = await this.o.ffmpegPath();
        }
        catch (e) {
            this.o.log(`snapshot cache: no ffmpeg (${(e as Error).message})`);
            return this.scheduleRestart();
        }
        if (this.stopped) return;
        // Copy only, no decoding: SPS/PPS repeated before every keyframe and an AUD before every access unit,
        // so each keyframe can be cut out and decoded on its own.
        const args = [
            '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-rtsp_transport', 'tcp', '-timeout', '10000000',
            '-fflags', 'nobuffer', '-flags', 'low_delay',
            '-i', this.o.url(),
            '-an', '-sn', '-dn',
            '-c:v', 'copy', '-bsf:v', 'dump_extra=freq=keyframe,h264_metadata=aud=insert',
            '-flush_packets', '1',
            '-f', 'h264', 'pipe:1',
        ];
        const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = p;
        live.add(p);
        const splitter = new AccessUnitSplitter();
        p.stdout!.on('data', (c: Buffer) => { for (const au of splitter.push(c)) this.accept(au); });
        let err = '';
        p.stderr!.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-500); });
        p.on('exit', code => {
            live.delete(p);
            if (this.proc !== p) return;
            this.proc = undefined;
            if (this.stopped) return;
            this.o.log(`snapshot cache: ffmpeg exited (${code})${err ? `: ${err.trim().split('\n').pop()}` : ''}`);
            this.scheduleRestart();
        });
    }

    private scheduleRestart() {
        if (this.stopped) return;
        this.restarts++;
        const d = this.backoff;
        this.backoff = Math.min(this.backoff * 2, this.o.restartMaxMs ?? 60000);
        this.restartTimer = setTimeout(() => void this.spawn(), d);
    }
}

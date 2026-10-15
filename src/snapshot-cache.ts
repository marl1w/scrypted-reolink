import { ChildProcess, spawn } from 'node:child_process';

const SC = Buffer.from([0x00, 0x00, 0x01]);
const SC4 = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const MAX_PENDING = 4 * 1024 * 1024;

/** NAL unit types (H.264) present in an Annex B buffer. */
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
 * Cuts complete keyframes (SPS + PPS + IDR slices, Annex B) out of a raw H.264 stream. A keyframe is complete
 * when the next frame's first NAL arrives. Emulation prevention guarantees 00 00 01 never occurs inside a NAL.
 * The latest SPS/PPS are prepended when a keyframe arrives without them in-band.
 */
export class KeyframeAssembler {
    private buf: Buffer = Buffer.alloc(0);
    private cur?: Buffer[];
    private hasIdr = false;
    private sps?: Buffer;
    private pps?: Buffer;
    bytes = 0;
    nals = 0;

    push(chunk: Buffer): Buffer[] {
        this.bytes += chunk.length;
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        const out: Buffer[] = [];
        let start = this.buf.indexOf(SC);
        if (start < 0) {
            if (this.buf.length > MAX_PENDING) this.buf = Buffer.alloc(0);
            return out;
        }
        for (;;) {
            const next = this.buf.indexOf(SC, start + 3);
            if (next < 0) break;
            // A 4-byte start code leaves its leading zero at the end of the previous NAL; trim it.
            let end = next;
            if (end > start + 3 && this.buf[end - 1] === 0) end--;
            this.onNal(Buffer.concat([SC4, this.buf.subarray(start + 3, end)]), out);
            start = next;
        }
        this.buf = this.buf.subarray(start);
        if (this.buf.length > MAX_PENDING) this.buf = Buffer.alloc(0);
        return out;
    }

    private onNal(nal: Buffer, out: Buffer[]) {
        if (nal.length <= 4) return;
        this.nals++;
        const t = nal[4] & 0x1f;
        const finish = () => {
            if (this.cur && this.hasIdr) out.push(Buffer.concat(this.cur));
            this.cur = undefined;
            this.hasIdr = false;
        };
        if (t === 7) {
            finish();
            this.sps = nal;
            this.cur = [nal];
        }
        else if (t === 8) {
            if (this.cur && this.hasIdr) finish();
            this.pps = nal;
            if (this.cur) this.cur.push(nal);
        }
        else if (t === 6) {
            if (this.cur && this.hasIdr) finish();
            if (this.cur) this.cur.push(nal);
        }
        else if (t === 5) {
            if (!this.cur) {
                if (!this.sps || !this.pps) return;
                this.cur = [this.sps, this.pps];
            }
            else if (!this.cur.some(n => (n[4] & 0x1f) === 8) && this.pps) {
                this.cur.push(this.pps);
            }
            this.cur.push(nal);
            this.hasIdr = true;
        }
        else {
            finish();
        }
    }
}

// ffmpeg children must not outlive the plugin process (a reload would leave them streaming).
const live = new Set<ChildProcess>();
process.once('exit', () => { for (const p of live) p.kill('SIGKILL'); });

export interface KeyframeCacheOptions {
    ffmpegPath: () => Promise<string>;
    /** Where to read the stream; retryMs asks for another try later (e.g. a fallback source). */
    source: () => Promise<{ url: string; label: string; retryMs?: number }>;
    log: (msg: string) => void;
    /** ffmpeg -vf applied when a keyframe is decoded (e.g. the camera's view crop); undefined = whole frame. */
    videoFilter?: () => string | undefined;
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
    private asm?: KeyframeAssembler;
    private lastError = '';
    private retryTimer?: NodeJS.Timeout;
    sourceLabel = '';

    /** Counters for the status line: stream bytes and NAL units parsed, and ffmpeg's last error. */
    diag(): string {
        const e = this.lastError.trim().split('\n').pop();
        return `from ${this.sourceLabel || '?'} · ${Math.round((this.asm?.bytes ?? 0) / 1024)} KiB in · ${this.asm?.nals ?? 0} NALs${e ? ` · ffmpeg: ${e}` : ''}`;
    }

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
        clearTimeout(this.retryTimer);
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
            const vf = this.o.videoFilter?.();
            const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-i', 'pipe:0',
                ...(vf ? ['-vf', vf] : []),
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
        let src: { url: string; label: string; retryMs?: number };
        try {
            src = await this.o.source();
        }
        catch (e) {
            this.o.log(`snapshot cache: no stream (${(e as Error).message})`);
            return this.scheduleRestart();
        }
        if (this.stopped) return;
        this.sourceLabel = src.label;
        // Copy only, no decoding; SPS/PPS repeated before every keyframe so each one decodes on its own.
        const args = [
            '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-rtsp_transport', 'tcp', '-timeout', '10000000',
            '-fflags', 'nobuffer', '-flags', 'low_delay',
            '-i', src.url,
            '-an', '-sn', '-dn',
            '-c:v', 'copy', '-bsf:v', 'dump_extra=freq=keyframe',
            '-flush_packets', '1',
            '-f', 'h264', 'pipe:1',
        ];
        const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = p;
        clearTimeout(this.retryTimer);
        // A fallback source is given up after a while so the preferred one gets another chance.
        if (src.retryMs) this.retryTimer = setTimeout(() => { if (this.proc === p) p.kill('SIGKILL'); }, src.retryMs);
        live.add(p);
        const asm = new KeyframeAssembler();
        this.asm = asm;
        p.stdout!.on('data', (c: Buffer) => { for (const au of asm.push(c)) this.accept(au); });
        p.stderr!.on('data', (c: Buffer) => { this.lastError = (this.lastError + c.toString()).slice(-300); });
        p.on('exit', code => {
            live.delete(p);
            if (this.proc !== p) return;
            this.proc = undefined;
            if (this.stopped) return;
            this.o.log(`snapshot cache: ffmpeg exited (${code})${this.lastError ? `: ${this.lastError.trim().split('\n').pop()}` : ''}`);
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

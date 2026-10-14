import { ChildProcess, spawn } from 'node:child_process';

/** Splits a stream of concatenated JPEGs (ffmpeg image2pipe) into whole images. */
export class JpegSplitter {
    private buf: Buffer = Buffer.alloc(0);

    push(chunk: Buffer): Buffer[] {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        const out: Buffer[] = [];
        for (;;) {
            const start = this.buf.indexOf(SOI);
            if (start < 0) {
                // Keep a trailing 0xFF: it may be the first byte of the next SOI.
                this.buf = this.buf.length && this.buf[this.buf.length - 1] === 0xff ? this.buf.subarray(-1) : Buffer.alloc(0);
                break;
            }
            // Entropy-coded data stuffs 0xFF bytes, so the first EOI after SOI ends the image.
            const end = this.buf.indexOf(EOI, start + 2);
            if (end < 0) {
                this.buf = this.buf.subarray(start);
                break;
            }
            out.push(Buffer.from(this.buf.subarray(start, end + 2)));
            this.buf = this.buf.subarray(end + 2);
        }
        if (this.buf.length > MAX_PENDING) this.buf = Buffer.alloc(0);
        return out;
    }
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const MAX_PENDING = 4 * 1024 * 1024;

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
 * Keeps the latest keyframe of a low-resolution stream decoded as JPEG, so a snapshot is served from memory
 * instead of waiting for the next keyframe. ffmpeg decodes keyframes only, which keeps the cost small.
 */
export class KeyframeCache {
    private proc?: ChildProcess;
    private latest?: { jpeg: Buffer; at: number };
    private waiters: ((jpeg: Buffer) => void)[] = [];
    private stopped = true;
    private restartTimer?: NodeJS.Timeout;
    private backoff: number;
    frames = 0;
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

    /** Age in ms of the newest cached image, or undefined when there is none. */
    age(): number | undefined {
        return this.latest ? this.now() - this.latest.at : undefined;
    }

    /** The newest image if it is younger than maxAgeMs, else the next one to arrive within waitMs. */
    async get(maxAgeMs: number, waitMs: number): Promise<Buffer | undefined> {
        if (this.latest && this.now() - this.latest.at <= maxAgeMs) return this.latest.jpeg;
        if (this.stopped || waitMs <= 0) return undefined;
        return new Promise(resolve => {
            const done = (j?: Buffer) => { clearTimeout(t); this.waiters = this.waiters.filter(w => w !== w2); resolve(j); };
            const w2 = (j: Buffer) => done(j);
            const t = setTimeout(() => done(undefined), waitMs);
            this.waiters.push(w2);
        });
    }

    /** Feed one decoded image (used by the ffmpeg reader and by tests). */
    accept(jpeg: Buffer) {
        this.latest = { jpeg, at: this.now() };
        this.frames++;
        this.backoff = this.o.restartMinMs ?? 2000;
        const w = this.waiters;
        this.waiters = [];
        for (const f of w) f(jpeg);
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
        const args = [
            '-hide_banner', '-loglevel', 'error', '-nostdin',
            '-rtsp_transport', 'tcp', '-timeout', '10000000',
            // Low latency: frame-threaded decoding holds back one frame per thread, which with keyframes
            // only (about 1 s apart) delays every image by seconds; demuxer buffering adds more.
            '-fflags', 'nobuffer', '-flags', 'low_delay', '-max_delay', '0',
            '-probesize', '32768', '-analyzeduration', '0',
            '-threads', '1', '-skip_frame', 'nokey',
            '-i', this.o.url(),
            '-an', '-sn', '-dn',
            '-fps_mode', 'passthrough',
            '-c:v', 'mjpeg', '-q:v', '4',
            '-f', 'image2pipe', 'pipe:1',
        ];
        const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = p;
        live.add(p);
        const splitter = new JpegSplitter();
        p.stdout!.on('data', (c: Buffer) => { for (const j of splitter.push(c)) this.accept(j); });
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

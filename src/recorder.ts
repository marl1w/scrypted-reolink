import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { Cmd } from './baichuan/constants';
import type { NvrApi } from './http/nvr-api';
import {
    AlarmVideo, alarmVideoHandleXml, alarmVideoOpenXml, buildClips, ClipInfo, clipMp4Args, ClipRef, decodeClipId, downloadUrl,
    flvUrl, isContinuousDay, MAX_CLIP_SECONDS, parseAlarmVideos, parseFileHandle, parseSearchFiles, PlaybackRoute, PlaybackTarget,
    playbackIsUtc, playbackUrl, recorderDay, recorderDays, RecorderZone, RecordingFile, recordingInputArgs, RecordingStreamType,
    reolinkTime, ROUTE_ORDER, scrubUrls, splitRecordings, thumbnailArgs,
} from './recordings';

// One NVR's recordings: searches (cached, coalesced and one at a time, as the NVR is slow and its HTTP pool small),
// trigger windows from the Baichuan alarm-video search, which playback endpoint it serves, and thumbnails.

/** How often the recorder's time settings are read again (DST rules rarely change). */
const ZONE_TTL_MS = 6 * 3_600_000;
/** A search answer is reused for this long whatever was asked: a burst of calls costs one search. */
const MIN_TTL_MS = 30_000;
/** A day still being recorded: reused this long when the asked time was already in the past when it was searched. */
const TODAY_TTL_MS = 5 * 60_000;
/** A past day: recordings do not appear any more, only go when the disk fills. */
const PAST_TTL_MS = 3_600_000;
/** Trigger windows of a day still being recorded, and of a past day. */
const ALARMS_TODAY_TTL_MS = 60_000;
const ALARMS_PAST_TTL_MS = 3_600_000;
/** A recording shows up in the search this long after it started (measured: about 20 s on an NVR). */
const SETTLE_MS = 30_000;
/** Day answers kept per NVR, least recently used dropped first (16 channels x 31 days). */
const MAX_DAYS = 512;
/** Trigger windows kept per day. */
const MAX_ALARMS_PER_DAY = 2000;
/** Windows long recordings (24/7) are cut into, for clips. */
export const SPLIT_MS = 5 * 60_000;
/** How long a playback endpoint gets to answer at all while measured (a silent one would hold every route behind it). */
const PROBE_MS = 15_000;
/** A measured route is measured again after this long (a firmware update may move the recorder). */
const ROUTE_TTL_MS = 10 * 60_000;
/** After no route answered, playback fails at once for this long instead of probing the NVR again. */
const ROUTE_BACKOFF_MS = 60_000;
/** Playback streams and thumbnails at once per NVR. */
export const PLAYBACK_SLOTS = 3;
/** A handed-out bounded recording stream counts against the slots for its duration plus this (we do not see the consumer end it). */
const LEASE_GRACE_MS = 30_000;
/** ...an unbounded one, or a clip that may never be opened, for this long; no lease longer than the max. */
const LEASE_OPEN_MS = 60_000;
const LEASE_MAX_MS = 10 * 60_000;
/** A playback token must stay valid at least this long, or the asked duration, capped. */
const TOKEN_MIN_MS = 10 * 60_000;
const TOKEN_MAX_MS = 50 * 60_000;
/** A thumbnail's ffmpeg is killed after this long (an NVR that stops sending would leave it waiting). */
const THUMBNAIL_TIMEOUT_MS = 20_000;
const THUMBNAIL_MAX_BYTES = 1024 * 1024;
const THUMBNAIL_CACHE = 64;
/** Thumbnails waiting at most; the oldest is dropped past it (a clip list asks for about 30 at once). */
export const THUMBNAIL_QUEUE = 64;
/** Thumbnails decoded at once per NVR, always leaving one playback slot free for real playback. */
export const THUMBNAIL_PARALLEL = 2;
/** A served clip's ffmpeg is killed when the NVR sent nothing for this long. */
const CLIP_STALL_MS = 30_000;
/** ...or after the clip's length plus this (the NVR plays back at 1x), at most CLIP_MAX_MS. */
const CLIP_GRACE_MS = 120_000;
const CLIP_MAX_MS = 3_600_000;
/** A failed thumbnail is not tried again for this long. */
const THUMBNAIL_FAIL_TTL_MS = 60_000;
/** A thumbnail stream the NVR closed at once is asked again, up to this many times, after 0.5 s, 1 s... */
const THUMBNAIL_REOPENS = 3;
const THUMBNAIL_RETRY_MS = 500;
/** After this many streams in a row the NVR closed at once, thumbnails fail at once for THUMBNAIL_PAUSE_MS. */
const THUMBNAIL_BREAKER = 6;
const THUMBNAIL_PAUSE_MS = 60_000;
/** The alarm-video search is paged; reolink_aio stops after this many pages. */
const MAX_ALARM_PAGES = 50;
/** A gap this short before a recording starts is played from that recording's start. */
const GAP_MS = 10_000;

export interface RecorderTarget {
    host: string;
    port: number;
    rtmpPort: number;
    username: string;
    password: string;
}

export interface BaichuanQuery {
    channelQuery(cmd: number, channel: number, xml: string, timeoutMs?: number): Promise<string>;
}

export interface RecorderDeps {
    api: () => NvrApi;
    /** A token of the plugin's one shared HTTP session, valid at least `minRemainingMs` (Playback and Download carry it). */
    token: (minRemainingMs?: number) => Promise<string>;
    target: () => RecorderTarget;
    baichuan: () => BaichuanQuery | undefined;
    /** The camera UID of a channel (GetChannelstatus), needed by the alarm-video search; '' or undefined for none. */
    uid: (channel: number) => string | undefined;
    /** This install's key for signing clip ids. */
    clipKey: () => Buffer;
    /** Playback streams and thumbnails at once on this NVR (the NVR's setting, default PLAYBACK_SLOTS). */
    slots?: () => number;
    ffmpegPath: () => Promise<string>;
    log?: (msg: string) => void;
    now?: () => number;
    /** HTTP status of a GET, closed as soon as the headers arrive. */
    probe?: (url: string, timeoutMs: number) => Promise<number>;
    runFfmpeg?: (ffmpeg: string, args: string[], timeoutMs: number) => Promise<Buffer>;
    spawnFfmpeg?: (ffmpeg: string, args: string[]) => ChildProcessWithoutNullStreams;
    /** Served clip watchdog: stall and check interval, ms (tests shorten them). */
    clipLimits?: { stallMs?: number; checkMs?: number };
    /** First back-off before a thumbnail stream the NVR closed is asked again (default THUMBNAIL_RETRY_MS). */
    thumbnailRetryMs?: number;
}

interface DayRecord {
    rows: RecordingFile[];
    fetchedAt: number;
    /** trigger windows; undefined until asked for, null when the lookup failed */
    alarms?: AlarmVideo[] | null;
    alarmsAt?: number;
}

export interface RecordingInput {
    route: PlaybackRoute;
    inputArguments: string[];
    container: string;
    /** the URL, for consumers that read it (it carries a token or credentials: never log it) */
    url: string;
}

export interface ClipQuery {
    startTime?: number;
    endTime?: number;
    count?: number;
}

interface ThumbJob {
    key: string;
    input: () => Promise<RecordingInput>;
    channel?: number;
    /** the input's ffmpeg arguments, once resolved */
    args?: string[];
    /** probing only the first packets (cleared for the fallback), and how often the stream was asked again */
    fast: boolean;
    reopens: number;
    resolve: (b: Buffer) => void;
    reject: (e: Error) => void;
}

type RecordingRef = Pick<RecordingFile, 'stream' | 'name' | 'fileStartId' | 'playbackId'>;

export class NvrRecordings {
    private zoneValue?: { zone: RecorderZone; at: number };
    private zonePromise?: Promise<RecorderZone>;
    private days = new Map<string, DayRecord>();
    private inflight = new Map<string, Promise<DayRecord>>();
    private httpQueue: Promise<unknown> = Promise.resolve();
    private bcQueue: Promise<unknown> = Promise.resolve();
    /** The last decisive PlaybackTime convention of this NVR, for a search where no row votes. */
    utcConvention?: boolean;
    /** The endpoint this NVR serves playback from, and when it was measured; in memory only. */
    private routeState?: { route: PlaybackRoute; at: number };
    private routeFailure?: { at: number; error: Error };
    private measuring?: Promise<PlaybackRoute>;
    /** Playback leases handed out, per channel and stream (latest wins), with their end times; thumbnails or probes running. */
    private leases = new Map<string, number>();
    private running = 0;
    private thumbs = new Map<string, Buffer>();
    private thumbFails = new Map<string, { at: number; error: Error }>();
    private thumbInflight = new Map<string, Promise<Buffer>>();
    private thumbJobs: ThumbJob[] = [];
    private thumbActive = 0;
    /** Streams the NVR closed at once in a row, and until when thumbnails then fail at once. */
    private thumbCloses = 0;
    private thumbPausedUntil = 0;
    private fallbackLogs = 0;
    private warnedAmp = false;
    searches = 0;
    alarmSearches = 0;

    constructor(private deps: RecorderDeps) { }

    private now() { return (this.deps.now ?? Date.now)(); }

    /** The measured route, if any. */
    get route(): PlaybackRoute | undefined { return this.routeState?.route; }

    /** Runs one task at a time on a queue, whatever the previous task's outcome. */
    private serial<T>(queue: 'httpQueue' | 'bcQueue', fn: () => Promise<T>): Promise<T> {
        const p = this[queue].then(fn, fn);
        this[queue] = p.catch(() => undefined);
        return p;
    }

    private secrets(): string[] {
        return [this.deps.target().password];
    }

    /** The recorder's zone, from GetTime; an old answer is kept when the NVR cannot be asked. */
    async zone(): Promise<RecorderZone> {
        const v = this.zoneValue;
        if (v && this.now() - v.at < ZONE_TTL_MS) return v.zone;
        this.zonePromise ??= this.serial('httpQueue', () => this.deps.api().time())
            .then(t => {
                const zone = new RecorderZone(t);
                this.zoneValue = { zone, at: this.now() };
                return zone;
            })
            .catch(e => {
                if (v) return v.zone;
                throw e;
            })
            .finally(() => { this.zonePromise = undefined; });
        return this.zonePromise;
    }

    private static isPast(dayEnd: number, at: number) {
        return dayEnd < at - SETTLE_MS;
    }

    private fresh(rec: DayRecord, dayEnd: number, needUntil: number): boolean {
        const age = this.now() - rec.fetchedAt;
        if (age < 0) return false;
        if (age < MIN_TTL_MS) return true;
        if (needUntil > rec.fetchedAt - SETTLE_MS) return false;
        return age < (NvrRecordings.isPast(dayEnd, rec.fetchedAt) ? PAST_TTL_MS : TODAY_TTL_MS);
    }

    /**
     * One recorder day of one channel and stream, searched only when no cached answer can hold what is asked.
     * `needUntil` is clamped to the day's end, so a past day is never searched again for a later time.
     */
    private async day(channel: number, stream: RecordingStreamType, dayWall: number, needUntil: number): Promise<DayRecord> {
        const zone = await this.zone();
        const key = `${channel}|${stream}|${dayWall}`;
        const dayEnd = zone.instantOf(dayWall + 86_399_000);
        const cached = this.days.get(key);
        if (cached && this.fresh(cached, dayEnd, Math.min(needUntil, dayEnd))) {
            // least recently used goes first
            this.days.delete(key);
            this.days.set(key, cached);
            return cached;
        }
        let p = this.inflight.get(key);
        if (!p) {
            p = this.serial('httpQueue', async () => {
                const fetchedAt = this.now();
                this.searches++;
                const raw = await this.deps.api().search(channel, stream, reolinkTime(dayWall), reolinkTime(dayWall + 86_399_000));
                const measured = playbackIsUtc(raw, zone);
                if (measured !== undefined) this.utcConvention = measured;
                // trigger windows have their own lifetime: a new search does not throw them away
                const rec: DayRecord = { rows: parseSearchFiles(raw, stream, zone, measured ?? this.utcConvention), fetchedAt, alarms: cached?.alarms, alarmsAt: cached?.alarmsAt };
                this.days.delete(key);
                this.days.set(key, rec);
                while (this.days.size > MAX_DAYS) this.days.delete(this.days.keys().next().value!);
                return rec;
            }).catch(e => {
                // a failed search never discards a good answer: the older one is served instead
                if (cached) {
                    this.deps.log?.(`recordings search, channel ${channel}: ${(e as Error).message}; using the answer from ${Math.round((this.now() - cached.fetchedAt) / 1000)} s ago`);
                    return cached;
                }
                throw e;
            }).finally(() => this.inflight.delete(key));
            this.inflight.set(key, p);
        }
        return p;
    }

    /**
     * Trigger windows of a day, from the Baichuan alarm-video search (cmds 272/273/274, read-only, guest-safe). The
     * HTTP search names no trigger on an NVR. Null when they cannot be known: no Baichuan session, no camera UID, or
     * the search failed; the caller must then not treat a row without triggers as filler.
     */
    private async alarms(channel: number, stream: RecordingStreamType, dayWall: number, rec: DayRecord): Promise<AlarmVideo[] | null> {
        const zone = await this.zone();
        const dayEnd = zone.instantOf(dayWall + 86_399_000);
        if (rec.alarms !== undefined && rec.alarmsAt !== undefined) {
            const age = this.now() - rec.alarmsAt;
            if (age >= 0 && age < (NvrRecordings.isPast(dayEnd, rec.alarmsAt) ? ALARMS_PAST_TTL_MS : ALARMS_TODAY_TTL_MS)) return rec.alarms;
        }
        const bc = this.deps.baichuan();
        const uid = (this.deps.uid(channel) ?? '').split('_')[0];
        if (!bc || !uid) return null;
        const at = this.now();
        const result = await this.serial('bcQueue', async () => {
            this.alarmSearches++;
            const out: AlarmVideo[] = [];
            const seen = new Set<string>();
            let start = dayWall;
            const end = dayWall + 86_399_000;
            for (let page = 0; page < MAX_ALARM_PAGES && out.length < MAX_ALARMS_PER_DAY; page++) {
                const handle = parseFileHandle(await bc.channelQuery(Cmd.AlarmVideoOpen, channel, alarmVideoOpenXml(channel, uid, stream, start, end)));
                if (handle === undefined) break;
                const next = alarmVideoHandleXml(channel, handle);
                let p;
                try {
                    p = parseAlarmVideos(await bc.channelQuery(Cmd.AlarmVideoNext, channel, next));
                }
                finally {
                    // always closed: an open search holds a handle on the NVR
                    await bc.channelQuery(Cmd.AlarmVideoClose, channel, next).catch(() => undefined);
                }
                for (const it of p.items) {
                    const k = `${it.startWall}|${it.endWall}|${it.classes.join(',')}`;
                    if (seen.has(k) || out.length >= MAX_ALARMS_PER_DAY) continue;
                    seen.add(k);
                    out.push({ start: zone.instantOf(it.startWall), end: zone.instantOf(it.endWall), classes: it.classes });
                }
                if (p.finished || p.lastStartWall === undefined || p.lastStartWall <= start) break;
                start = p.lastStartWall;
            }
            return out;
        }).catch(e => {
            this.deps.log?.(`trigger search, channel ${channel}: ${(e as Error).message}`);
            return null;
        });
        // into the record cached now: a search may have replaced the one this lookup started from
        const cur = this.days.get(`${channel}|${stream}|${dayWall}`) ?? rec;
        cur.alarms = result;
        cur.alarmsAt = at;
        return result;
    }

    /** Recordings (whole files, clipped to their day) overlapping a span, oldest first. */
    async recordings(channel: number, stream: RecordingStreamType, start: number, end: number): Promise<RecordingFile[]> {
        const zone = await this.zone();
        const out: RecordingFile[] = [];
        for (const d of recorderDays(zone, start, end)) {
            const rec = await this.day(channel, stream, d, Math.min(end, this.now()));
            out.push(...rec.rows.filter(r => r.end > start && r.start < end));
        }
        return out;
    }

    /**
     * Clips between two times: recording windows of the substream, with the trigger classes that fall in each.
     * Oldest first; `count` keeps the most recent ones.
     */
    async clips(channel: number, q: ClipQuery = {}): Promise<ClipInfo[]> {
        const now = this.now();
        const end = Math.min(q.endTime ?? now, now);
        const start = Math.min(q.startTime ?? end - 86_400_000, end);
        const zone = await this.zone();
        const key = this.deps.clipKey();
        const out: ClipInfo[] = [];
        for (const d of recorderDays(zone, start, end)) {
            const rec = await this.day(channel, 'sub', d, end);
            const { start: dayStart, end: dayEnd } = recorderDay(zone, zone.instantOf(d));
            const alarms = rec.rows.length ? await this.alarms(channel, 'sub', d, rec) : [];
            const continuous = isContinuousDay(rec.rows, dayStart, dayEnd, now);
            const rows = splitRecordings(rec.rows, SPLIT_MS).filter(r => r.end > start && r.start < end);
            out.push(...buildClips(rows, alarms ?? undefined, continuous, channel, key));
        }
        out.sort((a, b) => a.startTime - b.startTime);
        return q.count && q.count > 0 ? out.slice(-q.count) : out;
    }

    /** A clip id of this channel, verified against this install's key. */
    decodeClip(channel: number, id: string): ClipRef {
        return decodeClipId(id, this.deps.clipKey(), channel);
    }

    /**
     * The recording holding an instant, and the seek into it. A time in a short gap plays the next recording from its
     * start; anything else is an error, not a silently different time.
     */
    async recordingAt(channel: number, stream: RecordingStreamType, time: number): Promise<{ row: RecordingFile; seek: number }> {
        const rows = await this.recordings(channel, stream, time - 1000, time + GAP_MS);
        const hit = rows.find(r => r.start <= time && time < r.end) ?? rows.find(r => r.start > time && r.start - time <= GAP_MS);
        if (!hit) throw new Error(`no ${stream} stream recording on channel ${channel} at ${new Date(time).toISOString()}`);
        return { row: hit, seek: Math.max(0, Math.floor((Math.max(time, hit.start) - hit.fileStart) / 1000)) };
    }

    private async url(route: PlaybackRoute, t: PlaybackTarget, tokenMs = TOKEN_MIN_MS): Promise<string> {
        const tg = this.deps.target();
        if (route === 'flv') {
            if (tg.password.includes('&') && !this.warnedAmp) {
                this.warnedAmp = true;
                this.deps.log?.('recordings: the account password contains "&", which the NVR may cut short on the /flv route');
            }
            return flvUrl(t, tg.rtmpPort, tg.username, tg.password);
        }
        const token = await this.deps.token(Math.min(Math.max(tokenMs, TOKEN_MIN_MS), TOKEN_MAX_MS));
        return route === 'download' ? downloadUrl(t, token) : playbackUrl(t, token);
    }

    private purgeLeases() {
        const now = this.now();
        for (const [k, end] of this.leases) if (end <= now) this.leases.delete(k);
    }

    /** Throws when the NVR's playback slots are taken; a lease of `replacing` would be replaced, so it does not count. */
    private busy(replacing?: string) {
        this.purgeLeases();
        const slots = Math.max(1, this.deps.slots?.() ?? PLAYBACK_SLOTS);
        const leases = this.leases.size - (replacing !== undefined && this.leases.has(replacing) ? 1 : 0);
        if (this.running + leases >= slots) throw new Error(`NVR playback busy: ${slots} playback streams or thumbnails already open`);
    }

    /** Runs a probe or a thumbnail in one of the NVR's playback slots. */
    private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
        this.busy();
        this.running++;
        try { return await fn(); }
        finally { this.running--; }
    }

    /**
     * Which endpoint serves playback: cmd=Playback first (what the NVR's own player uses), then /flv, then the
     * whole-file Download, with the remembered route tried first, all on the target being opened. Success is HTTP 200.
     * Another route is remembered only when it answers 200 on a `verified` target (a row the NVR has just listed) and
     * every route before it refused that same target with an HTTP 4xx: a timeout, a busy NVR or a recording that is
     * gone (an old clip id) is no reason to move. 404 everywhere means the recording is gone, not the route: no back-off.
     * Measured again after ROUTE_TTL_MS or a failure; after any other total failure, playback fails at once for
     * ROUTE_BACKOFF_MS.
     */
    async playbackRoute(t: PlaybackTarget, verified = false): Promise<PlaybackRoute> {
        const now = this.now();
        if (this.routeState && now - this.routeState.at < ROUTE_TTL_MS) return this.routeState.route;
        if (this.routeFailure && now - this.routeFailure.at < ROUTE_BACKOFF_MS) throw this.routeFailure.error;
        this.measuring ??= (async () => {
            const problems: string[] = [];
            const probe = this.deps.probe ?? probeStatus;
            const remembered = this.routeState?.route;
            const order = remembered ? [remembered, ...ROUTE_ORDER.filter(r => r !== remembered)] : ROUTE_ORDER;
            let refused = true, allNotFound = true;
            for (const route of order) {
                try {
                    const status = await this.withSlot(async () => probe(await this.url(route, t), PROBE_MS));
                    if (status === 200) {
                        // remembered: the route already known, the first route tried (no change), or a change on a verified target
                        if (route === remembered || !problems.length || (verified && refused)) {
                            if (route !== remembered) this.deps.log?.(`recordings: this NVR serves playback from the ${route} route`);
                            this.routeState = { route, at: this.now() };
                        }
                        // else: used for this target only; the remembered route stays, measured again next time
                        this.routeFailure = undefined;
                        return route;
                    }
                    if (status < 400 || status >= 500) refused = false;
                    if (status !== 404) allNotFound = false;
                    problems.push(`${route}: HTTP ${status}`);
                }
                catch (e) {
                    refused = allNotFound = false;
                    problems.push(`${route}: ${scrubUrls((e as Error).message, this.secrets())}`);
                    if (/playback busy/.test((e as Error).message)) throw e;
                }
            }
            if (allNotFound) throw new Error(`recording not found on the NVR, deleted or not written yet (${problems.join('; ')})`);
            const error = new Error(`the NVR would not serve this recording on any playback endpoint (${problems.join('; ')})`);
            this.routeFailure = { at: this.now(), error };
            throw error;
        })().finally(() => { this.measuring = undefined; });
        return this.measuring;
    }

    /** The route failed (a thumbnail could not read it): measured again on the next playback. */
    routeFailed() {
        if (this.routeState) this.routeState.at = -Infinity;
    }

    /** Forgets the measured route and any failure, so the next playback measures from scratch. */
    forgetRoute() {
        this.routeState = undefined;
        this.routeFailure = undefined;
    }

    /**
     * ffmpeg input for a recording from `seek` seconds in, bounded to `duration` seconds (at most a day) when given.
     * Each handed-out stream takes a playback slot, one per channel and stream (latest wins): a bounded recording
     * stream for about its length, an open one for a minute. A thumbnail input or a `held` one takes no lease (the
     * thumbnail or the served clip holds a slot while it runs); a thumbnail input on the Download route starts at the
     * file's beginning, as seeking a whole file would read it up to the seek. `verified`: the row was just listed by the NVR.
     */
    async input(channel: number, rec: RecordingRef, seek: number, duration?: number, opts: { thumbnail?: boolean; verified?: boolean; held?: boolean } = {}): Promise<RecordingInput> {
        const d = duration && duration > 0 ? Math.min(duration, MAX_CLIP_SECONDS) : undefined;
        const tg = this.deps.target();
        const t: PlaybackTarget = { host: tg.host, port: tg.port, channel, ...rec, seek };
        const route = await this.playbackRoute(t, opts.verified);
        if (opts.thumbnail && route === 'download') seek = 0;
        const leaseKey = `${channel}|${rec.stream}`;
        const lease = !opts.thumbnail && !opts.held;
        if (lease) this.busy(leaseKey);
        // a whole file is seeked by ffmpeg, so the recorder is asked for it from its start
        const url = await this.url(route, { ...t, seek: route === 'download' ? 0 : seek }, d ? d * 1000 + 60_000 : TOKEN_MIN_MS);
        // the lease only once the URL exists: a failure above holds no slot
        if (lease)
            this.leases.set(leaseKey, this.now() + (!d ? LEASE_OPEN_MS : Math.min(d * 1000 + LEASE_GRACE_MS, LEASE_MAX_MS)));
        return { route, url, container: route === 'download' ? 'mp4' : 'flv', inputArguments: recordingInputArgs(route, url, seek, d) };
    }

    /** Takes one of the NVR's playback slots until the returned release is called (once; later calls do nothing). */
    holdSlot(): () => void {
        this.busy();
        this.running++;
        let held = true;
        return () => {
            if (!held) return;
            held = false;
            this.running--;
        };
    }

    /**
     * A clip of this channel as fragmented MP4, remuxed by ffmpeg from the NVR's playback stream, for a browser. It
     * holds a playback slot while it runs (no lease: the end is seen here), released when ffmpeg ends, fails or is
     * killed: on `stop()` (or when the consumer stops iterating), when the NVR sends nothing for CLIP_STALL_MS, or past the clip's length plus CLIP_GRACE_MS. Resolves once the first bytes
     * are there, so a failure can still be answered as one; throws "NVR playback busy" when no slot is free.
     */
    async clipMp4(channel: number, id: string): Promise<{ stream: AsyncGenerator<Buffer, void>; stop: () => void }> {
        const c = this.decodeClip(channel, id);
        const d = c.duration > 0 ? Math.min(c.duration, MAX_CLIP_SECONDS) : undefined;
        // the input first: a route measurement takes its own slot, released before this one is taken
        const input = await this.input(channel, c, c.offset, d, { held: true });
        const ffmpeg = await this.deps.ffmpegPath();
        const release = this.holdSlot();
        let p: ChildProcessWithoutNullStreams;
        try { p = (this.deps.spawnFfmpeg ?? spawnFfmpeg)(ffmpeg, clipMp4Args(input.inputArguments)); }
        catch (e) { release(); throw e; }
        let err = '', ended = false, lastData = this.now();
        const stop = () => {
            if (ended) return;
            ended = true;
            clearTimeout(deadline);
            clearInterval(watchdog);
            if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
            release();
        };
        const deadline = setTimeout(stop, Math.min((d ?? 0) * 1000 + CLIP_GRACE_MS, CLIP_MAX_MS));
        const lim = this.deps.clipLimits;
        const watchdog = setInterval(() => {
            if (this.now() - lastData > (lim?.stallMs ?? CLIP_STALL_MS)) stop();
        }, lim?.checkMs ?? 5000);
        // neither keeps the process alive
        deadline.unref?.();
        watchdog.unref?.();
        p.stderr.on('data', (b: Buffer) => { if (err.length < 2000) err += b.toString(); });
        p.on('error', e => { err ||= e.message; stop(); });
        p.on('close', stop);
        const now = () => this.now();
        async function* chunks(): AsyncGenerator<Buffer, void> {
            try {
                for await (const b of p.stdout as AsyncIterable<Buffer>) {
                    lastData = now();
                    yield b;
                }
            }
            finally { stop(); }
        }
        const it = chunks();
        const first = await it.next().catch(e => { stop(); throw e; });
        if (first.done) {
            stop();
            throw new Error(`clip failed: ${scrubUrls(err.trim(), this.secrets()).slice(0, 300) || `ffmpeg exit ${p.exitCode}`}`);
        }
        async function* all(): AsyncGenerator<Buffer, void> {
            try {
                yield first.value as Buffer;
                yield* it;
            }
            finally { await it.return(undefined); }
        }
        return { stream: all(), stop };
    }

    /** A small JPEG of a clip's first frame. */
    clipThumbnail(channel: number, id: string): Promise<Buffer> {
        const c = this.decodeClip(channel, id);
        return this.thumbnail(`${channel}|clip|${id}`, () => this.input(channel, c, c.offset, undefined, { thumbnail: true }), channel);
    }

    /**
     * A small JPEG of the first frame of an input. Up to THUMBNAIL_PARALLEL ffmpegs at once per NVR, never more than
     * the playback slots minus one (one stays for real playback), at most THUMBNAIL_QUEUE waiting (the oldest is
     * dropped, and not remembered as a failure), one in flight per key, recent ones cached, failures remembered a minute.
     */
    thumbnail(key: string, input: () => Promise<RecordingInput>, channel?: number): Promise<Buffer> {
        const hit = this.thumbs.get(key);
        if (hit) return Promise.resolve(hit);
        const fail = this.thumbFails.get(key);
        if (fail && this.now() - fail.at < THUMBNAIL_FAIL_TTL_MS) return Promise.reject(fail.error);
        let p = this.thumbInflight.get(key);
        if (p) return p;
        p = new Promise<Buffer>((resolve, reject) => {
            this.thumbJobs.push({ key, input, channel, fast: true, reopens: 0, resolve, reject });
            while (this.thumbJobs.length > THUMBNAIL_QUEUE) this.thumbJobs.shift()!.reject(new Error('thumbnail dropped: too many waiting'));
            this.pumpThumbnails();
        }).finally(() => this.thumbInflight.delete(key));
        this.thumbInflight.set(key, p);
        return p;
    }

    /** Thumbnails decoded at once: THUMBNAIL_PARALLEL, but one playback slot always stays free. */
    private thumbnailParallel(): number {
        const slots = Math.max(1, this.deps.slots?.() ?? PLAYBACK_SLOTS);
        return Math.max(1, Math.min(THUMBNAIL_PARALLEL, slots - 1));
    }

    private pumpThumbnails() {
        while (this.thumbActive < this.thumbnailParallel() && this.thumbJobs.length) {
            const job = this.thumbJobs.shift()!;
            this.thumbActive++;
            this.thumbAttempt(job)
                .then(jpeg => jpeg && job.resolve(jpeg), e => job.reject(this.thumbFailed(job.key, e as Error)))
                .finally(() => {
                    this.thumbActive--;
                    this.pumpThumbnails();
                });
        }
    }

    /** Back in the queue, first, after `ms`: the worker is free meanwhile. */
    private requeueThumbnail(job: ThumbJob, ms: number) {
        const t = setTimeout(() => {
            this.thumbJobs.unshift(job);
            this.pumpThumbnails();
        }, ms);
        t.unref?.();
    }

    /** One decode of a job: its JPEG, or undefined when the job went back in the queue to be tried again. */
    private async thumbAttempt(job: ThumbJob): Promise<Buffer | undefined> {
        if (this.now() < this.thumbPausedUntil) throw new Error('thumbnails paused: the NVR keeps closing playback streams');
        // the input first: a route measurement takes its own slot, released before the decode takes one
        job.args ??= (await job.input()).inputArguments;
        const ffmpeg = await this.deps.ffmpegPath();
        try {
            const jpeg = await this.withSlot(() => (this.deps.runFfmpeg ?? runFfmpeg)(ffmpeg, thumbnailArgs(job.args!, undefined, job.fast), THUMBNAIL_TIMEOUT_MS));
            if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('thumbnail failed: ffmpeg produced no JPEG');
            this.thumbCloses = 0;
            this.thumbs.set(job.key, jpeg);
            while (this.thumbs.size > THUMBNAIL_CACHE) this.thumbs.delete(this.thumbs.keys().next().value!);
            return jpeg;
        }
        catch (e) {
            const m = (e as Error).message;
            // the NVR itself failed (an HTTP error, no stream, a busy NVR), or the fallback failed too
            if (!/^thumbnail failed/.test(m) || /Server returned|did not finish|playback busy/.test(m) || !job.fast) throw e;
            if (/Error opening input|End of file/.test(m)) {
                // the NVR closed the stream at once (seen right after a route probe): asked again as it was, unless it
                // keeps doing so, then thumbnails pause a minute
                if (++this.thumbCloses >= THUMBNAIL_BREAKER) {
                    this.thumbCloses = 0;
                    this.thumbPausedUntil = this.now() + THUMBNAIL_PAUSE_MS;
                    this.deps.log?.(`recordings: the NVR closed ${THUMBNAIL_BREAKER} thumbnail streams in a row; thumbnails paused for ${THUMBNAIL_PAUSE_MS / 1000} s`);
                    throw e;
                }
                if (++job.reopens > THUMBNAIL_REOPENS) throw e;
                this.requeueThumbnail(job, (this.deps.thumbnailRetryMs ?? THUMBNAIL_RETRY_MS) * job.reopens);
                return undefined;
            }
            // the fast probe may miss the first frame (a stream starting between keyframes, H.265): ffmpeg's default
            // probing once more
            if (this.fallbackLogs++ < 5)
                this.deps.log?.(`recordings: a thumbnail needed ffmpeg's default probing (${job.channel === undefined ? '' : `channel ${job.channel}: `}${scrubUrls(m, this.secrets()).slice(0, 200)})`);
            job.fast = false;
            this.requeueThumbnail(job, 0);
            return undefined;
        }
    }

    /** A thumbnail's failure, scrubbed; remembered unless it is momentary, and an ffmpeg failure may mean the route moved. */
    private thumbFailed(key: string, e: Error): Error {
        const error = new Error(scrubUrls(e.message, this.secrets()));
        if (!/playback busy|thumbnails paused/.test(e.message)) this.thumbFails.set(key, { at: this.now(), error });
        if (/^thumbnail failed/.test(e.message)) this.routeFailed();
        while (this.thumbFails.size > THUMBNAIL_CACHE) this.thumbFails.delete(this.thumbFails.keys().next().value!);
        return error;
    }
}

/** ffmpeg writing to stdout, its stderr kept for errors. */
export function spawnFfmpeg(ffmpeg: string, args: string[]): ChildProcessWithoutNullStreams {
    return spawn(ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** HTTP status of a GET; the connection is closed as soon as the headers arrive, so no video is pulled. */
export function probeStatus(url: string, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = httpRequest(url, { method: 'GET', agent: false }, res => {
            resolve(res.statusCode ?? 0);
            res.destroy();
            req.destroy();
        });
        const timer = setTimeout(() => req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
        req.on('close', () => clearTimeout(timer));
        req.on('error', e => reject(new Error(scrubUrls(e.message))));
        req.end();
    });
}

/** Runs ffmpeg to stdout with a deadline; errors carry its stderr with URLs scrubbed (they hold credentials). */
export function runFfmpeg(ffmpeg: string, args: string[], timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const out: Buffer[] = [];
        let size = 0, err = '';
        const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`thumbnail failed: ffmpeg did not finish within ${timeoutMs / 1000} s`)); }, timeoutMs);
        p.stdout.on('data', (c: Buffer) => {
            size += c.length;
            if (size > THUMBNAIL_MAX_BYTES) p.kill('SIGKILL');
            else out.push(c);
        });
        p.stderr.on('data', (c: Buffer) => { if (err.length < 2000) err += c.toString(); });
        p.on('error', e => { clearTimeout(timer); reject(new Error(`thumbnail failed: ${e.message}`)); });
        p.on('close', code => {
            clearTimeout(timer);
            if (code === 0 && out.length) resolve(Buffer.concat(out));
            else reject(new Error(`thumbnail failed: ${scrubUrls(err.trim()).slice(0, 300) || `ffmpeg exit ${code}`}`));
        });
    });
}

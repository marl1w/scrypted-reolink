// NVR recordings: the recorder's own time zone, search results, trigger types, clip ids and playback URLs.
// Pure (no SDK, no I/O), so every rule can be tested with fixtures. The design notes, and the fixes each rule
// carries over from Reolink Stamina, are in docs/recordings.md.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { childText, findAll, findFirst, parseXml, XmlNode } from './baichuan/xml';

/** A wall-clock time as the Reolink JSON API states it. */
export interface ReolinkTime { year: number; mon: number; day: number; hour: number; min: number; sec: number }

export type RecordingStreamType = 'main' | 'sub';

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * A wall clock as milliseconds, read as if it were UTC: arithmetic on wall clocks without any zone. Throws on a
 * field that is missing or out of range, so one unreadable row cannot pass as another time.
 */
export function wallMs(t: ReolinkTime): number {
    const f = [t?.year, t?.mon, t?.day, t?.hour, t?.min, t?.sec].map(Number);
    if (f.some(n => !Number.isInteger(n)) || f[1] < 1 || f[1] > 12 || f[2] < 1 || f[2] > 31 || f[3] > 23 || f[4] > 59 || f[5] > 59)
        throw new Error('invalid recorder time');
    return Date.UTC(f[0], f[1] - 1, f[2], f[3], f[4], f[5]);
}

export function reolinkTime(wall: number): ReolinkTime {
    const d = new Date(wall);
    return { year: d.getUTCFullYear(), mon: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), min: d.getUTCMinutes(), sec: d.getUTCSeconds() };
}

/** `YYYYMMDDhhmmss` of a wall clock (or of an instant, read in UTC). */
export function timeId(wall: number): string {
    const t = reolinkTime(wall);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${t.year}${p(t.mon)}${p(t.day)}${p(t.hour)}${p(t.min)}${p(t.sec)}`;
}

export function parseTimeId(id: string): number {
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(id);
    if (!m) throw new Error('invalid time id');
    return wallMs({ year: +m[1], mon: +m[2], day: +m[3], hour: +m[4], min: +m[5], sec: +m[6] });
}

/** The GetTime answer: `Time.timeZone` is seconds west of UTC; `Dst` holds the yearly summer-time rules. */
export interface TimeSettings {
    Time: { timeZone: number;[k: string]: unknown };
    Dst?: {
        enable?: number; offset?: number;
        startMon: number; startWeek: number; startWeekday: number; startHour: number; startMin: number; startSec: number;
        endMon: number; endWeek: number; endWeekday: number; endHour: number; endMin: number; endSec: number;
        [k: string]: unknown;
    };
}

type DstRules = NonNullable<TimeSettings['Dst']>;

/**
 * The wall clock a DST rule fires at in a year, POSIX `Mm.w.d` style: weeks 1-4 are that occurrence of the
 * weekday, 5 is the last one in the month. Reolink counts weekdays from Sunday, as JavaScript does.
 */
export function dstTransition(rules: DstRules, prefix: 'start' | 'end', year: number): number {
    const month = Number(rules[`${prefix}Mon`]);
    const week = Math.min(Math.max(Number(rules[`${prefix}Week`]), 1), 5);
    const weekday = ((Number(rules[`${prefix}Weekday`]) % 7) + 7) % 7;
    let day: number;
    if (week === 5) {
        const last = new Date(Date.UTC(year, month, 0));
        day = last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
    }
    else {
        const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
        day = 1 + ((weekday - first + 7) % 7) + 7 * (week - 1);
    }
    return Date.UTC(year, month - 1, day, Number(rules[`${prefix}Hour`]), Number(rules[`${prefix}Min`]), Number(rules[`${prefix}Sec`]));
}

/**
 * The recorder's own time zone, rebuilt from its GetTime settings: a fixed standard offset, plus summer time
 * between two yearly rules (also across the new year, for the southern hemisphere). reolink_aio resolves these
 * rules to wrong dates (a "4th Sunday of October" rule ends summer time on 19 October 2026), so it is not ported.
 */
export class RecorderZone {
    readonly standardMs: number;
    readonly summerMs: number;
    private rules?: DstRules;
    private years = new Map<number, [number, number]>();

    constructor(settings: TimeSettings) {
        const tz = Number(settings?.Time?.timeZone);
        if (!Number.isFinite(tz)) throw new Error('recorder time zone unknown');
        // seconds west of UTC; an instant is wall clock minus the offset east
        this.standardMs = -tz * 1000;
        const d = settings.Dst;
        this.rules = d && Number(d.enable) ? d : undefined;
        this.summerMs = this.rules ? Number(this.rules.offset ?? 1) * 3_600_000 : 0;
    }

    private bounds(year: number): [number, number] {
        let b = this.years.get(year);
        if (!b) this.years.set(year, b = [dstTransition(this.rules!, 'start', year), dstTransition(this.rules!, 'end', year)]);
        return b;
    }

    /** Whether summer time is in force at a recorder wall clock (the hour repeated in autumn reads as summer). */
    inSummer(wall: number): boolean {
        if (!this.rules) return false;
        const [start, end] = this.bounds(new Date(wall).getUTCFullYear());
        return start <= end ? start <= wall && wall < end : wall >= start || wall < end;
    }

    offsetAt(wall: number): number {
        return this.standardMs + (this.inSummer(wall) ? this.summerMs : 0);
    }

    /**
     * The instant (epoch ms) a recorder wall clock names. The hour repeated in autumn reads as summer time, unless
     * `standard` asks for its second (standard-time) reading.
     */
    instantOf(wall: number, standard = false): number {
        return wall - (standard ? this.standardMs : this.offsetAt(wall));
    }

    /** Whether a wall clock falls in the hour repeated in autumn (it names two instants). */
    ambiguous(wall: number): boolean {
        return this.inSummer(wall) && !this.inSummer(wall + this.summerMs);
    }

    /** The recorder's wall clock at an instant; decided on standard time, so the repeated hour maps one to one. */
    wallOf(instant: number): number {
        const std = instant + this.standardMs;
        if (!this.rules) return std;
        const [start, end] = this.bounds(new Date(std).getUTCFullYear());
        const endStd = end - this.summerMs;
        const summer = start <= endStd ? start <= std && std < endStd : std >= start || std < endStd;
        return summer ? std + this.summerMs : std;
    }
}

/** One row of a Search answer, as the NVR sends it. */
export interface RawFile {
    StartTime: ReolinkTime;
    EndTime: ReolinkTime;
    PlaybackTime?: ReolinkTime;
    name?: string;
    size?: string | number;
    type?: string;
}

/** A recording, or a window of one, with everything playback needs to address it. */
export interface RecordingFile {
    stream: RecordingStreamType;
    name: string;
    /** this row's span (epoch ms) */
    start: number;
    end: number;
    /** where the recording itself begins (epoch ms): Playback locates the file by it */
    fileStart: number;
    /** the recording's start as the recorder's wall clock: the Playback `start` */
    fileStartId: string;
    /** PlaybackTime as the recorder states it: the Playback `playbackTime` */
    playbackId: string;
    /** seconds from the recording's start to this row's start */
    offset: number;
    size: number;
    /** no usable PlaybackTime came back, StartTime stood in */
    derived: boolean;
}

function statedPlayback(f: RawFile): number | undefined {
    try { return f.PlaybackTime ? wallMs(f.PlaybackTime) : undefined; }
    catch { return undefined; }
}

/** Two conventions are told apart by the whole UTC offset; the slack absorbs a recorder rounding one timestamp. */
const CONVENTION_SLACK_MS = 2000;

/**
 * Whether the recorder states PlaybackTime in UTC (reolink_aio's assumption) or in its own wall clock (seen on
 * some NVRs: then every Playback request asks for a time an offset away and gets nothing). Measured from the rows:
 * among the rows sharing one PlaybackTime the earliest still begins where the recording does, so its StartTime
 * and PlaybackTime differ by the UTC offset, or by nothing. Rows matching neither do not vote.
 */
export function playbackIsUtc(files: RawFile[], zone: RecorderZone): boolean | undefined {
    const earliest = new Map<number, number>();
    for (const f of files) {
        const pb = statedPlayback(f);
        if (pb === undefined) continue;
        let start: number;
        try { start = wallMs(f.StartTime); }
        catch { continue; }
        const known = earliest.get(pb);
        if (known === undefined || start < known) earliest.set(pb, start);
    }
    let utc = 0, local = 0;
    for (const [pb, start] of earliest) {
        const offset = zone.offsetAt(start);
        if (!offset) continue;
        const gap = start - pb;
        if (Math.abs(gap - offset) <= CONVENTION_SLACK_MS) utc++;
        else if (Math.abs(gap) <= CONVENTION_SLACK_MS) local++;
    }
    // no vote: undefined, so the caller can keep the last decisive answer for this recorder
    if (!utc && !local) return undefined;
    return !(local > utc);
}

/**
 * Search rows as recordings. A row without a usable PlaybackTime (Home Hubs) is served by its StartTime, exact
 * there because such devices are never split; a row with an unreadable StartTime or EndTime is skipped rather than
 * failing the whole search.
 */
export function parseSearchFiles(files: RawFile[], stream: RecordingStreamType, zone: RecorderZone, convention?: boolean): RecordingFile[] {
    const utc = convention ?? playbackIsUtc(files, zone) ?? true;
    const out: RecordingFile[] = [];
    // rows come in recording order: the end of the previous one tells which reading of the repeated hour is meant
    let prevEnd: number | undefined;
    for (const f of files) {
        let startWall: number, endWall: number;
        try { [startWall, endWall] = [wallMs(f.StartTime), wallMs(f.EndTime)]; }
        catch { continue; }
        let start = zone.instantOf(startWall), end = zone.instantOf(endWall);
        // the hour repeated in autumn, decided by order, whatever PlaybackTime says (it may be local or missing): the
        // standard-time reading where the summer one would start before the previous row ended, or end this row
        // before it starts (02:40 -> 02:10 across the change)
        if (prevEnd !== undefined && start < prevEnd && zone.ambiguous(startWall)) start = zone.instantOf(startWall, true);
        if (end < start && zone.ambiguous(endWall)) end = zone.instantOf(endWall, true);
        prevEnd = Math.max(prevEnd ?? end, end);
        const pb = statedPlayback(f);
        const derived = pb === undefined;
        let fileStart = derived ? start : utc ? pb! : zone.instantOf(pb!);
        // a local PlaybackTime in the repeated hour: the latest reading not after its row's start
        if (!derived && !utc && zone.ambiguous(pb!) && zone.instantOf(pb!, true) <= start) fileStart = zone.instantOf(pb!, true);
        const playbackId = derived ? (utc ? timeId(start) : timeId(startWall)) : timeId(pb!);
        out.push({
            stream,
            name: typeof f.name === 'string' && f.name ? f.name : playbackId,
            start, end, fileStart,
            fileStartId: timeId(zone.wallOf(fileStart)),
            playbackId,
            offset: Math.max(0, Math.round((start - fileStart) / 1000)),
            size: Number(f.size) || 0,
            derived,
        });
    }
    return out.sort((a, b) => a.start - b.start);
}

/**
 * Long recordings (half an hour on 24/7 recorders) cut into windows, as reolink_aio splits them, so a trigger
 * stays meaningful per window. Each window keeps the recording's name and start, and its own offset into it.
 */
export function splitRecordings(rows: RecordingFile[], splitMs: number): RecordingFile[] {
    const out: RecordingFile[] = [];
    const win = (r: RecordingFile, s: number, e: number): RecordingFile => ({ ...r, start: s, end: e, offset: Math.max(0, Math.round((s - r.fileStart) / 1000)) });
    for (const r of rows) {
        let s = r.start;
        while (r.end - s > splitMs + MINUTE) {
            out.push(win(r, s, s + splitMs));
            s += splitMs;
        }
        if (r.end - s > 0) {
            if (r.end - s > splitMs) {
                const half = Math.round((r.end - s) / 2);
                out.push(win(r, s, s + half));
                s += half;
            }
            out.push(win(r, s, r.end));
        }
    }
    return out;
}

/** Share of a day that must be recorded for it to count as 24/7 recording. */
export const CONTINUOUS_COVERAGE = 0.7;

/**
 * Whether a camera-day looks like 24/7 recording: what is recorded against what has elapsed of that day. A day
 * that has not begun cannot be measured, and is not continuous (the elapsed time would be negative).
 */
export function isContinuousDay(rows: RecordingFile[], dayStart: number, dayEnd: number, now: number): boolean {
    const elapsed = Math.min(now, dayEnd) - dayStart;
    if (elapsed <= 0) return false;
    let recorded = 0;
    for (const r of rows) recorded += Math.max(0, Math.min(r.end, dayEnd) - Math.max(r.start, dayStart));
    return recorded / elapsed >= CONTINUOUS_COVERAGE;
}

/** Trigger types of the Baichuan alarm-video search (and of cmd 33 smart events), as Scrypted detection classes. */
export const TRIGGER_CLASSES: Record<string, string> = {
    md: 'motion', pir: 'motion', other: 'motion',
    people: 'person', vehicle: 'vehicle', dog_cat: 'animal', face: 'face', package: 'package',
    visitor: 'doorbell', io: 'io', cry: 'crying',
    crossline: 'line_crossing', intrusion: 'intrusion', loitering: 'loitering', legacy: 'forgotten_item', loss: 'taken_item',
};

/** The most specific class names a clip. */
const EVENT_PRIORITY = ['person', 'vehicle', 'animal', 'face', 'package', 'doorbell', 'line_crossing', 'intrusion', 'loitering', 'forgotten_item', 'taken_item', 'crying', 'io', 'motion'];

export interface AlarmVideo {
    /** epoch ms */
    start: number;
    end: number;
    classes: string[];
}

export interface AlarmVideoPage {
    finished: boolean;
    /** wall clock of the last item, where the next page starts */
    lastStartWall?: number;
    items: { startWall: number; endWall: number; classes: string[] }[];
}

function xmlTime(n: XmlNode | undefined): number | undefined {
    if (!n) return undefined;
    const v = (k: string) => Number(childText(n, k));
    try { return wallMs({ year: v('year'), mon: v('month'), day: v('day'), hour: v('hour'), min: v('minute'), sec: v('second') }); }
    catch { return undefined; }
}

/** One cmd 273 answer of the alarm-video search: trigger windows in the recorder's wall clock. */
export function parseAlarmVideos(xml: string): AlarmVideoPage {
    const doc = parseXml(xml);
    const info = findFirst(doc, 'alarmVideoInfo');
    const page: AlarmVideoPage = { finished: true, items: [] };
    if (!info) return page;
    page.finished = childText(info, 'bFinished') !== '0';
    for (const item of findAll(info, 'alarmVideo')) {
        const types = (childText(item, 'alarmType') ?? '').split(',').map(s => s.trim()).filter(Boolean);
        const startWall = xmlTime(findFirst(item, 'startTime')), endWall = xmlTime(findFirst(item, 'endTime'));
        if (startWall === undefined || endWall === undefined || !types.length) continue;
        const classes = [...new Set(types.map(t => TRIGGER_CLASSES[t]).filter(Boolean))];
        page.items.push({ startWall, endWall, classes });
        page.lastStartWall = startWall;
    }
    return page;
}

function xmlTimeBlock(tag: string, wall: number) {
    const t = reolinkTime(wall);
    return `<${tag}>\n<year>${t.year}</year>\n<month>${t.mon}</month>\n<day>${t.day}</day>\n<hour>${t.hour}</hour>\n<minute>${t.min}</minute>\n<second>${t.sec}</second>\n</${tag}>`;
}

/** cmd 272 body: open an alarm-video search for one channel and wall-clock span, as reolink_aio's search_vod_type. */
export function alarmVideoOpenXml(channel: number, uid: string, stream: RecordingStreamType, startWall: number, endWall: number): string {
    return `<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<findAlarmVideo version="1.1">\n<channelId>${channel}</channelId>\n<uid>${uid}</uid>\n<logicChnBitmap>255</logicChnBitmap>\n<streamType>${stream === 'sub' ? 1 : 0}</streamType>\n<notSearchVideo>0</notSearchVideo>\n${xmlTimeBlock('startTime', startWall)}\n${xmlTimeBlock('endTime', endWall)}\n<alarmType>md, pir, io, people, face, vehicle, dog_cat, visitor, other, package, cry, crossline, intrusion, loitering, legacy, loss</alarmType>\n</findAlarmVideo>\n</body>`;
}

/** cmd 273 (next page) and 274 (close) body for an open search. */
export function alarmVideoHandleXml(channel: number, handle: string): string {
    return `<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<findAlarmVideo version="1.1">\n<channelId>${channel}</channelId>\n<fileHandle>${handle}</fileHandle>\n</findAlarmVideo>\n</body>`;
}

export function parseFileHandle(xml: string): string | undefined {
    const h = findFirst(parseXml(xml), 'fileHandle')?.text.trim();
    return h && /^-?\d+$/.test(h) ? h : undefined;
}

/** Classes whose trigger window overlaps a row. */
export function classesIn(row: { start: number; end: number }, alarms: AlarmVideo[]): string[] {
    const out = new Set<string>();
    for (const a of alarms)
        if (a.start < row.end && a.end >= row.start) for (const c of a.classes) out.add(c);
    return EVENT_PRIORITY.filter(c => out.has(c)).concat([...out].filter(c => !EVENT_PRIORITY.includes(c)).sort());
}

export interface ClipInfo {
    id: string;
    startTime: number;
    duration: number;
    event: string;
    description: string;
    detectionClasses: string[];
}

/**
 * Clips from recording windows. On a 24/7 day, windows no trigger falls in are filler and are dropped, but only
 * when the triggers are actually known: dropping unlabelled rows of an event-recording camera, or of a search
 * whose trigger lookup failed, would hide every event it has.
 */
export function buildClips(rows: RecordingFile[], alarms: AlarmVideo[] | undefined, continuous: boolean, channel: number, key: Buffer): ClipInfo[] {
    const out: ClipInfo[] = [];
    for (const r of rows) {

        const classes = alarms ? classesIn(r, alarms) : [];
        if (continuous && alarms && !classes.length) continue;
        const duration = Math.max(0, r.end - r.start);
        out.push({
            id: encodeClipId({ channel, stream: r.stream, name: RECORDING_NAME.test(r.name) ? r.name : '', fileStartId: r.fileStartId, playbackId: r.playbackId, offset: r.offset, duration: Math.round(duration / 1000), startTime: r.start }, key),
            startTime: r.start,
            duration,
            event: classes.find(c => c !== 'motion') ?? (classes.length ? 'motion' : 'recording'),
            description: `${r.stream} stream recording${classes.length ? `: ${classes.join(', ')}` : ''}`,
            detectionClasses: classes,
        });
    }
    return out;
}

/**
 * NVR recording names as observed: `<stream>-<channel>-<n>-<14 digits>-<5 digits>`. Anything else is refused before
 * it reaches a URL.
 */
export const RECORDING_NAME = new RegExp([
    // NVR: <stream>-<channel>-<n>-<14 digits>-<5 digits>
    /^\d+-\d+-\d+-\d{14}-\d{5}$/.source,
    // camera storage, as reolink_aio lists them: [/mnt/sda/<dir>/]Mp4Record/<date>/RecXnn_[DST]<date>_<time>_<time>_<hex fields>.mp4
    /^(?:\/mnt\/sda\/[A-Za-z0-9_.-]{1,64}\/)?Mp4Record\/\d{4}-\d{2}-\d{2}\/Rec[A-Za-z0-9]{3}_(?:DST)?\d{8}_\d{6}_\d{6}(?:_[A-Za-z0-9]{1,16}){1,6}\.mp4$/.source,
    // a row without a name: its PlaybackTime, as reolink_aio names it
    /^\d{14}$/.source,
].join('|'));

/** The `source` a recording is played by: its name when it has a known shape, else its PlaybackTime (fixed, safe). */
export function playbackSource(name: string, playbackId: string): string {
    return name && RECORDING_NAME.test(name) ? name : playbackId;
}

/** A clip is at most a day long. */
export const MAX_CLIP_SECONDS = 86_400;

/** Everything getVideoClip needs, carried in the clip id itself, so no lookup is needed to play it. */
export interface ClipRef {
    channel: number;
    stream: RecordingStreamType;
    name: string;
    fileStartId: string;
    playbackId: string;
    /** seconds into the recording */
    offset: number;
    /** seconds */
    duration: number;
    startTime: number;
}

const CLIP_PREFIX = 'r2';

const clipSignature = (payload: string, key: Buffer) => createHmac('sha256', key).update(payload).digest('base64url').slice(0, 22);

/** A clip id, signed with this install's key so a caller cannot forge one that names another recording or channel. */
export function encodeClipId(c: ClipRef, key: Buffer): string {
    // a name of an unknown shape travels as '-': played by its PlaybackTime instead
    const payload = [CLIP_PREFIX, c.channel, c.stream, c.name || '-', c.fileStartId, c.playbackId, c.offset, Math.min(c.duration, MAX_CLIP_SECONDS), c.startTime].join('~');
    return `${payload}~${clipSignature(payload, key)}`;
}

/** Parses, validates and verifies a clip id for one channel; throws on anything malformed, forged or foreign. */
export function decodeClipId(id: string, key: Buffer, channel: number): ClipRef {
    const p = String(id).split('~');
    const bad = () => new Error('invalid clip id');
    if (p.length !== 10 || p[0] !== CLIP_PREFIX) throw bad();
    const payload = p.slice(0, 9).join('~');
    const sig = Buffer.from(p[9]), want = Buffer.from(clipSignature(payload, key));
    if (sig.length !== want.length || !timingSafeEqual(sig, want)) throw bad();
    if (!/^\d{1,3}$/.test(p[1]) || +p[1] !== channel || (p[2] !== 'main' && p[2] !== 'sub') || (p[3] !== '-' && !RECORDING_NAME.test(p[3]))
        || !/^\d{14}$/.test(p[4]) || !/^\d{14}$/.test(p[5]) || ![p[6], p[7], p[8]].every(x => /^\d{1,15}$/.test(x)) || +p[7] > MAX_CLIP_SECONDS)
        throw bad();
    return { channel, stream: p[2], name: p[3] === '-' ? '' : p[3], fileStartId: p[4], playbackId: p[5], offset: +p[6], duration: +p[7], startTime: +p[8] };
}

/** Where the NVR serves recordings from. Recorders disagree, and the disagreement does not follow the model. */
export type PlaybackRoute = 'playback' | 'flv' | 'download';
export const ROUTE_ORDER: PlaybackRoute[] = ['playback', 'flv', 'download'];

export interface PlaybackTarget {
    host: string;
    port: number;
    channel: number;
    stream: RecordingStreamType;
    name: string;
    fileStartId: string;
    playbackId: string;
    /** seconds into the recording */
    seek: number;
}

const streamType = (s: RecordingStreamType) => s === 'sub' ? 1 : 0;

/**
 * `cmd=Playback`, as the recorder's own web player asks: `start` is the recording's own start (recorder wall
 * clock), `playbackTime` the PlaybackTime as stated, `type` the stream, `channel` and `seek` even at zero. Leaving
 * any out makes the NVR answer 404 or nothing at all.
 */
export function playbackUrl(t: PlaybackTarget, token: string): string {
    const q = new URLSearchParams({
        cmd: 'Playback', channel: String(t.channel), type: String(streamType(t.stream)), start: t.fileStartId,
        seek: String(Math.max(0, Math.floor(t.seek))), source: playbackSource(t.name, t.playbackId), playbackTime: t.playbackId, token,
    });
    return `http://${t.host}:${t.port}/cgi-bin/api.cgi?${q}`;
}

/**
 * `/flv` playback by file name over the RTMP service; credentials unencoded, as the endpoint compares raw bytes. A
 * password with whitespace or quotes cannot travel so and is refused; one with `&` may be cut short by the NVR.
 */
export function flvUrl(t: PlaybackTarget, rtmpPort: number, username: string, password: string): string {
    if (/[\s"'#]/.test(username + password)) throw new Error('the /flv playback route cannot carry a username or password with spaces, quotes or #');
    return `http://${t.host}:${t.port}/flv?port=${rtmpPort}&app=bcs&stream=playback.bcs&channel=${t.channel}&type=${streamType(t.stream)}`
        + `&start=${encodeURIComponent(playbackSource(t.name, t.playbackId))}&seek=${Math.max(0, Math.floor(t.seek))}&user=${username}&password=${password}`;
}

/** `cmd=Download`: the whole file, at wire speed, unseekable on the recorder (the seek is done by ffmpeg). */
export function downloadUrl(t: PlaybackTarget, token: string): string {
    return `http://${t.host}:${t.port}/cgi-bin/api.cgi?cmd=Download&source=${encodeURIComponent(playbackSource(t.name, t.playbackId))}&output=recording.mp4&token=${encodeURIComponent(token)}`;
}

/**
 * ffmpeg input arguments for a recording. The NVR's FLV carries no usable timestamps at the start of a seek, hence
 * `+genpts`. A whole-file download starts at the beginning, so its seek is an input seek here; a duration bounds the
 * read, which makes it a finite, downloadable stream.
 */
export function recordingInputArgs(route: PlaybackRoute, url: string, seek: number, duration?: number): string[] {
    // only HTTP: the URL is the NVR's, but nothing else may be opened through it
    const args = ['-protocol_whitelist', 'http,tcp', '-fflags', '+genpts'];
    if (route === 'download' && seek > 0) args.push('-ss', seek.toFixed(3));
    if (duration && duration > 0) args.push('-t', duration.toFixed(3));
    args.push('-i', url);
    return args;
}

/** Thumbnail width: small, as the clip lists and the timeline show them. */
export const THUMBNAIL_WIDTH = 320;

/** One small JPEG of the first frame of an input. */
export function thumbnailArgs(input: string[], width = THUMBNAIL_WIDTH): string[] {
    return ['-hide_banner', '-loglevel', 'error', '-nostdin', ...input, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '6', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'];
}

/**
 * Credentials and tokens out of a message that may quote a URL (ffmpeg quotes its input): URL queries, any
 * `user=`/`password=`/`token=` up to the next whitespace, and the given secrets wherever they appear.
 */
export function scrubUrls(s: string, secrets: (string | undefined)[] = []): string {
    let out = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, u => {
        try {
            const x = new URL(u);
            return `${x.protocol}//${x.host}${x.pathname}`;
        }
        catch { return '(url)'; }
    }).replace(/\b(user|username|password|token)=\S*/gi, '$1=***');
    for (const sec of secrets) if (sec && sec.length >= 3) out = out.split(sec).join('***');
    return out;
}

/** Day/night state (cmd 296 `stat`): day, night or led_day; only night is IR / black and white. */
export function isNight(mode: string | undefined): boolean | undefined {
    if (!mode) return undefined;
    return mode.trim().toLowerCase() === 'night';
}

/** Recorder-day bounds (epoch ms) of the wall-clock day holding an instant. */
export function recorderDay(zone: RecorderZone, instant: number): { dayWall: number; start: number; end: number } {
    const wall = zone.wallOf(instant);
    const dayWall = wall - (((wall % DAY) + DAY) % DAY);
    return { dayWall, start: zone.instantOf(dayWall), end: zone.instantOf(dayWall + DAY - 1000) };
}

/** Recorder days (wall ms at midnight) covering a span, oldest first, at most `max`. */
export function recorderDays(zone: RecorderZone, start: number, end: number, max = 31): number[] {
    const first = recorderDay(zone, start).dayWall, last = recorderDay(zone, Math.max(start, end)).dayWall;
    const out: number[] = [];
    for (let d = Math.max(first, last - (max - 1) * DAY); d <= last; d += DAY) out.push(d);
    return out;
}

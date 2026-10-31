import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    alarmVideoOpenXml, buildClips, decodeClipId, downloadUrl, dstTransition, encodeClipId, flvUrl, isContinuousDay, isNight,
    parseAlarmVideos, parseFileHandle, parseSearchFiles, parseTimeId, playbackIsUtc, playbackUrl, RawFile, RecorderZone,
    recorderDays, recordingInputArgs, scrubUrls, splitRecordings, thumbnailArgs, timeId, wallMs,
} from '../src/recordings';

const KEY = Buffer.alloc(32, 7);
const fx = (n: string) => readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', n), 'utf8');

// Central European rules as an NVR states them: last Sunday of March to last Sunday of October, 02:00.
const CE = { enable: 1, offset: 1, startMon: 3, startWeek: 5, startWeekday: 0, startHour: 2, startMin: 0, startSec: 0, endMon: 10, endWeek: 5, endWeekday: 0, endHour: 2, endMin: 0, endSec: 0 };
const zoneCE = new RecorderZone({ Time: { timeZone: -3600 }, Dst: CE });
const W = (s: string) => Date.parse(`${s}Z`); // a wall clock, as wall ms
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19);

test('DST rules resolve the POSIX way: week 5 is the last weekday, weeks 1-4 that occurrence', () => {
    assert.equal(iso(dstTransition(CE, 'start', 2026)), '2026-03-29T02:00:00', 'last Sunday of March, not Saturday 21');
    assert.equal(iso(dstTransition(CE, 'end', 2026)), '2026-10-25T02:00:00', 'last Sunday of October, not 1 November');
    // a "4th Sunday of October" rule: reolink_aio resolves it to Monday 19 October 2026
    assert.equal(iso(dstTransition({ ...CE, endWeek: 4 }, 'end', 2026)), '2026-10-25T02:00:00');
    assert.equal(iso(dstTransition({ ...CE, endWeek: 1 }, 'end', 2026)), '2026-10-04T02:00:00');
    assert.equal(iso(dstTransition(CE, 'start', 2027)), '2027-03-28T02:00:00');
});

test('recorder zone: wall clock to instant and back, in summer, in winter and without DST', () => {
    assert.equal(iso(zoneCE.instantOf(W('2026-10-24T12:00:00'))), '2026-10-24T10:00:00', 'summer: UTC+2');
    assert.equal(iso(zoneCE.instantOf(W('2026-10-26T12:00:00'))), '2026-10-26T11:00:00', 'winter: UTC+1');
    assert.equal(iso(zoneCE.instantOf(W('2026-10-19T12:00:00'))), '2026-10-19T10:00:00', 'still summer on 19 October');
    for (const t of ['2026-01-10T08:00:00', '2026-07-01T23:30:00', '2026-03-29T03:30:00', '2026-10-25T03:00:00']) {
        const w = W(t);
        assert.equal(zoneCE.wallOf(zoneCE.instantOf(w)), w, `round trip ${t}`);
    }
    // instants across the autumn change map to a monotonic-with-repeat wall clock, never skipping
    const a = zoneCE.wallOf(Date.parse('2026-10-24T23:30:00Z')), b = zoneCE.wallOf(Date.parse('2026-10-25T00:30:00Z'));
    assert.equal(iso(a), '2026-10-25T01:30:00');
    assert.equal(iso(b), '2026-10-25T01:30:00', 'the repeated hour');
    const flat = new RecorderZone({ Time: { timeZone: 18000 }, Dst: { ...CE, enable: 0 } });
    assert.equal(iso(flat.instantOf(W('2026-07-01T12:00:00'))), '2026-07-01T17:00:00', 'UTC-5, no DST');
    assert.throws(() => new RecorderZone({ Time: {} as any }), /time zone unknown/);
});

test('southern hemisphere: summer time spans the new year', () => {
    // first Sunday of October to first Sunday of April, UTC+10 standard
    const z = new RecorderZone({ Time: { timeZone: -36000 }, Dst: { ...CE, startMon: 10, startWeek: 1, endMon: 4, endWeek: 1, endHour: 3 } });
    assert.equal(z.inSummer(W('2026-01-15T12:00:00')), true);
    assert.equal(z.inSummer(W('2026-12-15T12:00:00')), true);
    assert.equal(z.inSummer(W('2026-06-15T12:00:00')), false);
    assert.equal(iso(z.instantOf(W('2026-01-15T12:00:00'))), '2026-01-15T01:00:00');
});

test('PlaybackTime convention is measured: UTC (the library default) or the recorder\'s own clock', () => {
    const files: RawFile[] = JSON.parse(fx('search-events.json'));
    assert.equal(playbackIsUtc(files, zoneCE), true);
    const local = files.map(f => ({ ...f, PlaybackTime: f.StartTime }));
    assert.equal(playbackIsUtc(local, zoneCE), false);
    const none = files.map(({ PlaybackTime, ...f }) => f);
    assert.equal(playbackIsUtc(none, zoneCE), undefined, 'nothing to measure: no vote, the caller keeps its last answer');
    assert.equal(parseSearchFiles(local, 'sub', zoneCE, true)[0].playbackId, '20261030121128', 'a given convention is used as is');
});

test('search rows: instants, the recording\'s own start, playback ids and the offset into the file', () => {
    const files: RawFile[] = JSON.parse(fx('search-events.json'));
    const rows = parseSearchFiles(files, 'sub', zoneCE);
    assert.equal(rows.length, 3);
    const r = rows[0];
    assert.equal(iso(r.start), '2026-10-30T11:11:28');
    assert.equal(iso(r.end), '2026-10-30T11:14:23');
    assert.equal(r.fileStart, r.start);
    assert.equal(r.fileStartId, '20261030121128', 'the recorder wall clock');
    assert.equal(r.playbackId, '20261030111128', 'PlaybackTime as stated (UTC)');
    assert.equal(r.offset, 0);
    assert.equal(r.name, '1-0-0-01260930111128-00000');
    assert.equal(r.size, 22020096);
    // same rows stated in the recorder's clock: the file start is read in the zone, not as UTC
    const local = parseSearchFiles(files.map(f => ({ ...f, PlaybackTime: f.StartTime })), 'sub', zoneCE);
    assert.equal(local[0].fileStart, r.start);
    assert.equal(local[0].playbackId, '20261030121128');
    // no PlaybackTime (Home Hubs): StartTime stands in, in the measured convention
    const derived = parseSearchFiles(files.map(({ PlaybackTime, ...f }) => f), 'sub', zoneCE);
    assert.equal(derived[0].derived, true);
    assert.equal(derived[0].playbackId, '20261030111128');
    // a row clipped to the searched day still addresses its recording, with an offset
    const cont = parseSearchFiles(JSON.parse(fx('search-continuous.json')), 'sub', zoneCE);
    assert.equal(iso(cont[0].start), '2026-10-29T23:00:00');
    assert.equal(iso(cont[0].fileStart), '2026-10-29T22:40:00');
    assert.equal(cont[0].fileStartId, '20261029234000');
    assert.equal(cont[0].offset, 20 * 60);
    // an unreadable row is skipped, not fatal
    assert.equal(parseSearchFiles([...files, { StartTime: {} as any, EndTime: files[0].EndTime }], 'sub', zoneCE).length, 3);
});

test('long recordings split into 5 minute windows, each with its own offset', () => {
    const rows = parseSearchFiles(JSON.parse(fx('search-continuous.json')), 'sub', zoneCE);
    const w = splitRecordings([rows[1]], 5 * 60_000);
    assert.equal(w.length, 6);
    assert.deepEqual(w.map(x => x.offset), [0, 300, 600, 900, 1200, 1500]);
    assert.ok(w.every(x => x.name === rows[1].name && x.fileStartId === rows[1].fileStartId));
    assert.equal(w[5].end, rows[1].end);
    const short = parseSearchFiles(JSON.parse(fx('search-events.json')), 'sub', zoneCE);
    assert.equal(splitRecordings(short, 5 * 60_000).length, 3, 'event recordings stay whole');
});

test('continuous day: measured from coverage of what has elapsed; a day not begun is not continuous', () => {
    const cont = parseSearchFiles(JSON.parse(fx('search-continuous.json')), 'sub', zoneCE);
    const ev = parseSearchFiles(JSON.parse(fx('search-events.json')), 'sub', zoneCE);
    const dayStart = zoneCE.instantOf(W('2026-10-30T00:00:00')), dayEnd = zoneCE.instantOf(W('2026-10-30T23:59:59'));
    assert.equal(isContinuousDay(cont, dayStart, dayEnd, zoneCE.instantOf(W('2026-10-30T01:10:00'))), true);
    assert.equal(isContinuousDay(ev, dayStart, dayEnd, dayEnd), false);
    assert.equal(isContinuousDay(cont, dayStart, dayEnd, dayStart - 3_600_000), false);
});

test('alarm-video search: trigger windows and their classes', () => {
    assert.equal(parseFileHandle(fx('alarm-video-open.xml')), '7');
    const p = parseAlarmVideos(fx('alarm-video-page.xml'));
    assert.equal(p.finished, true);
    assert.equal(p.items.length, 3);
    assert.deepEqual(p.items[0].classes, ['person']);
    assert.deepEqual(p.items[1].classes, ['motion']);
    assert.deepEqual(p.items[2].classes, ['vehicle', 'line_crossing']);
    assert.equal(iso(p.items[2].startWall), '2026-10-30T13:28:34');
    const open = alarmVideoOpenXml(3, 'UIDEXAMPLE', 'sub', W('2026-10-30T00:00:00'), W('2026-10-30T23:59:59'));
    assert.match(open, /<channelId>3<\/channelId>/);
    assert.match(open, /<streamType>1<\/streamType>/);
    assert.match(open, /<startTime>\n<year>2026<\/year>\n<month>10<\/month>\n<day>30<\/day>\n<hour>0<\/hour>/);
});

test('clips: triggers per window, filler dropped only on a continuous day with known triggers', () => {
    const ev = parseSearchFiles(JSON.parse(fx('search-events.json')), 'sub', zoneCE);
    const alarms = parseAlarmVideos(fx('alarm-video-page.xml')).items.map(i => ({ start: zoneCE.instantOf(i.startWall), end: zoneCE.instantOf(i.endWall), classes: i.classes }));
    const clips = buildClips(ev, alarms, false, 0, KEY);
    assert.equal(clips.length, 3, 'an event-recording camera keeps every recording');
    assert.deepEqual(clips[0].detectionClasses, ['person', 'motion']);
    assert.equal(clips[0].event, 'person');
    assert.deepEqual(clips[1].detectionClasses, ['vehicle', 'line_crossing']);
    assert.equal(clips[2].event, 'recording');
    assert.equal(clips[0].duration, 175_000);
    assert.equal(buildClips(ev, alarms, true, 0, KEY).length, 2, 'continuous: the window nothing triggered in is filler');
    assert.equal(buildClips(ev, undefined, true, 0, KEY).length, 3, 'triggers unknown: nothing is dropped');
    const odd = buildClips(ev.map(r => ({ ...r, name: 'other firmware/x.mp4' })), undefined, false, 0, KEY);
    assert.equal(odd.length, 3, 'a name of another shape is still offered');
    assert.equal(decodeClipId(odd[0].id, KEY, 0).name, '', '...played by its PlaybackTime');
    const ref = decodeClipId(clips[1].id, KEY, 0);
    assert.deepEqual({ ...ref }, { channel: 0, stream: 'sub', name: '1-0-0-01260930122833-00000', fileStartId: '20261030132833', playbackId: '20261030122833', offset: 0, duration: 86, startTime: ev[1].start });
});

test('clip ids are signed, bound to their channel, strict about the name, and reject anything malformed', () => {
    const c = { channel: 3, stream: 'main' as const, name: '0-3-0-01260930111128-00000', fileStartId: '20261030121128', playbackId: '20261030111128', offset: 300, duration: 120, startTime: 1793358688000 };
    const id = encodeClipId(c, KEY);
    assert.deepEqual(decodeClipId(id, KEY, 3), c);
    assert.throws(() => decodeClipId(id, KEY, 4), /invalid clip id/, 'another channel');
    assert.throws(() => decodeClipId(id, Buffer.alloc(32, 8), 3), /invalid clip id/, 'another install');
    const forged = (f: (p: string[]) => void) => { const p = id.split('~'); f(p); return p.join('~'); };
    for (const bad of ['', 'r2', forged(p => { p[3] = '0-3-0-01260930111129-00000'; }), forged(p => { p[7] = '999'; }), forged(p => { p[9] = p[9].replace(/./, x => x === 'A' ? 'B' : 'A'); }),
        `r1${id.slice(2)}`, encodeClipId({ ...c, name: 'a&cmd=Logout' }, KEY), encodeClipId({ ...c, stream: 'x' as any }, KEY),
        encodeClipId({ ...c, offset: -1 }, KEY)])
        assert.throws(() => decodeClipId(bad, KEY, 3), /invalid clip id/, bad);
    assert.equal(decodeClipId(encodeClipId({ ...c, duration: 10 * 86_400 }, KEY), KEY, 3).duration, 86_400, 'at most a day');
    assert.equal(decodeClipId(encodeClipId({ ...c, name: '' }, KEY), KEY, 3).name, '', 'the name-less marker');
    for (const n of ['Mp4Record/2026-10-30/RecM01_20261030_121128_121423_6D28808_1A468F9.mp4', '/mnt/sda/X-Y/Mp4Record/2024-08-27/RecM02_DST20240827_090302_090334_0_800_800_033C820000_61B6F0.mp4', '20261030111128'])
        assert.equal(decodeClipId(encodeClipId({ ...c, name: n }, KEY), KEY, 3).name, n, n);
});

test('playback URL carries every parameter the NVR needs; /flv and Download as reolink_aio builds them', () => {
    const t = { host: '192.0.2.10', port: 80, channel: 2, stream: 'sub' as const, name: '1-0-0-01260930111128-00000', fileStartId: '20261030121128', playbackId: '20261030111128', seek: 42.7 };
    const u = new URL(playbackUrl(t, 'TOKEN1'));
    assert.equal(u.pathname, '/cgi-bin/api.cgi');
    assert.deepEqual(Object.fromEntries(u.searchParams), { cmd: 'Playback', channel: '2', type: '1', start: '20261030121128', seek: '42', source: '1-0-0-01260930111128-00000', playbackTime: '20261030111128', token: 'TOKEN1' });
    assert.equal(new URL(playbackUrl({ ...t, stream: 'main', seek: 0 }, 'T')).searchParams.get('type'), '0');
    assert.equal(new URL(playbackUrl({ ...t, stream: 'main', seek: 0 }, 'T')).searchParams.get('seek'), '0', 'seek even at zero');
    assert.equal(flvUrl(t, 1935, 'viewer', 'p&ss'), 'http://192.0.2.10:80/flv?port=1935&app=bcs&stream=playback.bcs&channel=2&type=1&start=1-0-0-01260930111128-00000&seek=42&user=viewer&password=p&ss');
    assert.match(flvUrl({ ...t, name: 'Mp4Record/2026-10-30/RecM01_20261030_121128_121423_6D28808_1A468F9.mp4' }, 1935, 'viewer', 'x'), /&start=Mp4Record%2F2026-10-30%2FRecM01_/, 'the name is percent-encoded');
    assert.match(flvUrl({ ...t, name: 'a b&c' }, 1935, 'viewer', 'x'), /&start=20261030111128&/, 'an unknown shape is played by its PlaybackTime');
    assert.equal(new URL(playbackUrl({ ...t, name: '' }, 'T')).searchParams.get('source'), '20261030111128');
    for (const pw of ['p ss', 'p"ss', "p'ss"]) assert.throws(() => flvUrl(t, 1935, 'viewer', pw), /cannot carry a username or password/);
    assert.equal(downloadUrl(t, 'T'), 'http://192.0.2.10:80/cgi-bin/api.cgi?cmd=Download&source=1-0-0-01260930111128-00000&output=recording.mp4&token=T');
});

test('ffmpeg input: genpts, a duration bounds the read, a whole file is seeked by ffmpeg', () => {
    const w = ['-protocol_whitelist', 'http,tcp', '-fflags', '+genpts'];
    assert.deepEqual(recordingInputArgs('playback', 'http://x/', 30), [...w, '-i', 'http://x/']);
    assert.deepEqual(recordingInputArgs('playback', 'http://x/', 30, 20), [...w, '-t', '20.000', '-i', 'http://x/']);
    assert.deepEqual(recordingInputArgs('download', 'http://x/', 30, 20), [...w, '-ss', '30.000', '-t', '20.000', '-i', 'http://x/']);
    const th = thumbnailArgs(['-i', 'u']);
    assert.ok(th.includes('scale=320:-2') && th.includes('-frames:v') && th.at(-1) === 'pipe:1');
});

test('messages are scrubbed of URL queries (tokens, passwords)', () => {
    const s = scrubUrls('Server returned 404 for http://192.0.2.10:80/flv?user=viewer&password=secret and rtmp://h/x?token=abc.');
    assert.ok(!/secret|abc|viewer/.test(s), s);
    assert.match(s, /http:\/\/192\.0\.2\.10\/flv/);
    const t = scrubUrls('Option user=viewer password=s3cr&t=x failed; stderr quoted s3cr&t=x and token=abc', ['s3cr&t=x']);
    assert.ok(!/viewer|s3cr|abc/.test(t), t);
    assert.match(t, /user=\*\*\* password=\*\*\*/);
});

test('time ids, recorder days and night mode', () => {
    assert.equal(timeId(W('2026-03-05T07:08:09')), '20260305070809');
    assert.equal(parseTimeId('20260305070809'), W('2026-03-05T07:08:09'));
    assert.throws(() => wallMs({ year: 2026, mon: 13, day: 1, hour: 0, min: 0, sec: 0 }));
    const days = recorderDays(zoneCE, Date.parse('2026-10-24T23:30:00Z'), Date.parse('2026-10-26T10:00:00Z'));
    assert.deepEqual(days.map(d => iso(d).slice(0, 10)), ['2026-10-25', '2026-10-26']);
    assert.equal(recorderDays(zoneCE, 0, 90 * 86_400_000).length, 31, 'capped');
    assert.equal(isNight('night'), true);
    assert.equal(isNight('day'), false);
    assert.equal(isNight('led_day'), false, 'colour with the spotlight on');
    assert.equal(isNight(undefined), undefined);
});

test('the hour repeated in autumn is decided by row order, whatever PlaybackTime says', () => {
    // POSIX rules: summer time ends at 03:00 summer time, so 02:00-03:00 happens twice
    const z = new RecorderZone({ Time: { timeZone: -3600 }, Dst: { ...CE, endHour: 3 } });
    assert.equal(z.ambiguous(W('2026-10-25T02:40:00')), true);
    assert.equal(z.ambiguous(W('2026-10-25T03:40:00')), false);
    const T = (h: number, m: number) => ({ year: 2026, mon: 10, day: 25, hour: h, min: m, sec: 0 });
    const rows = [[T(2, 0), T(2, 40)], [T(2, 40), T(2, 10)], [T(2, 10), T(2, 30)]];
    const expect = [['00:00', '00:40'], ['00:40', '01:10'], ['01:10', '01:30']];
    for (const [label, pb, conv] of [['local PlaybackTime', true, false], ['no PlaybackTime', false, undefined], ['UTC PlaybackTime', 'utc', true]] as const) {
        const raw = rows.map(([s, e], i) => ({ StartTime: s, EndTime: e, name: `1-0-0-0126092500000${i}-00000`,
            ...(pb === true ? { PlaybackTime: s } : pb === 'utc' ? { PlaybackTime: { ...s, hour: [0, 0, 1][i], min: s.min } } : {}) }));
        const out = parseSearchFiles(raw as any, 'sub', z, conv);
        assert.deepEqual(out.map(r => [iso(r.start).slice(11, 16), iso(r.end).slice(11, 16)]), expect, label);
        assert.ok(out.every(r => r.end >= r.start && r.start >= r.fileStart), label);
        assert.ok(out.every(r => r.offset === 0), label);
    }
});

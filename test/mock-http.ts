import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';

/** Minimal Reolink JSON API: Login/Logout with tokens, a few Get* commands, Snap. */
export class MockHttpNvr {
    server?: Server;
    port = 0;
    user = 'viewer';
    password = 'example-pass';
    leaseTime = 3600;
    tokens = new Set<string>();
    logins = 0;
    logouts = 0;
    calls: string[] = [];
    failLogin = false;
    private n = 0;

    async start() {
        this.server = createServer((req, res) => this.handle(req).then(([type, body, status]) => {
            res.writeHead(status ?? 200, { 'Content-Type': type });
            res.end(body);
        }));
        await new Promise<void>(r => this.server!.listen(0, '127.0.0.1', r));
        this.port = (this.server!.address() as AddressInfo).port;
    }

    stop() { return new Promise<void>(r => this.server!.close(() => r())); }

    /** GetAiState in a POST body fails with -99 and works only as a GET (as some NVR firmware does). */
    aiOnlyGet = false;

    /** GetTime answer (Central European rules, standard time). */
    time: any = { Dst: { enable: 1, offset: 1, startMon: 3, startWeek: 5, startWeekday: 0, startHour: 2, startMin: 0, startSec: 0, endMon: 10, endWeek: 5, endWeekday: 0, endHour: 2, endMin: 0, endSec: 0 }, Time: { timeZone: -3600, year: 2026, mon: 10, day: 31, hour: 12, min: 0, sec: 0 } };
    /** Search rows per `<channel>|<stream>`, filtered by the asked window as the NVR does. */
    files = new Map<string, any[]>();
    searches: any[] = [];
    /** HTTP status of cmd=Playback, /flv and cmd=Download GETs. */
    routeStatus: Record<string, number> = { Playback: 200, flv: 200, Download: 200 };
    /** Query strings of every playback GET, in order. */
    playbacks: { route: string; query: URLSearchParams }[] = [];

    /** Simulates the device dropping all sessions (e.g. lease expiry on the NVR). */
    expireAll() { this.tokens.clear(); }

    private async handle(req: IncomingMessage): Promise<[string, string | Buffer, number?]> {
        const u = new URL(req.url!, 'http://x');
        // /flv authenticates with the account in the query, not a token
        if (u.pathname === '/flv') {
            this.playbacks.push({ route: 'flv', query: u.searchParams });
            const ok = u.searchParams.get('user') === this.user && u.searchParams.get('password') === this.password;
            const st = ok ? this.routeStatus.flv : 401;
            return st === 200 ? ['video/x-flv', Buffer.from('FLV\x01')] : ['text/plain', '', st];
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
        const cmd = u.searchParams.get('cmd')!;
        const json = (x: unknown): [string, string] => ['application/json', JSON.stringify(x)];
        if (cmd === 'Login') {
            const U = body[0].param.User;
            if (this.failLogin || U.userName !== this.user || U.password !== this.password)
                return json([{ cmd, code: 1, error: { rspCode: -7, detail: 'login failed' } }]);
            this.logins++;
            const t = `tok${++this.n}`;
            this.tokens.add(t);
            return json([{ cmd, code: 0, value: { Token: { name: t, leaseTime: this.leaseTime } } }]);
        }
        const tok = u.searchParams.get('token') ?? '';
        if (cmd === 'Logout') {
            if (this.tokens.delete(tok)) this.logouts++;
            return json([{ cmd, code: 0, value: { rspCode: 200 } }]);
        }
        if (!this.tokens.has(tok))
            return json([{ cmd, code: 1, error: { rspCode: -6, detail: 'please login first' } }]);
        // firmware that answers GetAiState only as a GET: the POST body form gets -99
        if (cmd === 'GetAiState' && req.method === 'GET') {
            this.calls.push('GetAiState(GET)');
            const ch = Number(u.searchParams.get('channel'));
            return json([{ cmd, code: 0, value: { channel: ch, people: { support: 1, alarm_state: 0 }, vehicle: { support: 0, alarm_state: 0 }, dog_cat: { support: 1, alarm_state: 0 } } }]);
        }
        if (cmd === 'Playback' || cmd === 'Download') {
            this.playbacks.push({ route: cmd, query: u.searchParams });
            // a real NVR answers nothing, or 404, when one of these is missing
            const missing = cmd === 'Playback' && ['channel', 'type', 'start', 'seek', 'source', 'playbackTime'].some(k => !u.searchParams.get(k));
            const st = missing ? 404 : this.routeStatus[cmd];
            return st === 200 ? (cmd === 'Playback' ? ['video/x-flv', Buffer.from('FLV\x01')] : ['video/mp4', Buffer.from('\0\0\0\x18ftypmp42')]) : ['text/plain', '', st];
        }
        if (cmd === 'Snap') {
            this.calls.push('Snap');
            return ['image/jpeg', Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9])];
        }
        const out = (body as any[]).map(c => {
            this.calls.push(c.cmd);
            const ch = c.param?.channel;
            switch (c.cmd) {
                case 'GetDevInfo': return { cmd: c.cmd, code: 0, value: { DevInfo: { model: 'NVR-TEST', exactType: 'NVR', channelNum: 8 } } };
                case 'GetChannelstatus': return { cmd: c.cmd, code: 0, value: { count: 8, status: [{ channel: 0, name: 'Cam A', online: 1, typeInfo: 'RLC-810A', uid: 'x' }, { channel: 2, name: 'Cam B', online: 1, typeInfo: 'CAM-TEST', uid: 'y' }, { channel: 5, online: 0, uid: '' }] } };
                case 'GetAbility': return { cmd: c.cmd, code: 0, value: { Ability: { abilityChn: [{ live: { ver: 1 }, supportAudioAlarm: { ver: 1 } }, {}, { live: { ver: 1 }, floodLight: { ver: 1 } }] } } };
                case 'GetChnTypeInfo': return { cmd: c.cmd, code: 0, value: { typeInfo: ch === 2 ? 'CAM-TEST' : 'RLC-810A', firmVer: 'v1' } };
                case 'GetEnc': return { cmd: c.cmd, code: 0, value: { Enc: { channel: ch, mainStream: { width: 3840, height: 2160, vType: 'h264' } } } };
                case 'GetAiState': return this.aiOnlyGet ? { cmd: c.cmd, code: 1, error: { rspCode: -99, detail: 'device offline' } } : { cmd: c.cmd, code: 0, value: { channel: ch, people: { support: 1, alarm_state: 0 }, vehicle: { support: 1, alarm_state: 0 }, dog_cat: { support: 0, alarm_state: 0 } } };
                case 'AudioAlarmPlay': case 'SetWhiteLed': return { cmd: c.cmd, code: 0, value: { rspCode: 200 } };
                case 'GetTime': return { cmd: c.cmd, code: 0, value: this.time };
                case 'Search': {
                    const q = c.param.Search;
                    this.searches.push(q);
                    const key = (t: any) => t.year * 1e10 + t.mon * 1e8 + t.day * 1e6 + t.hour * 1e4 + t.min * 100 + t.sec;
                    const rows = (this.files.get(`${q.channel}|${q.streamType}`) ?? []).filter(f => key(f.EndTime) >= key(q.StartTime) && key(f.StartTime) <= key(q.EndTime));
                    return { cmd: c.cmd, code: 0, value: { SearchResult: { channel: q.channel, Status: [{ mon: q.StartTime.mon, year: q.StartTime.year, table: '0'.repeat(31) }], ...(rows.length ? { File: rows } : {}) } } };
                }
                default: return { cmd: c.cmd, code: 1, error: { rspCode: -9, detail: 'not supported' } };
            }
        });
        return json(out);
    }
}

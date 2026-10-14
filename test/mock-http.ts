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
        this.server = createServer((req, res) => this.handle(req).then(([type, body]) => {
            res.writeHead(200, { 'Content-Type': type });
            res.end(body);
        }));
        await new Promise<void>(r => this.server!.listen(0, '127.0.0.1', r));
        this.port = (this.server!.address() as AddressInfo).port;
    }

    stop() { return new Promise<void>(r => this.server!.close(() => r())); }

    /** Simulates the device dropping all sessions (e.g. lease expiry on the NVR). */
    expireAll() { this.tokens.clear(); }

    private async handle(req: IncomingMessage): Promise<[string, string | Buffer]> {
        const u = new URL(req.url!, 'http://x');
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
                case 'GetAiState': return { cmd: c.cmd, code: 0, value: { channel: ch, people: { support: 1, alarm_state: 0 }, vehicle: { support: 1, alarm_state: 0 }, dog_cat: { support: 0, alarm_state: 0 } } };
                case 'AudioAlarmPlay': case 'SetWhiteLed': return { cmd: c.cmd, code: 0, value: { rspCode: 200 } };
                default: return { cmd: c.cmd, code: 1, error: { rspCode: -9, detail: 'not supported' } };
            }
        });
        return json(out);
    }
}

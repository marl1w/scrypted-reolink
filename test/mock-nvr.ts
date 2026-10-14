import { createServer, Server, Socket } from 'node:net';
import { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cmd, MsgClass } from '../src/baichuan/constants';
import { aesDecrypt, aesEncrypt, bcXor, deriveAesKey, md5m } from '../src/baichuan/crypto';
import { encodeFrame, Frame, FrameDecoder } from '../src/baichuan/frame';

export const fixture = (n: string) => readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', n), 'utf8');

const ok = Buffer.from([0xc8, 0x00]);
const st = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

/** Minimal Baichuan device for tests: nonce, login check, subscribe, keep-alive, logout, pushes. */
export class MockNvr {
    server?: Server;
    port = 0;
    nonce = 'ABCDEF0123456789';
    user = 'viewer';
    password = 'example-pass';
    /** When true, requests after login get no reply at all (dead session). */
    mute = false;
    log: string[] = [];
    logins = 0;
    sockets = new Set<Socket>();
    private key = deriveAesKey(this.nonce, this.password);

    async start() {
        this.server = createServer(s => this.onSocket(s));
        await new Promise<void>(r => this.server!.listen(0, '127.0.0.1', r));
        this.port = (this.server!.address() as AddressInfo).port;
    }

    async stop() {
        for (const s of this.sockets) s.destroy();
        await new Promise<void>(r => this.server!.close(() => r()));
    }

    dropAll() {
        for (const s of this.sockets) s.destroy();
    }

    push(xml: string) {
        for (const s of this.sockets)
            s.write(encodeFrame({ cmd: Cmd.AlarmEvent, chId: 251, msgId: 0, cls: MsgClass.Modern0, statusBytes: ok, body: aesEncrypt(this.key, Buffer.from(xml)) }));
    }

    private onSocket(s: Socket) {
        this.sockets.add(s);
        s.on('close', () => this.sockets.delete(s));
        s.on('error', () => { });
        const dec = new FrameDecoder();
        s.on('data', d => { for (const f of dec.push(d)) this.onFrame(s, f); });
    }

    private reply(s: Socket, f: Frame, status: Buffer, body?: Buffer) {
        s.write(encodeFrame({ cmd: f.cmd, chId: f.chId, msgId: f.msgId, cls: MsgClass.Modern0, statusBytes: status, body }));
    }

    private onFrame(s: Socket, f: Frame) {
        this.log.push(`cmd${f.cmd}`);
        if (f.cmd === Cmd.Login && f.cls === MsgClass.Legacy) {
            const xml = `<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<Encryption version="1.1">\n<type>md5</type>\n<nonce>${this.nonce}</nonce>\n</Encryption>\n</body>\n`;
            s.write(encodeFrame({ cmd: 1, chId: f.chId, msgId: f.msgId, cls: MsgClass.Modern20, statusBytes: Buffer.from([0x01, 0xdd]), body: bcXor(Buffer.from(xml), f.chId) }));
            return;
        }
        if (f.cmd === Cmd.Login) {
            const xml = bcXor(f.body, f.chId).toString();
            const good = xml.includes(`<userName>${md5m(this.user + this.nonce)}</userName>`) && xml.includes(`<password>${md5m(this.password + this.nonce)}</password>`);
            if (!good) return this.reply(s, f, st(401));
            this.logins++;
            return this.reply(s, f, ok, aesEncrypt(this.key, Buffer.from(fixture('login-reply.xml'))));
        }
        if (this.mute) return;
        if (f.cmd === Cmd.Logout) {
            const xml = aesDecrypt(this.key, f.body).toString();
            this.log.push(xml.includes(`<userName>${this.user}</userName>`) ? 'logout-ok' : 'logout-bad');
            this.reply(s, f, ok);
            s.end();
            return;
        }
        // Real NVRs (observed on NVR firmware) answer the subscription with 402 and push events anyway.
        if (f.cmd === Cmd.AlarmSubscribe)
            return this.reply(s, f, st(402));
        if (f.cmd === Cmd.LinkType)
            return this.reply(s, f, ok);
        this.reply(s, f, st(400));
    }
}

import { EventEmitter } from 'node:events';
import { Socket, connect as netConnect } from 'node:net';
import { ChId, Cmd, DEFAULT_PORT, MsgClass, Status } from './constants';
import { aesDecrypt, aesEncrypt, bcXor, deriveAesKey, loginHashes } from './crypto';
import { encodeFrame, Frame, FrameDecoder, messagePart } from './frame';
import { buildBody, childText, findFirst, parseXml } from './xml';

export class BaichuanError extends Error {
    constructor(message: string, readonly status?: number) { super(message); }
}
/** Bad credentials (status 401 on login). Retrying will not help. */
export class AuthError extends BaichuanError { }
export class TimeoutError extends BaichuanError { }
export class ClosedError extends BaichuanError { }

export interface Reply {
    frame: Frame;
    xml: string;
}

export interface DeviceInfo {
    type?: string;
    channelNum?: number;
    /** All direct text fields of <DeviceInfo>, for diagnostics. */
    fields: Record<string, string>;
}

export interface ConnectionOptions {
    host: string;
    port?: number;
    username: string;
    password: string;
    connectTimeoutMs?: number;
    requestTimeoutMs?: number;
}

interface Pending {
    cmd: number;
    msgId: number;
    resolve: (r: Reply) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
}

/**
 * One Baichuan TCP session: connect, nonce/login, requests matched by (cmd, msgId), pushes, logout.
 * No reconnection logic here; see BaichuanClient for supervision.
 *
 * Events: 'push' (frame, xml), 'rx' (frame) for every received frame, 'close' (error?).
 */
export class BaichuanConnection extends EventEmitter {
    private socket?: Socket;
    private decoder = new FrameDecoder();
    private pending = new Set<Pending>();
    private msgId = 0;
    private aesKey?: Buffer;
    private closed = false;
    loggedIn = false;
    nonce?: string;

    constructor(readonly opts: ConnectionOptions) {
        super();
    }

    get isClosed() { return this.closed; }

    connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const s = netConnect({ host: this.opts.host, port: this.opts.port ?? DEFAULT_PORT });
            this.socket = s;
            s.setNoDelay(true);
            s.setKeepAlive(true, 15000);
            const t = setTimeout(() => {
                s.destroy();
                reject(new TimeoutError('connect timeout'));
            }, this.opts.connectTimeoutMs ?? 10000);
            s.once('connect', () => {
                clearTimeout(t);
                resolve();
            });
            s.on('data', d => this.onData(d));
            s.on('error', e => {
                clearTimeout(t);
                reject(e);
                this.shutdown(e);
            });
            s.on('close', () => {
                clearTimeout(t);
                reject(new ClosedError('socket closed'));
                this.shutdown();
            });
        });
    }

    private nextMsgId() {
        this.msgId = (this.msgId + 1) % 0x1000000;
        return this.msgId;
    }

    private onData(d: Buffer) {
        let frames: Frame[];
        try {
            frames = this.decoder.push(d);
        }
        catch (e) {
            this.destroy(e as Error);
            return;
        }
        for (const f of frames)
            this.onFrame(f);
    }

    private onFrame(f: Frame) {
        this.emit('rx', f);
        if (f.cmd === Cmd.UdpHeartbeat && f.body.length === 0) {
            // reolink_aio answers heartbeats with an empty header echoing the message id.
            this.write(encodeFrame({ cmd: Cmd.UdpHeartbeat, chId: f.chId, msgId: f.msgId, cls: MsgClass.Modern }));
            return;
        }
        let p = [...this.pending].find(x => x.cmd === f.cmd && x.msgId === f.msgId);
        if (!p && f.cmd !== Cmd.AlarmEvent) {
            const sameCmd = [...this.pending].filter(x => x.cmd === f.cmd);
            if (sameCmd.length === 1) p = sameCmd[0];
        }
        if (p) {
            this.pending.delete(p);
            clearTimeout(p.timer);
            const hl24 = f.cls === MsgClass.Modern || f.cls === MsgClass.Modern0;
            if (hl24 && ![Status.Ok, Status.Ok201, Status.Ok300].includes(f.status as any)) {
                const E = f.status === Status.Unauthorized ? AuthError : BaichuanError;
                p.reject(new E(`cmd ${f.cmd}: status ${f.status}`, f.status));
                return;
            }
            let xml = '';
            try { xml = this.decodeBody(f); } catch { /* keep empty */ }
            p.resolve({ frame: f, xml });
            return;
        }
        let xml = '';
        try { xml = this.decodeBody(f); } catch { /* ignore */ }
        this.emit('push', f, xml);
    }

    /** Decrypts the XML part of a frame (mirrors reolink_aio's _decrypt with fallbacks). */
    decodeBody(f: Frame): string {
        const part = messagePart(f);
        if (part.length === 0) return '';
        const isXml = (s: string) => s.startsWith('<?xml');
        const xor = () => bcXor(part, f.chId).toString('utf8');
        if (!this.aesKey || (f.cls !== MsgClass.Modern && f.cls !== MsgClass.Modern0 && (f.encHex === '01dd' || f.encHex === '12dd')))
            return xor();
        if (f.encHex === '00dd' && part.subarray(0, 5).toString() === '<?xml')
            return part.toString('utf8');
        const a = aesDecrypt(this.aesKey, part).toString('utf8');
        if (isXml(a)) return a;
        const x = xor();
        if (isXml(x)) return x;
        const plain = part.toString('utf8');
        if (isXml(plain)) return plain;
        throw new BaichuanError(`cmd ${f.cmd}: undecodable body`);
    }

    private write(b: Buffer) {
        if (this.closed || !this.socket) throw new ClosedError('not connected');
        this.socket.write(b);
    }

    /** Sends a frame and waits for the reply with the same cmd and message id. */
    request(cmd: number, opts: { chId?: number; body?: Buffer; cls?: string; timeoutMs?: number } = {}): Promise<Reply> {
        return new Promise((resolve, reject) => {
            if (this.closed) return reject(new ClosedError('connection closed'));
            const msgId = this.nextMsgId();
            const p: Pending = {
                cmd, msgId, resolve, reject,
                timer: setTimeout(() => {
                    this.pending.delete(p);
                    reject(new TimeoutError(`cmd ${cmd}: no reply`));
                }, opts.timeoutMs ?? this.opts.requestTimeoutMs ?? 10000),
            };
            this.pending.add(p);
            try {
                this.write(encodeFrame({ cmd, chId: opts.chId ?? ChId.Host, msgId, cls: opts.cls, body: opts.body }));
            }
            catch (e) {
                this.pending.delete(p);
                clearTimeout(p.timer);
                reject(e);
            }
        });
    }

    /** Encrypts an XML body with the session's AES key (after login). */
    private aes(xml: string): Buffer {
        if (!this.aesKey) throw new BaichuanError('not logged in');
        return aesEncrypt(this.aesKey, Buffer.from(xml, 'utf8'));
    }

    /** Modern nonce login (verified live against NVRs): returns the DeviceInfo from the reply. */
    async login(): Promise<DeviceInfo> {
        const n = await this.request(Cmd.Login, { cls: MsgClass.Legacy });
        const nonceDoc = n.xml ? parseXml(n.xml) : undefined;
        const enc = nonceDoc && findFirst(nonceDoc, 'Encryption');
        const nonce = enc ? childText(enc, 'nonce') : undefined;
        if (!nonce) throw new BaichuanError('no nonce in login challenge (legacy-only device?)');
        if (enc && childText(enc, 'sigVer') === 'v3')
            throw new AuthError('device requires cloud-account login (sigVer v3); local login unsupported');
        this.nonce = nonce;
        const h = loginHashes(this.opts.username, this.opts.password, nonce);
        const xml = buildBody({
            LoginUser: { userName: h.userName, password: h.password, userVer: 1 },
            LoginNet: { type: 'LAN', udpPort: 0 },
        });
        this.aesKey = deriveAesKey(nonce, this.opts.password);
        let r: Reply;
        try {
            r = await this.request(Cmd.Login, { body: bcXor(Buffer.from(xml, 'utf8'), ChId.Host) });
        }
        catch (e) {
            this.aesKey = undefined;
            throw e;
        }
        this.loggedIn = true;
        return parseDeviceInfo(r.xml);
    }

    /**
     * Subscribe to alarm pushes (cmd 31, ch_id 251, empty body). NVRs answer 402 and still push events,
     * so any status reply counts as subscribed; only a missing reply (timeout, closed socket) fails.
     */
    async subscribe(): Promise<void> {
        try {
            await this.request(Cmd.AlarmSubscribe, { chId: ChId.Push });
        }
        catch (e) {
            if (e instanceof BaichuanError && e.status !== undefined && !(e instanceof AuthError)) return;
            throw e;
        }
    }

    /** LinkType request, used as keep-alive. Any reply (even an error status) proves the session is alive. */
    async keepAlive(timeoutMs?: number): Promise<void> {
        try {
            await this.request(Cmd.LinkType, { timeoutMs });
        }
        catch (e) {
            if (e instanceof BaichuanError && e.status !== undefined) return;
            throw e;
        }
    }

    /** Logout (cmd 2, AES body with the plain credentials, as the official clients send) and close. */
    async logout(timeoutMs = 3000): Promise<void> {
        if (this.loggedIn && !this.closed) {
            const xml = buildBody({ LoginUser: { userName: this.opts.username, password: this.opts.password, userVer: 1 } });
            try {
                await this.request(Cmd.Logout, { body: this.aes(xml), timeoutMs });
            }
            catch { /* best effort */ }
            this.loggedIn = false;
        }
        this.destroy();
    }

    destroy(err?: Error) {
        this.socket?.destroy();
        this.shutdown(err);
    }

    private shutdown(err?: Error) {
        if (this.closed) return;
        this.closed = true;
        this.loggedIn = false;
        for (const p of this.pending) {
            clearTimeout(p.timer);
            p.reject(new ClosedError('connection closed'));
        }
        this.pending.clear();
        this.emit('close', err);
    }
}

export function parseDeviceInfo(xml: string): DeviceInfo {
    const fields: Record<string, string> = {};
    if (!xml) return { fields };
    try {
        const di = findFirst(parseXml(xml), 'DeviceInfo');
        for (const c of di?.children ?? [])
            if (!c.children.length) fields[c.name] = c.text.trim();
    }
    catch { /* tolerate */ }
    const cn = fields.channelNum;
    return { type: fields.type, channelNum: cn && /^\d+$/.test(cn) ? parseInt(cn, 10) : undefined, fields };
}

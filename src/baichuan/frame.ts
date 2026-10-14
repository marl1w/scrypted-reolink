import { ENC_REQUEST_AES, headerLength, MAGIC, MsgClass } from './constants';

export interface Frame {
    cmd: number;
    /** Header byte 12: 250 host, 251 push, channel+1 for a channel. */
    chId: number;
    /** 24-bit message number (header bytes 13-15). */
    msgId: number;
    /** Header bytes 16-17 as little-endian u16: the status code on replies (200, 401...). */
    status: number;
    /** Header bytes 16-17 as hex, e.g. "12dc", "01dd", "c800". */
    encHex: string;
    /** Message class as hex: "1464", "1465", "1466", "0000". */
    cls: string;
    /** 24-byte headers only; 0 when absent. */
    payloadOffset: number;
    /** Everything after the header (still encrypted). */
    body: Buffer;
}

export interface FrameInit {
    cmd: number;
    chId: number;
    msgId: number;
    cls?: string;
    body?: Buffer;
    payloadOffset?: number;
    /** Overrides bytes 16-17 (requests: 12dc for legacy, 0000 for modern). */
    statusBytes?: Buffer;
}

export function encodeFrame(f: FrameInit): Buffer {
    const cls = f.cls ?? MsgClass.Modern;
    const body = f.body ?? Buffer.alloc(0);
    const hl = headerLength(cls);
    const h = Buffer.alloc(hl);
    MAGIC.copy(h, 0);
    h.writeUInt32LE(f.cmd >>> 0, 4);
    h.writeUInt32LE(body.length, 8);
    h.writeUInt8(f.chId & 0xff, 12);
    h.writeUIntLE(f.msgId & 0xffffff, 13, 3);
    const st = f.statusBytes ?? (cls === MsgClass.Legacy ? ENC_REQUEST_AES : Buffer.alloc(2));
    st.copy(h, 16, 0, 2);
    Buffer.from(cls, 'hex').copy(h, 18);
    if (hl === 24)
        h.writeUInt32LE(f.payloadOffset ?? 0, 20);
    return Buffer.concat([h, body]);
}

export class FrameError extends Error { }

/** Incremental decoder for a TCP byte stream. */
export class FrameDecoder {
    private buf: Buffer = Buffer.alloc(0);
    static readonly MAX_BODY = 8 * 1024 * 1024;

    push(chunk: Buffer): Frame[] {
        this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
        const out: Frame[] = [];
        for (;;) {
            if (this.buf.length < 20)
                break;
            if (!this.buf.subarray(0, 4).equals(MAGIC)) {
                // Resynchronise on the next magic rather than tearing the session down.
                const idx = this.buf.indexOf(MAGIC, 1);
                if (idx < 0) {
                    this.buf = this.buf.subarray(this.buf.length - 3);
                    throw new FrameError('bad magic');
                }
                this.buf = this.buf.subarray(idx);
                continue;
            }
            const cls = this.buf.subarray(18, 20).toString('hex');
            if (![MsgClass.Legacy, MsgClass.Modern20, MsgClass.Modern, MsgClass.Modern0].includes(cls as any))
                throw new FrameError(`unknown message class ${cls}`);
            const hl = headerLength(cls);
            if (this.buf.length < hl)
                break;
            const len = this.buf.readUInt32LE(8);
            if (len > FrameDecoder.MAX_BODY)
                throw new FrameError(`body too large: ${len}`);
            if (this.buf.length < hl + len)
                break;
            out.push({
                cmd: this.buf.readUInt32LE(4),
                chId: this.buf[12],
                msgId: this.buf.readUIntLE(13, 3),
                status: this.buf.readUInt16LE(16),
                encHex: this.buf.subarray(16, 18).toString('hex'),
                cls,
                payloadOffset: hl === 24 ? this.buf.readUInt32LE(20) : 0,
                body: Buffer.from(this.buf.subarray(hl, hl + len)),
            });
            this.buf = this.buf.subarray(hl + len);
        }
        return out;
    }

    reset() {
        this.buf = Buffer.alloc(0);
    }
}

/** The XML part of a frame body: everything before payload_offset (or all of it). */
export function messagePart(f: Frame): Buffer {
    return f.payloadOffset > 0 && f.payloadOffset <= f.body.length ? f.body.subarray(0, f.payloadOffset) : f.body;
}

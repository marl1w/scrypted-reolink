import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { AES_IV, XOR_KEY } from './constants';

/** Reolink's credential hash: MD5 hex, first 31 characters, upper case. */
export function md5m(s: string): string {
    return createHash('md5').update(s, 'utf8').digest('hex').slice(0, 31).toUpperCase();
}

/** "BC" XOR obfuscation; symmetric. The offset is the frame's ch_id. */
export function bcXor(data: Buffer, offset: number): Buffer {
    const out = Buffer.allocUnsafe(data.length);
    for (let i = 0; i < data.length; i++)
        out[i] = data[i] ^ XOR_KEY[(offset + i) % 8] ^ (offset & 0xff);
    return out;
}

/** AES-128 key: ASCII of md5m(nonce + "-" + password), first 16 characters (verified live). */
export function deriveAesKey(nonce: string, password: string): Buffer {
    return Buffer.from(md5m(`${nonce}-${password}`).slice(0, 16), 'ascii');
}

/** AES-128-CFB128 with the fixed IV; a fresh cipher per message. */
export function aesEncrypt(key: Buffer, data: Buffer): Buffer {
    const c = createCipheriv('aes-128-cfb', key, AES_IV);
    return Buffer.concat([c.update(data), c.final()]);
}

export function aesDecrypt(key: Buffer, data: Buffer): Buffer {
    const d = createDecipheriv('aes-128-cfb', key, AES_IV);
    return Buffer.concat([d.update(data), d.final()]);
}

export function loginHashes(user: string, password: string, nonce: string) {
    return { userName: md5m(user + nonce), password: md5m(password + nonce) };
}

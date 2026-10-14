// Baichuan (Reolink "BC", TCP 9000) protocol constants.
// Behavioural reference: reolink_aio (MIT). Values marked "verified" were confirmed against a live NVR.

export const MAGIC = Buffer.from([0xf0, 0xde, 0xbc, 0x0a]);
export const DEFAULT_PORT = 9000;

export const Cmd = {
    Login: 1, // verified
    Logout: 2, // verified
    AlarmSubscribe: 31,
    AlarmUnsubscribe: 32,
    AlarmEvent: 33,
    LinkType: 93, // used as keep-alive, as reolink_aio does
    UdpHeartbeat: 234,
} as const;

// Message class, header bytes 18-19 read as hex.
export const MsgClass = {
    Legacy: '1465', // 20-byte header, used only for the nonce request (verified)
    Modern20: '1466', // 20-byte header
    Modern: '1464', // 24-byte header with payload offset (verified)
    Modern0: '0000', // 24-byte header, seen on device replies
} as const;

export function headerLength(cls: string): number {
    return cls === MsgClass.Modern || cls === MsgClass.Modern0 ? 24 : 20;
}

// ch_id (header byte 12)
export const ChId = {
    Host: 250,
    Push: 251,
} as const;

/** Header bytes 16-17 of the legacy nonce request: "please negotiate AES". */
export const ENC_REQUEST_AES = Buffer.from([0x12, 0xdc]);

export const XOR_KEY = [0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff];
export const AES_IV = Buffer.from('0123456789abcdef', 'ascii');

export const Status = {
    Ok: 200,
    Ok201: 201,
    Ok300: 300,
    BadRequest: 400,
    Unauthorized: 401,
} as const;

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" ?>';

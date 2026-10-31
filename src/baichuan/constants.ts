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
    LocalLink: 76, // IP and MAC (verified; per channel the NVR answers with its own MAC)
    HostVersionInfo: 80, // VersionInfo of the device itself (verified)
    LinkType: 93, // used as keep-alive, as reolink_aio does
    Uid: 114, // the device's UID (verified)
    AudioAlarmPlay: 263, // siren, as reolink_aio's AudioAlarmPlay
    FloodlightManual: 288, // floodlight on/off, as reolink_aio's set_floodlight
    FloodlightStatus: 291, // push: floodlight state per channel
    SirenStatus: 547, // push: siren state per channel, also when the camera sounds it itself (reolink_aio, HA's siren entity)
    VersionInfo: 318, // VersionInfo of one channel's camera, with its serial number (verified)
    UdpHeartbeat: 234,
    Record: 81, // a channel's recording switch, `enable` (verified, guest)
    Support: 199, // abilities per channel, `smartAI` bits (verified, guest)
    DayNight: 296, // a channel's day/night state, `stat` (verified, guest)
    AlarmVideoOpen: 272, // alarm-video search: open, returns a file handle (verified, guest)
    AlarmVideoNext: 273, // alarm-video search: next page of trigger windows (verified, guest)
    AlarmVideoClose: 274, // alarm-video search: close the handle (verified, guest)
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

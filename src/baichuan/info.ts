import { childText, findFirst, parseXml } from './xml';

// Identity replies (verified live against NVRs, guest-safe: no HTTP login involved).
// cmd 318 per channel and cmd 80 for the host answer <VersionInfo>, cmd 114 <Uid>, cmd 76 <Ip> with the MAC.

export interface VersionInfo {
    type?: string;
    serialNumber?: string;
    firmwareVersion?: string;
    hardwareVersion?: string;
}

function section(xml: string, tag: string) {
    if (!xml) return undefined;
    try { return findFirst(parseXml(xml), tag); }
    catch { return undefined; }
}

export function parseVersionInfo(xml: string): VersionInfo {
    const v = section(xml, 'VersionInfo');
    return {
        type: childText(v, 'type'),
        serialNumber: childText(v, 'serialNumber'),
        firmwareVersion: childText(v, 'firmwareVersion'),
        hardwareVersion: childText(v, 'hardwareVersion'),
    };
}

export function parseUid(xml: string): string | undefined {
    return childText(section(xml, 'Uid'), 'uid');
}

/** The MAC from a cmd 76 reply. Per channel the NVR answers with its own MAC, so only the host's is useful. */
export function parseMac(xml: string): string | undefined {
    return childText(section(xml, 'Ip'), 'mac');
}

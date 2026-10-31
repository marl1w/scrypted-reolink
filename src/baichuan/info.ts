import { childText, findAll, findFirst, parseXml } from './xml';

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

/** Day/night state from a cmd 296 reply (`stat`: day, night, led_day), read once so Night mode starts known. */
export function parseDayNightState(xml: string): string | undefined {
    return childText(section(xml, 'DayNight'), 'stat') ?? (section(xml, 'stat')?.text.trim() || undefined);
}

/** Whether the channel records (cmd 81 Record `enable`). */
export function parseRecordEnable(xml: string): boolean | undefined {
    const e = section(xml, 'enable')?.text.trim();
    return e === undefined || e === '' ? undefined : e !== '0';
}

/** Smart AI events (cmd 199 ability `smartAI` bits) as detection classes, as reolink_aio reads them. */
export const SMART_AI_BITS: [number, string][] = [[1, 'line_crossing'], [2, 'intrusion'], [3, 'loitering'], [4, 'forgotten_item'], [5, 'taken_item']];

export function smartAiClasses(bits: number | undefined): string[] {
    if (!bits) return [];
    return SMART_AI_BITS.filter(([b]) => (bits >> b) & 1).map(([, c]) => c);
}

/** `smartAI` per channel from the cmd 199 ability reply (one `item` per channel, `chnID` 0-based). */
export function parseSmartAiSupport(xml: string): Map<number, number> {
    const out = new Map<number, number>();
    if (!xml) return out;
    let doc;
    try { doc = parseXml(xml); }
    catch { return out; }
    for (const item of findAll(doc, 'item')) {
        const ch = childText(item, 'chnID'), v = childText(item, 'smartAI');
        if (ch && /^\d+$/.test(ch) && v !== undefined && /^\d+$/.test(v)) out.set(parseInt(ch, 10), parseInt(v, 10));
    }
    return out;
}

/** The MAC from a cmd 76 reply. Per channel the NVR answers with its own MAC, so only the host's is useful. */
export function parseMac(xml: string): string | undefined {
    return childText(section(xml, 'Ip'), 'mac');
}

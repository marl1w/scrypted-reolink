import { childText, findFirst, parseXml, XmlNode } from './xml';

/** AI classes reported in AItype. Unknown classes are passed through as strings. */
export type AiType = 'people' | 'vehicle' | 'dog_cat' | 'face' | 'package' | 'other' | (string & {});

export type DayNight = 'day' | 'night' | (string & {});

export interface PushEvent {
    /** 'alarm' carries motion/AI state; 'daynight' only dayNight (motion/ai are then not meaningful). */
    kind: 'alarm' | 'daynight';
    /** 0-based NVR channel (matches rtspChannel). */
    channel: number;
    /** Level state: true while the device reports motion ("MD", or AI "other" without MD). */
    motion: boolean;
    /** AI classes currently active; empty for "none". */
    ai: Set<AiType>;
    dayNight?: DayNight;
    /** Raw status tokens: MD, visitor, tamper... (empty for "none"). */
    status: string[];
    recording?: boolean;
    timestamp?: number;
}

function tokens(s: string | undefined): string[] {
    if (!s) return [];
    return s.split(',').map(t => t.trim()).filter(t => t && t.toLowerCase() !== 'none');
}

function channelOf(ev: XmlNode): number | undefined {
    const t = childText(ev, 'channelId');
    if (t === undefined || !/^\d+$/.test(t)) return undefined;
    return parseInt(t, 10);
}

/**
 * Parses a cmd 33 body (AlarmEventList with AlarmEvent / DayNightEvent children) into normalized,
 * level-triggered events: each AlarmEvent is the full current state of its channel.
 * Semantics follow reolink_aio's cmd 33 handling.
 */
export function parseAlarmEvents(xml: string | XmlNode): PushEvent[] {
    const doc = typeof xml === 'string' ? parseXml(xml) : xml;
    const lists: XmlNode[] = [];
    const body = findFirst(doc, 'body') ?? doc;
    // reolink_aio iterates body -> *List -> event; accept any list element.
    for (const l of body.children) lists.push(l);
    const out: PushEvent[] = [];
    for (const list of lists) {
        for (const ev of list.children) {
            const channel = channelOf(ev);
            if (channel === undefined) continue;
            if (ev.name === 'AlarmEvent') {
                const status = tokens(childText(ev, 'status'));
                const ai = new Set<AiType>(tokens(childText(ev, 'AItype')));
                const md = status.includes('MD');
                const rec = childText(ev, 'recording');
                const ts = childText(ev, 'timeStamp');
                out.push({
                    kind: 'alarm',
                    channel,
                    motion: md || ai.has('other'),
                    ai,
                    status,
                    recording: rec === undefined ? undefined : rec === '1',
                    timestamp: ts && /^\d+$/.test(ts) ? parseInt(ts, 10) : undefined,
                });
            }
            else if (ev.name === 'DayNightEvent') {
                const mode = childText(ev, 'mode');
                if (mode === undefined) continue;
                out.push({ kind: 'daynight', channel, motion: false, ai: new Set(), status: [], dayNight: mode });
            }
        }
    }
    return out;
}

/** One-line rendering for logs and the probe CLI. */
export function formatEvent(e: PushEvent): string {
    if (e.kind === 'daynight')
        return `ch${e.channel} daynight=${e.dayNight}`;
    const ai = [...e.ai].join(',') || 'none';
    const extra = e.status.filter(s => s !== 'MD');
    return `ch${e.channel} motion=${e.motion ? 1 : 0} ai=${ai}${extra.length ? ` status=${extra.join(',')}` : ''}`;
}

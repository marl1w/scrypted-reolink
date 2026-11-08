// Rebroadcast recovery. Rebroadcast's RTMP reader has no connect timeout: when the NVR drops off the network while a
// prebuffer session (re)connects, that session can wait forever and every consumer of the camera (HomeKit, detectors,
// recorders) gets no frames until the camera's mixins are created again. A VideoCamera event on the camera makes
// Rebroadcast drop its sessions and start new ones; this decides when to send it.

/** The NVR was unreachable at least this long: its streams are restarted once it is back. */
export const OUTAGE_MIN_MS = 60_000;
/** ...this long after it is back, so its stream service is up again. */
export const RECONNECT_DELAY_MS = 30_000;
/** A camera whose Rebroadcast keeps timing out while the NVR is online is restarted at most once in this long. */
export const RESTART_MIN_INTERVAL_MS = 600_000;

/** One per NVR: when its connection comes back after an outage, every camera's Rebroadcast is restarted. */
export class NvrOutageWatch {
    private offlineSince?: number;
    private timer?: NodeJS.Timeout;
    private connected = false;

    constructor(private readonly onRecovered: (outageMs: number) => void) { }

    /** The NVR's push connection state: true when subscribed. */
    state(online: boolean) {
        const now = Date.now();
        if (!online) {
            this.dispose();
            // the first loss starts the outage; a start before any connection is no outage
            if (this.connected && this.offlineSince === undefined) this.offlineSince = now;
            return;
        }
        this.connected = true;
        if (this.offlineSince === undefined) return;
        const outage = now - this.offlineSince;
        this.offlineSince = undefined;
        if (outage < OUTAGE_MIN_MS) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.onRecovered(outage);
        }, RECONNECT_DELAY_MS);
        this.timer.unref?.();
    }

    /** Cancels a pending restart. */
    dispose() {
        clearTimeout(this.timer);
        this.timer = undefined;
    }
}

/** One per camera: Rebroadcast that times out twice in a row while the NVR is online is restarted, not more than every so often. */
export class RebroadcastHangWatch {
    private failures = 0;
    private lastRestart = -Infinity;

    /** Rebroadcast answered. */
    ok() {
        this.failures = 0;
    }

    /** Rebroadcast did not answer in time: true when it should be restarted now. */
    timedOut(nvrOnline: boolean): boolean {
        if (!nvrOnline) {
            // the NVR is away: not Rebroadcast's fault, the outage watch restarts it when the NVR is back
            this.failures = 0;
            return false;
        }
        return ++this.failures >= 2 && Date.now() - this.lastRestart >= RESTART_MIN_INTERVAL_MS;
    }

    /** A restart for any reason: counted against the interval. */
    restarted() {
        this.failures = 0;
        this.lastRestart = Date.now();
    }
}

// Crops and mirrors. A crop camera's Rebroadcast reads its parent's rebroadcast (through Scrypted, not the NVR) and a
// mirror's reads its crop's. When the parent's session is restarted the input of the crop's session goes away under
// it, and that session can hang exactly like the parent's did: the NVR watch never sees it (the crop has no NVR
// connection of its own), so before this the crop and its mirror stayed without frames until Scrypted restarted.
// Seen on 2026-11-08 after the NVRs' weekly 02:00 restart, the first one after the outage restarts were added.

/** A crop is restarted this long after its parent, a mirror twice as long, so each one's source is up again first. */
export const DERIVED_RESTART_DELAY_MS = 15_000;
/** Every crop and mirror is asked for its stream this often, so a session that hung for any reason is found. */
export const DERIVED_PROBE_MS = 60_000;
/** ...and given this long to answer. */
export const DERIVED_PROBE_TIMEOUT_MS = 10_000;

/** A camera derived from a channel's substream: a crop reads the parent, a mirror reads the crop `source`. */
export interface DerivedCamera { nativeId: string; kind: 'crop' | 'mirror'; streamId: string; source?: string }

/** Which derived cameras to restart, and when, after `restarted` (the parent's native id, or a crop's). */
export function derivedRestartPlan(restarted: string, parent: string, cameras: DerivedCamera[]): { nativeId: string; delayMs: number }[] {
    if (restarted === parent) {
        return [
            ...cameras.filter(c => c.kind === 'crop').map(c => ({ nativeId: c.nativeId, delayMs: DERIVED_RESTART_DELAY_MS })),
            ...cameras.filter(c => c.kind === 'mirror').map(c => ({ nativeId: c.nativeId, delayMs: 2 * DERIVED_RESTART_DELAY_MS })),
        ];
    }
    return cameras.filter(c => c.kind === 'mirror' && c.source === restarted).map(c => ({ nativeId: c.nativeId, delayMs: DERIVED_RESTART_DELAY_MS }));
}

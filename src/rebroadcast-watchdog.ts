// Rebroadcast recovery. Rebroadcast's RTMP reader has no connect timeout: when the NVR drops off the network while a
// prebuffer session (re)connects, that session can wait forever and every consumer of the camera (HomeKit, detectors,
// recorders) gets no frames until the camera's mixins are created again. A VideoCamera event on the camera makes
// Rebroadcast drop its sessions and start new ones; this decides when to send it. Pure: timers are injected.

/** The NVR was unreachable at least this long: its streams are restarted once it is back. */
export const OUTAGE_MIN_MS = 60_000;
/** ...this long after it is back, so its stream service is up again. */
export const RECONNECT_DELAY_MS = 30_000;
/** Rebroadcast that did not answer this many times in a row while the NVR is online is restarted... */
export const HUNG_AFTER = 2;
/** ...at most once in this long per camera. */
export const RESTART_MIN_INTERVAL_MS = 600_000;

export interface WatchdogDeps {
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (t: unknown) => void;
}

const realDeps: WatchdogDeps = {
    now: () => Date.now(),
    setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
    },
    clearTimer: t => clearTimeout(t as NodeJS.Timeout),
};

/** One per NVR: when its connection comes back after an outage, every camera's Rebroadcast is restarted. */
export class NvrOutageWatch {
    private offlineSince?: number;
    private timer?: unknown;
    private connected = false;

    constructor(private readonly onRecovered: (outageMs: number) => void, private readonly deps: WatchdogDeps = realDeps) { }

    /** The NVR's push connection state: true when subscribed. */
    state(online: boolean) {
        const now = this.deps.now();
        if (!online) {
            this.cancel();
            // the first loss starts the outage; a start before any connection is no outage
            if (this.connected && this.offlineSince === undefined) this.offlineSince = now;
            return;
        }
        this.connected = true;
        if (this.offlineSince === undefined) return;
        const outage = now - this.offlineSince;
        this.offlineSince = undefined;
        if (outage < OUTAGE_MIN_MS) return;
        this.cancel();
        this.timer = this.deps.setTimer(() => {
            this.timer = undefined;
            this.onRecovered(outage);
        }, RECONNECT_DELAY_MS);
    }

    dispose() {
        this.cancel();
    }

    private cancel() {
        if (this.timer !== undefined) this.deps.clearTimer(this.timer);
        this.timer = undefined;
    }
}

/** One per camera: Rebroadcast that keeps timing out while the NVR is online is restarted, not more than every so often. */
export class RebroadcastHangWatch {
    private failures = 0;
    private lastRestart = -Infinity;

    constructor(private readonly now: () => number = () => Date.now()) { }

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
        if (++this.failures < HUNG_AFTER) return false;
        return this.restartAllowed();
    }

    /** A restart for any reason: counted against the interval. */
    restarted() {
        this.failures = 0;
        this.lastRestart = this.now();
    }

    private restartAllowed(): boolean {
        return this.now() - this.lastRestart >= RESTART_MIN_INTERVAL_MS;
    }
}

import type { PushEvent } from './baichuan/events';

export type MotionTrigger = 'Motion + AI' | 'AI Only';

export interface MotionConfig {
    /** Hold motion this long after the last active state (default 50 s). */
    timeoutMs: number;
    /** Ignore raw motion (not AI) this long after a day/night switch; 0 = off. */
    dayNightIgnoreMs: number;
    trigger: MotionTrigger;
    /** Re-emit detections and extend motion at this interval while the device still reports activity. */
    repeatMs: number;
}

export interface MotionSink {
    setMotion(on: boolean): void;
    /**
     * Class names exactly as the device reports them (people, vehicle, dog_cat, face, package), then smart events;
     * repeated while active, and an empty list once when the last class clears.
     */
    detections(classes: string[]): void;
    dayNight?(mode: string): void;
    /** The camera's own state as each push reports it, with no hold or trigger rule; undefined motion when the connection is lost. */
    raw?(motion: boolean | undefined, classes: string[]): void;
}

/** Classes never reported as detections: "other" only means motion. */
const NON_DETECTION = new Set(['other']);

/**
 * Turns level-triggered Baichuan pushes for one channel into Scrypted motion and detections.
 * Detections are emitted before motion goes on, so a downstream gate sees the class first.
 */
export class MotionController {
    private holdTimer?: NodeJS.Timeout;
    private repeatTimer?: NodeJS.Timeout;
    private activeClasses: string[] = [];
    private lastDayNightAt = -Infinity;
    motion = false;
    dayNight?: string;
    lastEventAt?: number;

    constructor(private cfg: () => MotionConfig, private sink: MotionSink, private now: () => number = Date.now) { }

    handle(ev: PushEvent) {
        this.lastEventAt = this.now();
        if (ev.kind === 'daynight') {
            this.lastDayNightAt = this.now();
            this.dayNight = ev.dayNight;
            if (ev.dayNight) this.sink.dayNight?.(ev.dayNight);
            return;
        }
        const c = this.cfg();
        // smart events (line crossing, intrusion...) are detections like the AI classes; the camera passes only supported ones
        const classes = [...[...ev.ai].filter(a => !NON_DETECTION.has(a)), ...(ev.smart ?? [])];
        this.sink.raw?.(!!ev.motion, classes);
        const suppressed = c.trigger === 'AI Only' || (c.dayNightIgnoreMs > 0 && this.now() - this.lastDayNightAt < c.dayNightIgnoreMs);
        const raw = ev.motion && !suppressed;
        const cleared = this.activeClasses.length > 0 && !classes.length;
        this.activeClasses = classes;
        // once when the last class goes: consumers turn classes off exactly, not on a timeout
        if (cleared) this.sink.detections([]);
        if (classes.length || raw) {
            this.activate();
            if (!this.repeatTimer)
                this.repeatTimer = setInterval(() => this.activate(), c.repeatMs);
        }
        else {
            this.stopRepeat();
        }
    }

    private activate() {
        if (this.activeClasses.length) this.sink.detections(this.activeClasses);
        if (!this.motion) {
            this.motion = true;
            this.sink.setMotion(true);
        }
        clearTimeout(this.holdTimer);
        this.holdTimer = setTimeout(() => {
            this.motion = false;
            this.sink.setMotion(false);
        }, this.cfg().timeoutMs);
    }

    private stopRepeat() {
        clearInterval(this.repeatTimer);
        this.repeatTimer = undefined;
    }

    /** Connection lost: stop extending; the hold timer still ends motion. Active classes are cleared once. */
    reset() {
        if (this.activeClasses.length) this.sink.detections([]);
        this.activeClasses = [];
        this.stopRepeat();
        this.sink.raw?.(undefined, []);
    }

    dispose() {
        this.stopRepeat();
        clearTimeout(this.holdTimer);
    }
}

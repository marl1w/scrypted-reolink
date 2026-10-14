import { EventEmitter } from 'node:events';
import { Cmd } from './constants';
import { AuthError, BaichuanConnection, ConnectionOptions, DeviceInfo } from './connection';
import { Frame } from './frame';
import { parseAlarmEvents, PushEvent } from './events';

export type ClientState = 'idle' | 'connecting' | 'subscribed' | 'backoff' | 'auth_failed' | 'stopped';

export interface ClientOptions extends ConnectionOptions {
    /** Keep-alive after this much RX silence (default 30 s). */
    keepAliveMs?: number;
    /** Re-send the subscription this often (default 5 min). */
    resubscribeMs?: number;
    /** Reconnect when nothing was received for this long (default 3 x keepAliveMs). */
    watchdogMs?: number;
    backoffMinMs?: number;
    backoffMaxMs?: number;
    /** Minimum time between two login attempts (default 15 s). */
    loginThrottleMs?: number;
    /** Supervisor tick (default 1 s). */
    tickMs?: number;
    logoutTimeoutMs?: number;
}

export interface ClientStats {
    state: ClientState;
    reconnects: number;
    lastRxAt?: number;
    lastPushAt?: number;
    lastError?: string;
    device?: DeviceInfo;
}

export interface BaichuanClientEvents {
    state: [ClientState];
    event: [PushEvent];
    /** Any other push (cmd other than 33): raw frame and decrypted XML. */
    push: [Frame, string];
    login: [DeviceInfo];
    /** Non-fatal problems (connection lost, keep-alive failed...). Never 'error', so it cannot throw. */
    warn: [Error];
    log: [string];
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Supervised Baichuan session: login, alarm subscription, keep-alive, watchdog, periodic re-subscribe,
 * reconnect with exponential backoff, logout on stop. Emits normalized push events.
 */
export class BaichuanClient extends EventEmitter<BaichuanClientEvents> {
    private conn?: BaichuanConnection;
    private running = false;
    private loop?: Promise<void>;
    private wake?: () => void;
    private lastLoginAt = 0;
    readonly stats: ClientStats = { state: 'idle', reconnects: 0 };

    constructor(readonly opts: ClientOptions) {
        super();
    }

    private get o() {
        const keepAliveMs = this.opts.keepAliveMs ?? 30000;
        return {
            keepAliveMs,
            resubscribeMs: this.opts.resubscribeMs ?? 300000,
            watchdogMs: this.opts.watchdogMs ?? 3 * keepAliveMs,
            backoffMinMs: this.opts.backoffMinMs ?? 5000,
            backoffMaxMs: this.opts.backoffMaxMs ?? 300000,
            loginThrottleMs: this.opts.loginThrottleMs ?? 15000,
            tickMs: this.opts.tickMs ?? 1000,
            logoutTimeoutMs: this.opts.logoutTimeoutMs ?? 3000,
        };
    }

    get state() { return this.stats.state; }

    private setState(s: ClientState) {
        if (this.stats.state === s) return;
        this.stats.state = s;
        this.emit('state', s);
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.loop = this.run();
    }

    /** Stops supervision, logs out and closes. Safe to call repeatedly. */
    async stop(): Promise<void> {
        this.running = false;
        this.wake?.();
        const c = this.conn;
        if (c && !c.isClosed) await c.logout(this.o.logoutTimeoutMs);
        await this.loop;
        this.setState('stopped');
    }

    private interruptibleSleep(ms: number) {
        return new Promise<void>(r => {
            const t = setTimeout(done, ms);
            function done() { clearTimeout(t); r(); }
            this.wake = done;
        });
    }

    private async run() {
        let backoff = this.o.backoffMinMs;
        let first = true;
        while (this.running) {
            const wait = this.lastLoginAt + this.o.loginThrottleMs - Date.now();
            if (wait > 0) await this.interruptibleSleep(wait);
            if (!this.running) break;
            if (!first) this.stats.reconnects++;
            first = false;
            let subscribed = false;
            try {
                await this.session(() => {
                    subscribed = true;
                    backoff = this.o.backoffMinMs;
                });
            }
            catch (e) {
                const err = e as Error;
                this.stats.lastError = err.message;
                if (err instanceof AuthError) {
                    this.emit('warn', err);
                    this.setState('auth_failed');
                    this.running = false;
                    break;
                }
                if (this.running) this.emit('warn', err);
            }
            if (!this.running) break;
            // A session that reached "subscribed" restarts the backoff ladder; repeated failures climb it.
            const delay = subscribed ? this.o.backoffMinMs : backoff;
            if (!subscribed) backoff = Math.min(backoff * 2, this.o.backoffMaxMs);
            this.setState('backoff');
            await this.interruptibleSleep(delay * (0.8 + Math.random() * 0.4));
        }
        if (this.stats.state !== 'auth_failed') this.setState('stopped');
    }

    /** One connection lifetime. Resolves/rejects when the connection ends. */
    private async session(onSubscribed: () => void): Promise<void> {
        this.setState('connecting');
        const c = new BaichuanConnection(this.opts);
        this.conn = c;
        const closed = new Promise<Error | undefined>(r => c.once('close', r));
        c.on('rx', () => { this.stats.lastRxAt = Date.now(); });
        c.on('push', (f: Frame, xml: string) => this.onPush(f, xml));
        try {
            await c.connect();
            this.lastLoginAt = Date.now();
            const info = await c.login();
            this.stats.device = info;
            this.emit('login', info);
            if (!this.running) { await c.logout(this.o.logoutTimeoutMs); return; }
            await c.subscribe();
        }
        catch (e) {
            if (c.loggedIn) await c.logout(this.o.logoutTimeoutMs);
            else c.destroy();
            throw e;
        }
        let lastSubscribe = Date.now();
        this.stats.lastRxAt = Date.now();
        this.setState('subscribed');
        onSubscribed();

        let inFlight = false;
        const tick = setInterval(async () => {
            if (inFlight || c.isClosed || !this.running) return;
            const now = Date.now();
            const silence = now - (this.stats.lastRxAt ?? now);
            if (silence >= this.o.watchdogMs) {
                this.emit('warn', new Error(`watchdog: nothing received for ${Math.round(silence / 1000)} s, reconnecting`));
                c.destroy();
                return;
            }
            inFlight = true;
            try {
                if (now - lastSubscribe >= this.o.resubscribeMs) {
                    lastSubscribe = now;
                    await c.subscribe();
                }
                else if (silence >= this.o.keepAliveMs) {
                    await c.keepAlive(Math.min(10000, this.o.keepAliveMs));
                }
            }
            catch (e) {
                if (!c.isClosed && this.running) {
                    const pushAge = now - (this.stats.lastPushAt ?? 0);
                    if (pushAge >= this.o.keepAliveMs) {
                        this.emit('warn', new Error(`keep-alive failed (${(e as Error).message}) and no push, reconnecting`));
                        c.destroy();
                    }
                }
            }
            finally {
                inFlight = false;
            }
        }, this.o.tickMs);
        try {
            const err = await closed;
            if (this.running) throw err ?? new Error('connection closed by device');
        }
        finally {
            clearInterval(tick);
        }
    }

    private onPush(f: Frame, xml: string) {
        if (f.cmd !== Cmd.AlarmEvent) {
            this.emit('push', f, xml);
            return;
        }
        this.stats.lastPushAt = Date.now();
        let events: PushEvent[];
        try {
            events = parseAlarmEvents(xml);
        }
        catch (e) {
            this.emit('warn', new Error(`unparseable cmd 33 body: ${(e as Error).message}`));
            return;
        }
        for (const ev of events) this.emit('event', ev);
    }
}

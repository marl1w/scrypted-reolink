import { request as httpRequest } from 'node:http';

// One shared, reused HTTP API session per NVR (Reolink JSON API, /api.cgi).
// The NVR's HTTP session pool is small and lease based, so this class guarantees:
// at most one token at a time, single-flight login, re-login only when the lease is near its end
// or the device says the token is invalid, backoff after failed logins, logout on stop.

export interface HttpSessionOptions {
    host: string;
    port?: number;
    username: string;
    password: string;
    timeoutMs?: number;
    backoffMinMs?: number;
    backoffMaxMs?: number;
    /** Renew this long before the lease ends (default 60 s). */
    renewMarginMs?: number;
    now?: () => number;
}

export interface ApiCommand {
    cmd: string;
    action?: number;
    param?: Record<string, unknown>;
}

export interface ApiResult {
    cmd: string;
    code: number;
    value?: any;
    error?: { rspCode: number; detail?: string };
}

export class ApiError extends Error {
    constructor(message: string, readonly rspCode?: number) { super(message); }
}

export interface RawResponse {
    status: number;
    contentType: string;
    body: Buffer;
}

/** rspCode -6: "please login first" (token invalid or expired on the device side). */
const RSP_LOGIN_FIRST = -6;

export class HttpSession {
    private token?: string;
    private leaseEnd = 0;
    private loginPromise?: Promise<string>;
    private nextLoginAt = 0;
    private backoff: number;
    private stopped = false;
    logins = 0;
    lastError?: string;

    constructor(readonly opts: HttpSessionOptions) {
        this.backoff = opts.backoffMinMs ?? 5000;
    }

    private now() { return (this.opts.now ?? Date.now)(); }

    /** 1 while a token is held, else 0. Never more. */
    get sessionsInUse() { return this.token ? 1 : 0; }

    private base() { return `${this.opts.host}:${this.opts.port ?? 80}`; }

    /** Low-level HTTP; exported for tests and snapshots. */
    raw(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<RawResponse> {
        return new Promise((resolve, reject) => {
            const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
            const req = httpRequest({
                host: this.opts.host,
                port: this.opts.port ?? 80,
                method,
                path,
                headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : undefined,
                timeout: timeoutMs ?? this.opts.timeoutMs ?? 10000,
            }, res => {
                const chunks: Buffer[] = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) }));
                res.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new ApiError(`HTTP timeout ${method} ${path.split('?')[0]}`)));
            req.on('error', reject);
            if (data) req.write(data);
            req.end();
        });
    }

    private async login(): Promise<string> {
        if (this.stopped) throw new ApiError('session stopped');
        const wait = this.nextLoginAt - this.now();
        if (wait > 0) throw new ApiError(`login backoff, retry in ${Math.ceil(wait / 1000)} s`);
        try {
            const r = await this.raw('POST', '/api.cgi?cmd=Login', [{
                cmd: 'Login', action: 0,
                param: { User: { Version: '0', userName: this.opts.username, password: this.opts.password } },
            }]);
            const j = parseJson(r.body);
            const item = Array.isArray(j) ? j[0] : j;
            const tok = item?.value?.Token;
            if (!tok?.name) {
                const rc = item?.error?.rspCode;
                throw new ApiError(`login failed${rc !== undefined ? ` (rspCode ${rc}${item?.error?.detail ? ` ${item.error.detail}` : ''})` : ''}`, rc);
            }
            this.logins++;
            this.token = tok.name;
            this.leaseEnd = this.now() + 1000 * (Number(tok.leaseTime) || 3600);
            this.backoff = this.opts.backoffMinMs ?? 5000;
            this.nextLoginAt = 0;
            return tok.name;
        }
        catch (e) {
            this.lastError = (e as Error).message;
            this.nextLoginAt = this.now() + this.backoff;
            this.backoff = Math.min(this.backoff * 2, this.opts.backoffMaxMs ?? 300000);
            throw e;
        }
    }

    /** Returns a valid token, logging in (single flight) only when needed. */
    async getToken(): Promise<string> {
        if (this.token && this.now() < this.leaseEnd - (this.opts.renewMarginMs ?? 60000))
            return this.token;
        if (!this.loginPromise) {
            this.loginPromise = (async () => {
                if (this.token) await this.logout();
                return this.login();
            })().finally(() => { this.loginPromise = undefined; });
        }
        return this.loginPromise;
    }

    private invalidate() {
        this.token = undefined;
        this.leaseEnd = 0;
    }

    /** Runs a batch of commands with the shared token. Retries once after "please login first". */
    async call(cmds: ApiCommand[], retry = true): Promise<ApiResult[]> {
        const token = await this.getToken();
        const r = await this.raw('POST', `/api.cgi?cmd=${encodeURIComponent(cmds[0].cmd)}&token=${encodeURIComponent(token)}`,
            cmds.map(c => ({ action: 0, param: {}, ...c })));
        const j = parseJson(r.body);
        const arr: ApiResult[] = Array.isArray(j) ? j : [j];
        if (arr.some(x => x?.error?.rspCode === RSP_LOGIN_FIRST)) {
            this.invalidate();
            if (retry) return this.call(cmds, false);
        }
        return arr;
    }

    /** Single command; throws ApiError on an error result. */
    async one(cmd: ApiCommand): Promise<any> {
        const [r] = await this.call([cmd]);
        if (!r || r.error || r.code !== 0)
            throw new ApiError(`${cmd.cmd} failed${r?.error ? ` (rspCode ${r.error.rspCode})` : ''}`, r?.error?.rspCode);
        return r.value;
    }

    /** JPEG snapshot through the shared token. */
    async snapshot(channel: number, timeoutMs = 10000): Promise<Buffer> {
        const go = async () => {
            const token = await this.getToken();
            return this.raw('GET', `/cgi-bin/api.cgi?cmd=Snap&channel=${channel}&rs=${Date.now()}&token=${encodeURIComponent(token)}`, undefined, timeoutMs);
        };
        let r = await go();
        if (r.contentType.includes('json') || r.body.subarray(0, 1).toString() === '[') {
            const j = parseJson(r.body);
            if ((Array.isArray(j) ? j[0] : j)?.error?.rspCode === RSP_LOGIN_FIRST) {
                this.invalidate();
                r = await go();
            }
        }
        if (r.status !== 200 || r.body[0] !== 0xff || r.body[1] !== 0xd8)
            throw new ApiError(`snapshot failed (HTTP ${r.status}, ${r.contentType || 'no type'})`);
        return r.body;
    }

    async logout(): Promise<void> {
        const t = this.token;
        this.invalidate();
        if (!t) return;
        try {
            await this.raw('POST', `/api.cgi?cmd=Logout&token=${encodeURIComponent(t)}`, [{ cmd: 'Logout', action: 0, param: {} }], 3000);
        }
        catch { /* best effort */ }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        try { await this.loginPromise; } catch { /* ignore */ }
        await this.logout();
    }
}

function parseJson(b: Buffer): any {
    try { return JSON.parse(b.toString('utf8')); }
    catch { throw new ApiError('invalid JSON from device'); }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { BaichuanClient, ClientOptions } from '../src/baichuan/client';
import { PushEvent } from '../src/baichuan/events';
import { fixture, MockNvr } from './mock-nvr';

const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('timeout waiting for condition');
        await new Promise(r => setTimeout(r, 10));
    }
};

async function withNvr(fn: (n: MockNvr, mk: (o?: Partial<ClientOptions>) => BaichuanClient) => Promise<void>) {
    const n = new MockNvr();
    await n.start();
    const clients: BaichuanClient[] = [];
    const mk = (o: Partial<ClientOptions> = {}) => {
        const c = new BaichuanClient({
            host: '127.0.0.1', port: n.port, username: n.user, password: n.password,
            loginThrottleMs: 0, backoffMinMs: 20, backoffMaxMs: 100, tickMs: 10, ...o,
        });
        clients.push(c);
        return c;
    };
    try { await fn(n, mk); }
    finally {
        for (const c of clients) await c.stop();
        await n.stop();
    }
}

test('login, subscribe, receive pushes, logout on stop', () => withNvr(async (n, mk) => {
    const c = mk();
    const events: PushEvent[] = [];
    let device: any;
    c.on('event', e => events.push(e));
    c.on('login', d => { device = d; });
    c.start();
    await until(() => c.state === 'subscribed');
    assert.equal(device.channelNum, 12);
    n.push(fixture('alarm-multi.xml'));
    await until(() => events.length === 3);
    assert.deepEqual(events.map(e => e.channel), [0, 3, 11]);
    await c.stop();
    assert.deepEqual(n.log, ['cmd1', 'cmd1', 'cmd31', 'cmd2', 'logout-ok']);
    assert.equal(c.state, 'stopped');
}));

test('bad credentials stop with auth_failed and no retry', () => withNvr(async (n, mk) => {
    const c = mk({ password: 'wrong' });
    c.start();
    await until(() => c.state === 'auth_failed');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(n.log.filter(l => l === 'cmd1').length, 2);
}));

test('reconnects and re-subscribes after the device drops the connection', () => withNvr(async (n, mk) => {
    const c = mk();
    c.start();
    await until(() => c.state === 'subscribed');
    n.dropAll();
    await until(() => n.logins === 2 && c.state === 'subscribed');
    assert.equal(c.stats.reconnects, 1);
}));

test('keep-alive is sent on silence; dead session triggers the watchdog and a reconnect', () => withNvr(async (n, mk) => {
    const c = mk({ keepAliveMs: 50, watchdogMs: 200, requestTimeoutMs: 100 });
    c.start();
    await until(() => c.state === 'subscribed');
    await until(() => n.log.includes('cmd93'));
    n.mute = true;
    await until(() => n.logins === 2, 4000);
    n.mute = false;
    await until(() => c.state === 'subscribed');
}));

test('periodic re-subscribe', () => withNvr(async (n, mk) => {
    const c = mk({ resubscribeMs: 50 });
    c.start();
    await until(() => n.log.filter(l => l === 'cmd31').length >= 3);
}));

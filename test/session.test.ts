import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpSession } from '../src/http/session';
import { discoveredChannels, hasFloodlight, hasSiren, NvrApi, supportedAiClasses } from '../src/http/nvr-api';
import { MockHttpNvr } from './mock-http';

async function withHttp(fn: (m: MockHttpNvr, s: HttpSession, api: NvrApi) => Promise<void>, opts: Partial<ConstructorParameters<typeof HttpSession>[0]> = {}) {
    const m = new MockHttpNvr();
    await m.start();
    const s = new HttpSession({ host: '127.0.0.1', port: m.port, username: m.user, password: m.password, backoffMinMs: 50, backoffMaxMs: 200, ...opts });
    try { await fn(m, s, new NvrApi(s)); }
    finally { await s.stop(); await m.stop(); }
}

test('one login reused for many concurrent calls, snapshots and channel batches', () => withHttp(async (m, s, api) => {
    await Promise.all([api.devInfo(), api.channelStatus(), api.ability(), api.channelDetails(0), api.channelDetails(2), s.snapshot(0), s.snapshot(2)]);
    assert.equal(m.logins, 1);
    assert.equal(s.sessionsInUse, 1);
    assert.equal(m.tokens.size, 1);
}));

test('stop logs out; never more than one token on the device', () => withHttp(async (m, s, api) => {
    await api.devInfo();
    await s.stop();
    assert.equal(m.logouts, 1);
    assert.equal(m.tokens.size, 0);
    assert.equal(s.sessionsInUse, 0);
}));

test('token rejected by the device (-6): one re-login, request retried', () => withHttp(async (m, _s, api) => {
    await api.devInfo();
    m.expireAll();
    const d = await api.devInfo();
    assert.equal(d.model, 'NVR-TEST');
    assert.equal(m.logins, 2);
    assert.equal(m.tokens.size, 1);
}));

test('lease near its end: logout of the old token, then a new login', () => withHttp(async (m, _s, api) => {
    m.leaseTime = 1; // renew margin 60 s > lease: every call renews
    await api.devInfo();
    await api.devInfo();
    assert.equal(m.logins, 2);
    assert.equal(m.logouts, 1);
    assert.equal(m.tokens.size, 1);
}));

test('failed login backs off instead of hammering', () => withHttp(async (m, _s, api) => {
    m.failLogin = true;
    await assert.rejects(api.devInfo(), /login failed/);
    await assert.rejects(api.devInfo(), /backoff/);
    await assert.rejects(api.devInfo(), /backoff/);
    m.failLogin = false;
    await new Promise(r => setTimeout(r, 70));
    await api.devInfo();
    assert.equal(m.logins, 1);
}));

test('discovery helpers: channels with uid, AI support, siren/floodlight abilities', () => withHttp(async (_m, _s, api) => {
    const ch = discoveredChannels(await api.channelStatus());
    assert.deepEqual(ch.map(c => c.channel), [0, 2]);
    const d = await api.channelDetails(2);
    assert.deepEqual(supportedAiClasses(d.ai), ['people', 'vehicle']);
    assert.equal(d.chnTypeInfo?.typeInfo, 'CAM-TEST');
    const ab = await api.ability();
    assert.equal(hasSiren(ab, 0), true);
    assert.equal(hasSiren(ab, 2), false);
    assert.equal(hasFloodlight(ab, 2), true);
    assert.equal(hasFloodlight(ab, 0), false);
    await api.setSiren(0, true);
    await api.setWhiteLed(2, false);
}));

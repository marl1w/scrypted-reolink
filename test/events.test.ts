import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatEvent, parseAlarmEvents } from '../src/baichuan/events';
import { parseDeviceInfo } from '../src/baichuan/connection';

// Tests run from out-test/test; fixtures stay in the source tree.
const fx = (n: string) => readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', n), 'utf8');

test('multi-channel AlarmEventList', () => {
    const ev = parseAlarmEvents(fx('alarm-multi.xml'));
    assert.equal(ev.length, 3);
    assert.deepEqual(ev.map(e => e.channel), [0, 3, 11]);
    assert.equal(ev[0].motion, true);
    assert.deepEqual([...ev[0].ai], ['people', 'vehicle']);
    assert.equal(ev[0].recording, true);
    assert.equal(ev[1].motion, false);
    assert.equal(ev[1].ai.size, 0);
    assert.deepEqual(ev[1].status, []);
    assert.deepEqual([...ev[2].ai].sort(), ['dog_cat', 'face', 'package']);
    assert.deepEqual(ev[2].status, ['MD', 'visitor']);
    assert.equal(ev[2].timestamp, 1791886000);
    assert.equal(formatEvent(ev[2]), 'ch11 motion=1 ai=dog_cat,face,package status=visitor');
    assert.equal(formatEvent(ev[1]), 'ch3 motion=0 ai=none');
});

test('AI "other" without MD counts as motion; MD with AItype none', () => {
    const [a, b] = parseAlarmEvents(fx('alarm-other.xml'));
    assert.equal(a.motion, true);
    assert.deepEqual([...a.ai], ['other']);
    assert.equal(b.motion, true);
    assert.equal(b.ai.size, 0);
});

test('DayNightEvent', () => {
    const [dn, md] = parseAlarmEvents(fx('daynight.xml'));
    assert.equal(dn.kind, 'daynight');
    assert.equal(dn.channel, 5);
    assert.equal(dn.dayNight, 'night');
    assert.equal(formatEvent(dn), 'ch5 daynight=night');
    assert.equal(md.kind, 'alarm');
    assert.equal(md.motion, true);
});

test('events without channelId and unknown tags are skipped', () => {
    const ev = parseAlarmEvents('<?xml version="1.0" ?><body><AlarmEventList><AlarmEvent><status>MD</status></AlarmEvent><Foo><channelId>1</channelId></Foo></AlarmEventList></body>');
    assert.equal(ev.length, 0);
});

test('login reply DeviceInfo', () => {
    const d = parseDeviceInfo(fx('login-reply.xml'));
    assert.equal(d.type, 'nvr');
    assert.equal(d.channelNum, 12);
    assert.equal(d.fields.typeInfo, 'NVR');
});

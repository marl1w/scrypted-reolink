import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDayNightState, parseMac, parseRecordEnable, parseSmartAiSupport, parseUid, parseVersionInfo, smartAiClasses } from '../src/baichuan/info';
import { fixture } from './mock-nvr';

test('VersionInfo of a channel carries the camera serial', () => {
    assert.deepEqual(parseVersionInfo(fixture('version-info-channel.xml')),
        { type: 'B800', serialNumber: '141400000000001', firmwareVersion: 'v3.1.0.4057_2409132131', hardwareVersion: 'IPC_5158M8M_V2' });
    assert.equal(parseVersionInfo(fixture('version-info-host.xml')).serialNumber, '00000000000000');
});

test('UID and MAC replies', () => {
    assert.equal(parseUid(fixture('uid.xml')), '95270000EXAMPLE1');
    assert.equal(parseMac(fixture('local-link.xml')), '02:00:5e:10:00:01');
});

test('empty or unparseable replies give nothing', () => {
    assert.deepEqual(parseVersionInfo(''), { type: undefined, serialNumber: undefined, firmwareVersion: undefined, hardwareVersion: undefined });
    assert.equal(parseUid('<?xml version="1.0" ?><body><Other/></body>'), undefined);
    assert.equal(parseMac('not xml <'), undefined);
});

test('day/night state (cmd 296) and recording switch (cmd 81)', () => {
    assert.equal(parseDayNightState(fixture('daynight-state.xml')), 'night');
    assert.equal(parseDayNightState(''), undefined);
    assert.equal(parseRecordEnable(fixture('record.xml')), true);
    assert.equal(parseRecordEnable(fixture('record.xml').replace('<enable>1', '<enable>0')), false);
    assert.equal(parseRecordEnable(''), undefined);
});

test('smart event support per channel from the cmd 199 smartAI bits', () => {
    const s = parseSmartAiSupport(fixture('support.xml'));
    assert.deepEqual([...s], [[0, 0], [1, 6], [2, 62]]);
    assert.deepEqual(smartAiClasses(s.get(0)), []);
    assert.deepEqual(smartAiClasses(s.get(1)), ['line_crossing', 'intrusion']);
    assert.deepEqual(smartAiClasses(s.get(2)), ['line_crossing', 'intrusion', 'loitering', 'forgotten_item', 'taken_item']);
    assert.deepEqual(smartAiClasses(1), [], 'bit 0 is not a smart event');
    assert.equal(parseSmartAiSupport('not xml <').size, 0);
});

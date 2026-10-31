import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMac, parseUid, parseVersionInfo } from '../src/baichuan/info';
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

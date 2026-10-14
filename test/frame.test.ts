import test from 'node:test';
import assert from 'node:assert/strict';
import { MsgClass } from '../src/baichuan/constants';
import { encodeFrame, FrameDecoder, FrameError, messagePart } from '../src/baichuan/frame';

test('legacy nonce request header matches the probe bytes', () => {
    const b = encodeFrame({ cmd: 1, chId: 250, msgId: 1, cls: MsgClass.Legacy });
    assert.equal(b.toString('hex'), 'f0debc0a0100000000000000fa01000012dc1465');
});

test('modern subscribe header matches the probe bytes', () => {
    const b = encodeFrame({ cmd: 31, chId: 251, msgId: 7 });
    assert.equal(b.toString('hex'), 'f0debc0a1f00000000000000fb0700000000146400000000');
});

test('encode/decode round trip with body, payload offset and status', () => {
    const body = Buffer.from('hello world, this is a body');
    const enc = encodeFrame({ cmd: 33, chId: 251, msgId: 0xabcdef, body, payloadOffset: 5, statusBytes: Buffer.from([0xc8, 0x00]), cls: MsgClass.Modern0 });
    const [f] = new FrameDecoder().push(enc);
    assert.equal(f.cmd, 33);
    assert.equal(f.chId, 251);
    assert.equal(f.msgId, 0xabcdef);
    assert.equal(f.status, 200);
    assert.equal(f.encHex, 'c800');
    assert.equal(f.cls, '0000');
    assert.equal(f.payloadOffset, 5);
    assert.deepEqual(f.body, body);
    assert.equal(messagePart(f).toString(), 'hello');
});

test('decoder handles byte-by-byte delivery and several frames per chunk', () => {
    const a = encodeFrame({ cmd: 33, chId: 251, msgId: 1, body: Buffer.from('A'.repeat(40)) });
    const b = encodeFrame({ cmd: 93, chId: 250, msgId: 2, cls: MsgClass.Modern20 });
    const c = encodeFrame({ cmd: 1, chId: 250, msgId: 3, cls: MsgClass.Legacy, body: Buffer.from('xyz') });
    const all = Buffer.concat([a, b, c]);
    const d1 = new FrameDecoder();
    const got = [];
    for (const byte of all) got.push(...d1.push(Buffer.from([byte])));
    assert.deepEqual(got.map(f => f.cmd), [33, 93, 1]);
    assert.equal(got[1].body.length, 0);
    assert.equal(got[2].body.toString(), 'xyz');
    assert.deepEqual(new FrameDecoder().push(all).map(f => f.msgId), [1, 2, 3]);
});

test('decoder resyncs on garbage and rejects unknown classes', () => {
    const a = encodeFrame({ cmd: 33, chId: 251, msgId: 9 });
    const fs = new FrameDecoder().push(Buffer.concat([Buffer.from('garbage-bytes-here!!!'), a]));
    assert.deepEqual(fs.map(f => f.msgId), [9]);
    const bad = encodeFrame({ cmd: 33, chId: 251, msgId: 9 });
    bad[18] = 0x99;
    assert.throws(() => new FrameDecoder().push(bad), FrameError);
});

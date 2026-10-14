import test from 'node:test';
import assert from 'node:assert/strict';
import { aesDecrypt, aesEncrypt, bcXor, deriveAesKey, md5m } from '../src/baichuan/crypto';

// Vectors computed with the Python probe logic that logged in and out of a live NVR
// (md5m, BC-XOR and pure-Python AES-128-CFB128 with IV "0123456789abcdef").
const NONCE = '0A1B2C3D4E5F6789';
const USER = 'viewer';
const PASS = 'example-pass';
const LINKTYPE_XML = '<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<LinkType version="1.1">\n<type>LAN</type>\n</LinkType>\n</body>\n';
const LINKTYPE_AES = 'ba8199c43923e9b30a2cc6a271a65c2f5caec7ee891fe0f6c2ac544627932b384cc2058abe6055f54fe25ba88f0516c1da74f7891c4c9531dd072ba57315937a8fa810a36cb08a6549ace38c4e5ae23330b78a5ac3038b5b241f84cfd10faf3b45d2ac8c58574d5a3cc312f2ed';

test('md5m is upper-case MD5 hex truncated to 31 characters', () => {
    assert.equal(md5m(USER + NONCE), '096A3094516B6B84DA83730322907C9');
    assert.equal(md5m(PASS + NONCE), '23C7C65A397B82A112D48172AE08201');
    assert.equal(md5m('').length, 31);
});

test('AES key derivation', () => {
    assert.equal(deriveAesKey(NONCE, PASS).toString('ascii'), '1F4579420A999D47');
});

test('AES-128-CFB matches the probe vector and round-trips (incl. a partial last block)', () => {
    const key = deriveAesKey(NONCE, PASS);
    const ct = aesEncrypt(key, Buffer.from(LINKTYPE_XML));
    assert.equal(LINKTYPE_XML.length % 16 !== 0, true);
    assert.equal(ct.toString('hex'), LINKTYPE_AES);
    assert.equal(aesDecrypt(key, ct).toString(), LINKTYPE_XML);
});

test('BC-XOR vectors at offsets 250 and 0, symmetric', () => {
    const pt = Buffer.from('<?xml version');
    assert.equal(bcXor(pt, 250).toString('hex'), 'fa8ed8feee2593b2b4c2c9fcec');
    assert.equal(bcXor(pt, 0).toString('hex'), '2312442636490e9a6d5e552434');
    assert.deepEqual(bcXor(bcXor(pt, 251), 251), pt);
});

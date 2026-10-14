import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBody, childText, findAll, findFirst, parseXml, XmlError } from '../src/baichuan/xml';

test('parses declaration, attributes, entities, CDATA and self-closing tags', () => {
    const d = parseXml('<?xml version="1.0" ?>\n<body><A version="1.1" x=\'a&amp;b\'><b>1 &lt; 2</b><c/><d><![CDATA[<raw>]]></d></A></body>');
    const a = findFirst(d, 'A')!;
    assert.deepEqual(a.attrs, { version: '1.1', x: 'a&b' });
    assert.equal(childText(a, 'b'), '1 < 2');
    assert.equal(childText(a, 'c'), '');
    assert.equal(childText(a, 'd'), '<raw>');
    assert.equal(childText(a, 'missing'), undefined);
    assert.equal(findAll(d, 'b').length, 1);
});

test('rejects malformed documents', () => {
    assert.throws(() => parseXml('<a><b></a>'), XmlError);
    assert.throws(() => parseXml('<a>'), XmlError);
});

test('buildBody produces exactly the login XML the live-verified probe sent', () => {
    const xml = buildBody({
        LoginUser: { userName: 'U', password: 'P', userVer: 1 },
        LoginNet: { type: 'LAN', udpPort: 0 },
    });
    assert.equal(xml, '<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<LoginUser version="1.1">\n<userName>U</userName>\n<password>P</password>\n<userVer>1</userVer>\n</LoginUser>\n<LoginNet version="1.1">\n<type>LAN</type>\n<udpPort>0</udpPort>\n</LoginNet>\n</body>\n');
    assert.equal(childText(findFirst(parseXml(xml), 'LoginNet'), 'type'), 'LAN');
});

test('buildBody escapes values', () => {
    assert.match(buildBody({ X: { p: 'a<&>"' } }), /<p>a&lt;&amp;&gt;&quot;<\/p>/);
});

// Tiny XML reader/writer, sufficient for Baichuan message bodies (no DTDs, no namespaces).

export interface XmlNode {
    name: string;
    attrs: Record<string, string>;
    children: XmlNode[];
    text: string;
}

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
        if (e[0] === '#')
            return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
        return ENT[e];
    });
}

export function escapeXml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export class XmlError extends Error { }

/** Parses a document and returns a synthetic root node named "#document". */
export function parseXml(src: string): XmlNode {
    const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
    const stack: XmlNode[] = [root];
    let i = 0;
    const n = src.length;
    while (i < n) {
        const lt = src.indexOf('<', i);
        if (lt < 0) {
            stack[stack.length - 1].text += unescapeXml(src.slice(i));
            break;
        }
        if (lt > i)
            stack[stack.length - 1].text += unescapeXml(src.slice(i, lt));
        if (src.startsWith('<?', lt)) {
            const e = src.indexOf('?>', lt);
            if (e < 0) throw new XmlError('unterminated declaration');
            i = e + 2;
        }
        else if (src.startsWith('<!--', lt)) {
            const e = src.indexOf('-->', lt);
            if (e < 0) throw new XmlError('unterminated comment');
            i = e + 3;
        }
        else if (src.startsWith('<![CDATA[', lt)) {
            const e = src.indexOf(']]>', lt);
            if (e < 0) throw new XmlError('unterminated CDATA');
            stack[stack.length - 1].text += src.slice(lt + 9, e);
            i = e + 3;
        }
        else if (src.startsWith('<!', lt)) {
            const e = src.indexOf('>', lt);
            if (e < 0) throw new XmlError('unterminated directive');
            i = e + 1;
        }
        else if (src[lt + 1] === '/') {
            const e = src.indexOf('>', lt);
            if (e < 0) throw new XmlError('unterminated end tag');
            const name = src.slice(lt + 2, e).trim();
            const top = stack.pop();
            if (!top || top.name !== name || stack.length === 0)
                throw new XmlError(`mismatched end tag </${name}>`);
            i = e + 1;
        }
        else {
            const e = findTagEnd(src, lt);
            let inner = src.slice(lt + 1, e);
            const selfClose = inner.endsWith('/');
            if (selfClose) inner = inner.slice(0, -1);
            const m = /^([^\s/>]+)/.exec(inner);
            if (!m) throw new XmlError('bad start tag');
            const node: XmlNode = { name: m[1], attrs: parseAttrs(inner.slice(m[1].length)), children: [], text: '' };
            stack[stack.length - 1].children.push(node);
            if (!selfClose) stack.push(node);
            i = e + 1;
        }
    }
    if (stack.length !== 1)
        throw new XmlError(`unclosed element <${stack[stack.length - 1].name}>`);
    return root;
}

function findTagEnd(src: string, from: number): number {
    let q: string | undefined;
    for (let j = from + 1; j < src.length; j++) {
        const c = src[j];
        if (q) { if (c === q) q = undefined; }
        else if (c === '"' || c === "'") q = c;
        else if (c === '>') return j;
    }
    throw new XmlError('unterminated start tag');
}

function parseAttrs(s: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)))
        out[m[1]] = unescapeXml(m[3] ?? m[4] ?? '');
    return out;
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
    return node?.children.find(c => c.name === name);
}

/** Text of a direct child, trimmed; undefined when absent. */
export function childText(node: XmlNode | undefined, name: string): string | undefined {
    const c = child(node, name);
    return c ? c.text.trim() : undefined;
}

/** Depth-first search for all descendants with this name. */
export function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
    for (const c of node.children) {
        if (c.name === name) out.push(c);
        findAll(c, name, out);
    }
    return out;
}

export function findFirst(node: XmlNode, name: string): XmlNode | undefined {
    for (const c of node.children) {
        if (c.name === name) return c;
        const r = findFirst(c, name);
        if (r) return r;
    }
    return undefined;
}

export type XmlValue = string | number | boolean | XmlElement;
export interface XmlElement {
    attrs?: Record<string, string>;
    children: Record<string, XmlValue>;
}

/** Builds `<?xml ...?>\n<body>\n<Tag version="1.1">\n<k>v</k>\n...</Tag>\n</body>\n` like the official clients. */
export function buildBody(sections: Record<string, Record<string, XmlValue>>): string {
    let s = '<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n';
    for (const [tag, fields] of Object.entries(sections))
        s += element(tag, { attrs: { version: '1.1' }, children: fields });
    return s + '</body>\n';
}

function element(tag: string, el: XmlElement): string {
    const attrs = Object.entries(el.attrs ?? {}).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
    let s = `<${tag}${attrs}>\n`;
    for (const [k, v] of Object.entries(el.children)) {
        if (typeof v === 'object') s += element(k, v);
        else s += `<${k}>${escapeXml(String(v))}</${k}>\n`;
    }
    return s + `</${tag}>\n`;
}

// A small XML reader. The engine has no dependencies and must run unchanged in Node and in the
// browser, so it cannot lean on DOMParser. It covers what partner order documents use: elements,
// attributes, text, comments, a declaration and the five predefined entities.
import { ParseError } from '../util.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e]);
export const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export function parseXml(src) {
  let i = 0;
  const n = src.length;
  const fail = (msg) => {
    throw new ParseError('XML_MALFORMED', `${msg} at character ${i}`);
  };
  const skipWs = () => {
    while (i < n && /\s/.test(src[i])) i++;
  };
  const skipMisc = () => {
    for (;;) {
      skipWs();
      if (src.startsWith('<?', i)) {
        const j = src.indexOf('?>', i);
        if (j < 0) fail('Unterminated declaration');
        i = j + 2;
      } else if (src.startsWith('<!--', i)) {
        const j = src.indexOf('-->', i);
        if (j < 0) fail('Unterminated comment');
        i = j + 3;
      } else return;
    }
  };
  const readName = () => {
    const m = /^[A-Za-z_][\w.\-:]*/.exec(src.slice(i, i + 120));
    if (!m) fail('Expected an element or attribute name');
    i += m[0].length;
    return m[0];
  };
  const readElement = () => {
    if (src[i] !== '<') fail('Expected "<"');
    i++;
    const name = readName();
    const node = { name, attrs: {}, children: [], text: '' };
    for (;;) {
      skipWs();
      if (i >= n) fail(`Unclosed tag <${name}>`);
      if (src[i] === '/') {
        if (src[i + 1] !== '>') fail('Expected "/>"');
        i += 2;
        return node;
      }
      if (src[i] === '>') {
        i++;
        break;
      }
      const attr = readName();
      skipWs();
      if (src[i] !== '=') fail(`Attribute ${attr} has no value`);
      i++;
      skipWs();
      const quote = src[i];
      if (quote !== '"' && quote !== "'") fail(`Attribute ${attr} value is not quoted`);
      const end = src.indexOf(quote, i + 1);
      if (end < 0) fail(`Attribute ${attr} value is not terminated`);
      node.attrs[attr] = decode(src.slice(i + 1, end));
      i = end + 1;
    }
    let text = '';
    for (;;) {
      if (i >= n) fail(`Element <${name}> is never closed`);
      if (src.startsWith('</', i)) {
        i += 2;
        const close = readName();
        if (close !== name) fail(`Expected </${name}> but found </${close}>`);
        skipWs();
        if (src[i] !== '>') fail('Expected ">"');
        i++;
        node.text = decode(text.trim());
        return node;
      }
      if (src.startsWith('<!--', i)) {
        const j = src.indexOf('-->', i);
        if (j < 0) fail('Unterminated comment');
        i = j + 3;
      } else if (src[i] === '<') {
        node.children.push(readElement());
      } else {
        text += src[i++];
      }
    }
  };

  skipMisc();
  if (i >= n) fail('Document is empty');
  const root = readElement();
  skipMisc();
  if (i < n) fail('Unexpected content after the root element');
  return root;
}

export const child = (node, name) => node.children.find((c) => c.name === name);
export const children = (node, name) => node.children.filter((c) => c.name === name);
export const childText = (node, name) => child(node, name)?.text ?? '';

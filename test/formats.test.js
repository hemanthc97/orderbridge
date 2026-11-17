import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParseError } from '../src/util.js';
import { buildMasterData } from '../src/masterdata.js';
import { OrderFactory } from '../src/generator.js';
import { adapters, splitCsv, parseCsvOrder, buildAck } from '../src/formats/index.js';
import { parseXml, child, childText } from '../src/formats/xml.js';
import { parseInterchange, parseX12Order, splitX12, build997, tokenize } from '../src/formats/x12.js';
import { toCanonical, applyChanges } from '../src/canonical.js';
import { validateOrder } from '../src/rules.js';

const md = buildMasterData();
const factory = () => new OrderFactory(buildMasterData(), 11);
const codeOf = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ParseError, `expected a ParseError, got ${err}`);
    return err.code;
  }
  assert.fail('expected a ParseError');
};

test('X12 850: delimiters are read from the ISA segment and the order survives a round trip', () => {
  const f = factory();
  const spec = f.order('KESTREL', 0, { lines: 3 });
  const text = f.render(spec);
  assert.equal(tokenize(text).el, '*');
  const raw = parseX12Order(text);
  assert.equal(raw.poNumber, spec.poNumber);
  assert.equal(raw.action, 'NEW');
  assert.equal(raw.orderDate, spec.orderDate);
  assert.equal(raw.shipDate, spec.shipDate);
  assert.equal(raw.shipToCode, spec.shipToCode);
  assert.deepEqual(raw.lines.map((l) => [l.lineNo, l.qty, l.buyerPart, l.unitPrice]), spec.lines.map((l) => [l.lineNo, l.qty, l.buyerPart, l.unitPrice]));
  assert.equal(raw.envelope.txType, '850');
});

test('X12: a different element separator and segment terminator still parse', () => {
  const f = factory();
  const text = f.render(f.order('KESTREL', 0)).replaceAll('*', '|').replaceAll('~', '!');
  assert.equal(parseX12Order(text).action, 'NEW');
});

test('X12: a wrong SE segment count is rejected with enough context for a 997', () => {
  const f = factory();
  const text = f.render(f.order('KESTREL', 0, { defect: 'syntax' }));
  try {
    parseX12Order(text);
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.code, 'X12_SEGMENT_COUNT');
    assert.ok(err.detail.groupControl);
    const ack = build997({ receiverId: 'KESTRELOUTDOOR', control: 9, date: '2026-11-16', ack: err.detail, accepted: false });
    assert.match(ack, /AK5\*R\*5~/);
    assert.match(ack, /AK9\*R\*1\*1\*0~/);
    assert.equal(parseInterchange(ack).groups[0].transactions[0].type, '997');
  }
});

test('X12: envelope faults are named precisely', () => {
  const f = factory();
  const good = f.render(f.order('KESTREL', 0));
  assert.equal(codeOf(() => parseX12Order('GARBAGE')), 'X12_NO_ISA');
  assert.equal(codeOf(() => parseX12Order(good.replace(/IEA\*1\*\d+~/, 'IEA*1*999999999~'))), 'X12_CONTROL_MISMATCH');
  assert.equal(codeOf(() => parseX12Order(good.replace(/CTT\*\d+~/, 'CTT*9~'))), 'X12_CTT_MISMATCH');
  assert.equal(codeOf(() => parseX12Order(good.replace(/BEG\*00\*SA\*[^~]+~\n/, '').replace(/SE\*(\d+)\*/, (_, n) => `SE*${n - 1}*`))), 'X12_MISSING_SEGMENT');
});

test('X12 860: a change request carries its revision and line deltas', () => {
  const f = factory();
  const v0 = f.order('KESTREL', 0, { lines: 2 });
  const v1 = f.change(v0, 'addLine');
  const raw = parseX12Order(f.render(v1));
  assert.equal(raw.action, 'CHANGE');
  assert.equal(raw.revision, 1);
  assert.equal(raw.changes.length, 1);
  assert.equal(raw.changes[0].op, 'AI');
  const cancel = parseX12Order(f.render(f.change(v0, 'cancel')));
  assert.equal(cancel.action, 'CANCEL');
});

test('X12: an interchange with several transaction sets is split into one message each', () => {
  const f = factory();
  const a = tokenize(f.render(f.order('KESTREL', 0))).segs;
  const b = tokenize(f.render(f.order('KESTREL', 0))).segs;
  const body = (segs) => segs.filter((s) => !['ISA', 'GS', 'GE', 'IEA'].includes(s[0]));
  const second = body(b).map((s) => (s[0] === 'ST' || s[0] === 'SE' ? [...s.slice(0, -1), '0002'] : s));
  const combined = [a[0], a[1], ...body(a), ...second, ['GE', '2', a[1][6]], ['IEA', '1', a[0][13]]].map((s) => s.join('*') + '~').join('\n');
  assert.equal(parseInterchange(combined).groups[0].transactions.length, 2);
  const parts = splitX12(combined);
  assert.equal(parts.length, 2);
  assert.notEqual(parseX12Order(parts[0]).poNumber, parseX12Order(parts[1]).poNumber);
});

test('XML reader: elements, attributes, entities, comments and self-closing tags', () => {
  const doc = parseXml('<?xml version="1.0"?><!-- c --><a id="1" t=\'x &amp; y\'><b>R&amp;D &lt;1&gt;</b><c/><!-- inner --><d k="v"></d></a>');
  assert.equal(doc.name, 'a');
  assert.equal(doc.attrs.t, 'x & y');
  assert.equal(childText(doc, 'b'), 'R&D <1>');
  assert.deepEqual(child(doc, 'c').children, []);
  assert.equal(child(doc, 'd').attrs.k, 'v');
  assert.equal(codeOf(() => parseXml('<a><b></a>')), 'XML_MALFORMED');
  assert.equal(codeOf(() => parseXml('<a></a><b/>')), 'XML_MALFORMED');
  assert.equal(codeOf(() => parseXml('')), 'XML_MALFORMED');
});

test('XML, JSON and CSV adapters produce the same raw order shape', () => {
  for (const partnerId of ['MARLOWE', 'ALDER', 'TIDEWATER']) {
    const f = factory();
    const spec = f.order(partnerId, 0, { lines: 3 });
    const p = md.partners[partnerId];
    const raw = adapters[p.format].parse(f.render(spec));
    assert.equal(raw.poNumber, spec.poNumber, partnerId);
    assert.equal(raw.orderDate, spec.orderDate, partnerId);
    assert.equal(raw.shipDate, spec.shipDate, partnerId);
    assert.equal(raw.lines.length, 3, partnerId);
    assert.equal(raw.lines[0].unitPrice, spec.lines[0].unitPrice, partnerId);
  }
});

test('broken payloads are rejected by each adapter', () => {
  const f = factory();
  assert.equal(codeOf(() => adapters.xml.parse(f.render(f.order('MARLOWE', 0, { defect: 'syntax' })))), 'XML_MALFORMED');
  assert.equal(codeOf(() => adapters.json.parse(f.render(f.order('ALDER', 0, { defect: 'syntax' })))), 'JSON_MALFORMED');
  assert.equal(codeOf(() => adapters.csv.parse(f.render(f.order('TIDEWATER', 0, { defect: 'syntax' })))), 'CSV_ROW');
  assert.equal(codeOf(() => adapters.csv.parse('a,b\n1,2')), 'CSV_HEADER');
  assert.equal(codeOf(() => adapters.json.parse('{"po":{"number":"A1","orderedOn":"16/11/2026"},"items":[]}')), 'BAD_DATE');
});

test('CSV splitter: one file becomes one message per order, and a damaged row condemns only its own order', () => {
  const f = factory();
  const specs = [f.order('TIDEWATER', 0, { lines: 2 }), f.order('TIDEWATER', 0, { lines: 2, defect: 'syntax' }), f.order('TIDEWATER', 0, { lines: 1 })];
  const parts = splitCsv(f.renderFile(specs));
  assert.equal(parts.length, 3);
  assert.equal(parseCsvOrder(parts[0]).lines.length, 2);
  assert.equal(codeOf(() => parseCsvOrder(parts[1])), 'CSV_ROW');
  assert.equal(parseCsvOrder(parts[2]).poNumber, specs[2].poNumber);
});

test('mapping: buyer item codes, units and case packs resolve to the canonical order', () => {
  const p = md.partners.ALDER;
  const part = md.buyerPart('ALDER', 'BT-0750');
  const raw = { poNumber: 'A1', revision: 0, action: 'NEW', orderDate: '2026-11-16', shipDate: '2026-11-25', currency: 'USD', shipToCode: 'alder-sea', lines: [{ lineNo: 1, buyerPart: part, qty: 3, uom: 'case', unitPrice: md.contractPrice('ALDER', 'BT-0750', 'CS') }], declared: {} };
  const { order, issues } = toCanonical(raw, p, md, {});
  assert.equal(issues.length, 0);
  assert.equal(order.lines[0].sku, 'BT-0750');
  assert.equal(order.lines[0].uom, 'CS');
  assert.equal(order.lines[0].qtyBase, 36);
  assert.equal(order.totals.units, 36);
  assert.equal(order.shipTo.city, 'Seattle');
  assert.deepEqual(validateOrder(order, p, md), []);
});

test('mapping gaps and rule failures are reported as issues, never thrown', () => {
  const p = md.partners.MARLOWE;
  const raw = { poNumber: 'MF-1', revision: 0, action: 'NEW', orderDate: '2026-11-16', shipDate: '2026-11-17', currency: 'USD', shipToCode: 'NOPE', lines: [{ lineNo: 1, buyerPart: '999999', qty: 0, uom: 'BOX', unitPrice: 1 }, { lineNo: 1, buyerPart: md.buyerPart('MARLOWE', 'LN-0100'), qty: 5, uom: 'EA', unitPrice: 99 }], declared: { totalAmount: 1 } };
  const { order, issues } = toCanonical(raw, p, md, {});
  const codes = [...issues, ...validateOrder(order, p, md)].map((i) => i.code);
  for (const expected of ['UNKNOWN_ITEM', 'UNKNOWN_UOM', 'UNKNOWN_SHIP_TO', 'QTY_INVALID', 'DUPLICATE_LINE', 'ITEM_INACTIVE', 'PRICE_MISMATCH', 'SHIP_DATE_TOO_EARLY', 'TOTAL_MISMATCH']) {
    assert.ok(codes.includes(expected), `missing ${expected} in ${codes}`);
  }
});

test('delta changes apply in order and report a missing target', () => {
  const base = [{ lineNo: 1, sku: 'A', qty: 2, qtyBase: 24, unitPrice: 10, lineAmount: 20 }, { lineNo: 2, sku: 'B', qty: 5, qtyBase: 5, unitPrice: 4, lineAmount: 20 }];
  const { lines, issues } = applyChanges(base, [
    { op: 'QI', lineNo: 1, qty: 3 },
    { op: 'PC', lineNo: 2, unitPrice: 5 },
    { op: 'AI', lineNo: 3, sku: 'C', qty: 1, qtyBase: 1, unitPrice: 7, lineAmount: 7 },
    { op: 'DI', lineNo: 9 },
  ]);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].qtyBase, 36);
  assert.equal(lines[0].lineAmount, 30);
  assert.equal(lines[1].lineAmount, 25);
  assert.deepEqual(issues.map((i) => i.code), ['CHANGE_TARGET_MISSING']);
  assert.equal(base[0].qty, 2, 'the base revision is not mutated');
});

test('acknowledgments are written in each partner format', () => {
  const order = { poNumber: 'P1', revision: 0, orderDate: '2026-11-16', requestedShipDate: '2026-11-25', currency: 'USD', totals: { amount: 120 }, lines: [{ lineNo: 1, buyerPart: 'KOC-10000', qty: 4, uom: 'CS', unitPrice: 30 }] };
  const args = { order, outcome: 'accepted', soNumber: '5000001', controlNumber: 801, date: '2026-11-16', md };
  const edi = buildAck(md.partners.KESTREL, args)[0].text;
  assert.match(edi, /BAK\*00\*AD\*P1\*20261116\*\*\*\*5000001~/);
  assert.match(edi, /ACK\*IA\*4\*CA\*068\*20261125~/);
  assert.equal(parseInterchange(edi).groups[0].transactions[0].type, '855');
  assert.match(buildAck(md.partners.MARLOWE, args)[0].text, /<OrderResponse status="Accepted">/);
  assert.equal(JSON.parse(buildAck(md.partners.ALDER, { ...args, outcome: 'changed' })[0].text).status, 'AcceptedWithChanges');
  assert.match(buildAck(md.partners.TIDEWATER, args)[0].text, /P1,0,Accepted,5000001,2026-11-25,120\.00/);
});

// Synthetic traffic. Builds orders the way each partner would transmit them, including the defects
// real partners produce. Seeded, so a scenario sends exactly the same bytes on every run.
import { BASE_EPOCH, createRng, pad, isoDate, addDays, round2, usDate } from './util.js';
import { NEW_ITEM_SKU, DISCONTINUED_SKU } from './masterdata.js';
import { build850, build860 } from './formats/x12.js';
import { escapeXml } from './formats/xml.js';
import { CSV_HEADER } from './formats/index.js';

export const DEFECTS = ['unknownItem', 'price', 'earlyShip', 'inactive', 'syntax', 'total'];

export class OrderFactory {
  constructor(md, seed = 1) {
    this.md = md;
    this.rng = createRng(seed + 31);
    this.counters = {};
    this.control = 100;
    this.orderable = Object.values(md.items).filter((i) => i.active && i.sku !== NEW_ITEM_SKU).map((i) => i.sku);
  }

  #line(partnerId, sku, lineNo) {
    const item = this.md.items[sku];
    const uom = this.rng.chance(0.4) ? 'CS' : 'EA';
    const qty = uom === 'CS' ? this.rng.int(1, 12) : this.rng.int(1, 16) * 6;
    return { lineNo, sku, buyerPart: this.md.buyerPart(partnerId, sku), description: item.description, qty, uom, unitPrice: this.md.contractPrice(partnerId, sku, uom) };
  }

  // A new order as a format-neutral spec. `defect` plants one realistic problem in it.
  order(partnerId, now, { defect = null, lines = null } = {}) {
    const p = this.md.partners[partnerId];
    const n = (this.counters[partnerId] = (this.counters[partnerId] ?? 0) + 1);
    const orderDate = isoDate(BASE_EPOCH + now);
    const spec = {
      partnerId,
      poNumber: `${p.poPrefix}${pad(10000 + n * 7 + this.rng.int(0, 5), 5)}`,
      revision: 0,
      action: 'NEW',
      orderDate,
      shipDate: addDays(orderDate, this.rng.int(p.leadDays + 2, 21)),
      shipToCode: this.rng.pick(Object.keys(p.shipTos)),
      lines: this.rng.sample(this.orderable, lines ?? this.rng.int(1, 5)).map((sku, i) => this.#line(partnerId, sku, i + 1)),
      defect,
    };
    const target = this.rng.pick(spec.lines);
    if (defect === 'unknownItem') Object.assign(target, { sku: NEW_ITEM_SKU, buyerPart: p.unmapped[NEW_ITEM_SKU], description: this.md.items[NEW_ITEM_SKU].description, unitPrice: this.md.contractPrice(partnerId, NEW_ITEM_SKU, target.uom) });
    else if (defect === 'price') target.unitPrice = round2(target.unitPrice * 1.08);
    else if (defect === 'earlyShip') spec.shipDate = addDays(orderDate, 1);
    else if (defect === 'inactive') Object.assign(target, { sku: DISCONTINUED_SKU, buyerPart: this.md.buyerPart(partnerId, DISCONTINUED_SKU), description: this.md.items[DISCONTINUED_SKU].description, unitPrice: this.md.contractPrice(partnerId, DISCONTINUED_SKU, target.uom) });
    else if (defect === 'total' && p.format !== 'xml') { spec.defect = 'price'; target.unitPrice = round2(target.unitPrice * 1.08); }
    return spec;
  }

  // The next revision of an order. X12 partners send it as a delta, the others as a full replacement.
  change(prev, kind = 'qty') {
    const lines = prev.lines.map((l) => ({ ...l }));
    const spec = { ...prev, revision: prev.revision + 1, action: 'CHANGE', lines, changes: [], defect: null };
    if (kind === 'cancel') return { ...spec, action: 'CANCEL', lines: [], changes: [] };
    if (kind === 'addLine') {
      const used = new Set(lines.map((l) => l.sku));
      const sku = this.orderable.find((s) => !used.has(s));
      const line = this.#line(prev.partnerId, sku, Math.max(...lines.map((l) => l.lineNo)) + 1);
      lines.push(line);
      spec.changes.push({ op: 'AI', ...line });
    } else if (kind === 'dropLine' && lines.length > 1) {
      const gone = lines.pop();
      spec.changes.push({ op: 'DI', ...gone });
    } else {
      const line = lines[0];
      const before = line.qty;
      line.qty = line.uom === 'CS' ? before + this.rng.int(1, 6) : before + this.rng.int(1, 4) * 6;
      spec.changes.push({ op: 'QI', ...line });
    }
    return spec;
  }

  // Wire format. Rendering twice gives a new envelope (new control number or message id) around the same order.
  render(spec, { corrupt = false } = {}) {
    const p = this.md.partners[spec.partnerId];
    const raw = (uom) => this.md.rawUom(p.id, uom);
    const control = ++this.control;
    const bad = corrupt || spec.defect === 'syntax';

    if (p.format === 'x12') {
      const po = { ...spec, shipToName: p.shipTos[spec.shipToCode]?.name ?? '', lines: spec.lines.map((l) => ({ ...l, uom: raw(l.uom) })), changes: (spec.changes ?? []).map((c) => ({ ...c, uom: raw(c.uom) })) };
      if (spec.action !== 'NEW') return build860({ senderId: p.interchangeId, control, po });
      return build850({ senderId: p.interchangeId, control, po, corruptSegmentCount: bad });
    }

    if (p.format === 'xml') {
      const action = { NEW: 'New', CHANGE: 'Replace', CANCEL: 'Cancel' }[spec.action];
      const total = round2(spec.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)) + (spec.defect === 'total' ? 50 : 0);
      const out = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<PurchaseOrder version="2" messageId="MF-${pad(control, 8)}">`,
        '  <Header>',
        `    <PONumber>${escapeXml(spec.poNumber)}</PONumber>`,
        `    <Revision>${spec.revision}</Revision>`,
        `    <Action>${action}</Action>`,
        `    <OrderDate>${spec.orderDate}</OrderDate>`,
        `    <ShipBy>${spec.shipDate}</ShipBy>`,
        '    <Currency>USD</Currency>',
        `    <ShipTo code="${spec.shipToCode}"/>`,
        '  </Header>',
        '  <Lines>',
        ...spec.lines.map((l) => `    <Line number="${l.lineNo}"><ItemCode>${escapeXml(l.buyerPart)}</ItemCode><Description>${escapeXml(l.description)}</Description><Quantity uom="${raw(l.uom)}">${l.qty}</Quantity><UnitPrice>${l.unitPrice.toFixed(2)}</UnitPrice></Line>`),
        bad ? null : '  </Lines>',
        `  <Summary lineCount="${spec.lines.length}" totalAmount="${total.toFixed(2)}"/>`,
        '</PurchaseOrder>',
      ];
      return out.filter((l) => l !== null).join('\n');
    }

    if (p.format === 'json') {
      const doc = {
        messageId: `alder-${pad(control, 8)}`,
        po: { number: spec.poNumber, revision: spec.revision, action: { NEW: 'create', CHANGE: 'replace', CANCEL: 'cancel' }[spec.action], orderedOn: `${spec.orderDate}T08:00:00Z`, shipBy: spec.shipDate, currency: 'USD', shipTo: spec.shipToCode },
        items: spec.lines.map((l) => ({ line: l.lineNo, itemId: l.buyerPart, name: l.description, qty: l.qty, unit: raw(l.uom), price: l.unitPrice })),
      };
      const text = JSON.stringify(doc, null, 2);
      return bad ? text.slice(0, Math.floor(text.length * 0.7)) : text;
    }

    return [CSV_HEADER, ...this.#csvRows(spec, bad)].join('\n');
  }

  #csvRows(spec, bad = false) {
    const raw = (uom) => this.md.rawUom(spec.partnerId, uom);
    const head = [spec.poNumber, spec.revision, spec.action, usDate(spec.orderDate), usDate(spec.shipDate), spec.shipToCode];
    if (spec.action === 'CANCEL') return [[...head, '', '', '', '', ''].join(',')];
    return spec.lines.map((l, i) => {
      const cols = [...head, l.lineNo, l.buyerPart, l.qty, raw(l.uom), l.unitPrice.toFixed(2)];
      if (bad && i === 0) cols.pop(); // a truncated row, as a broken export would produce
      return cols.join(',');
    });
  }

  // One file carrying several orders, as an SFTP batch partner would drop it.
  renderFile(specs) {
    return [CSV_HEADER, ...specs.flatMap((s) => this.#csvRows(s, s.defect === 'syntax'))].join('\n');
  }
}

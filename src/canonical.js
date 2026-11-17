// The canonical order: the one shape every partner format is translated into, and the only shape
// the rules, the sequencer and the ERP connector ever see. Adding a partner means writing an adapter
// and a mapping profile. Nothing downstream changes.
import { round2 } from './util.js';

export const ISSUES = {
  UNKNOWN_ITEM: { title: 'Item code has no cross-reference', fix: 'mapItem' },
  UNKNOWN_UOM: { title: 'Unit of measure is not mapped', fix: null },
  UNKNOWN_SHIP_TO: { title: 'Ship-to location is not on file', fix: null },
  ITEM_INACTIVE: { title: 'Item is discontinued', fix: null },
  PRICE_MISMATCH: { title: 'Price differs from the contract price', fix: 'acceptPrice' },
  SHIP_DATE_TOO_EARLY: { title: 'Requested ship date is inside the lead time', fix: 'moveShipDate' },
  QTY_INVALID: { title: 'Quantity is not a positive whole number', fix: null },
  DUPLICATE_LINE: { title: 'Line number is repeated', fix: null },
  NO_LINES: { title: 'Order has no lines', fix: null },
  TOTAL_MISMATCH: { title: 'Declared total does not match the lines', fix: null },
  CONFLICTING_RESEND: { title: 'Same order and revision re-sent with different content', fix: null },
  PREDECESSOR_MISSING: { title: 'Earlier revision never arrived', fix: null },
  CHANGE_TARGET_MISSING: { title: 'Change refers to a line that does not exist', fix: null },
  ORDER_CANCELLED: { title: 'Order is already cancelled', fix: null },
};

export const issue = (code, message, extra = {}) => ({ code, title: ISSUES[code].title, fix: ISSUES[code].fix, severity: 'error', message, waived: false, ...extra });

export function totals(lines) {
  return {
    lines: lines.length,
    units: lines.reduce((s, l) => s + (l.qtyBase || 0), 0),
    amount: round2(lines.reduce((s, l) => s + (l.lineAmount || 0), 0)),
  };
}

// Translate a raw line using the partner's mapping profile. Mapping gaps are recorded, never thrown:
// a missing cross-reference is a business exception for a person to fix, not a crash.
function mapLine(raw, partner, md, issues) {
  const sku = partner.xref[raw.buyerPart] ?? null;
  const uom = partner.uomMap[raw.uom] ?? null;
  const item = sku ? md.items[sku] : null;
  if (!sku) issues.push(issue('UNKNOWN_ITEM', `Line ${raw.lineNo}: ${partner.name} item code ${raw.buyerPart || '(blank)'} is not in the cross-reference`, { lineNo: raw.lineNo, buyerPart: raw.buyerPart }));
  if (!uom) issues.push(issue('UNKNOWN_UOM', `Line ${raw.lineNo}: unit "${raw.uom}" is not mapped for ${partner.name}`, { lineNo: raw.lineNo }));
  const factor = uom === 'CS' && item ? item.casePack : 1;
  return {
    lineNo: raw.lineNo,
    sku,
    buyerPart: raw.buyerPart,
    description: item?.description ?? raw.description ?? '',
    qty: raw.qty,
    uom: uom ?? raw.uom,
    qtyBase: Number.isFinite(raw.qty) ? raw.qty * factor : 0,
    unitPrice: raw.unitPrice,
    lineAmount: round2((raw.qty || 0) * (raw.unitPrice || 0)),
  };
}

export function toCanonical(raw, partner, md, source) {
  const issues = [];
  const shipTo = raw.shipToCode ? partner.shipTos[raw.shipToCode] : null;
  if (raw.action === 'NEW' && !shipTo) issues.push(issue('UNKNOWN_SHIP_TO', `Ship-to code "${raw.shipToCode}" is not on file for ${partner.name}`));

  const lines = raw.lines ? raw.lines.map((l) => mapLine(l, partner, md, issues)) : null;
  const changes = raw.changes ? raw.changes.map((c) => ({ op: c.op, ...mapLine(c, partner, md, c.op === 'DI' ? [] : issues) })) : null;

  const order = {
    orderId: `${partner.id}:${raw.poNumber}`,
    partnerId: partner.id,
    poNumber: raw.poNumber,
    revision: raw.revision,
    type: raw.action,
    orderDate: raw.orderDate,
    requestedShipDate: raw.shipDate,
    currency: raw.currency || 'USD',
    shipTo: raw.shipToCode ? { code: raw.shipToCode, ...(shipTo ?? {}) } : null,
    lines: lines ?? [],
    changes,
    declared: raw.declared ?? {},
    totals: totals(lines ?? []),
    source,
  };
  return { order, issues };
}

// What makes two transmissions "the same order": used to recognise a resend that arrives in a new envelope.
export function semanticString(order) {
  const line = (l) => [l.lineNo, l.buyerPart, l.qty, l.uom, l.unitPrice, l.op ?? ''].join(':');
  return [order.type, order.requestedShipDate, order.shipTo?.code ?? '', (order.lines ?? []).map(line).join('|'), (order.changes ?? []).map(line).join('|')].join('~');
}

// X12 860 sends deltas (add, delete, change quantity, change price). XML, JSON and CSV partners send a
// full replacement. Both end as a complete set of lines so the ERP always receives a whole document.
export function applyChanges(baseLines, changes) {
  const lines = baseLines.map((l) => ({ ...l }));
  const issues = [];
  for (const c of changes) {
    const idx = lines.findIndex((l) => l.lineNo === c.lineNo);
    const { op, ...line } = c;
    if (op === 'AI') {
      if (idx >= 0) issues.push(issue('DUPLICATE_LINE', `Change adds line ${c.lineNo}, which already exists`, { lineNo: c.lineNo }));
      else lines.push(line);
    } else if (idx < 0) {
      issues.push(issue('CHANGE_TARGET_MISSING', `Change ${op} targets line ${c.lineNo}, which is not on the order`, { lineNo: c.lineNo }));
    } else if (op === 'DI') {
      lines.splice(idx, 1);
    } else if (op === 'QI' || op === 'QD') {
      const cur = lines[idx];
      const factor = cur.qty ? cur.qtyBase / cur.qty : 1;
      lines[idx] = { ...cur, qty: c.qty, qtyBase: c.qty * factor, lineAmount: round2(c.qty * cur.unitPrice) };
    } else if (op === 'PC') {
      const cur = lines[idx];
      lines[idx] = { ...cur, unitPrice: c.unitPrice, lineAmount: round2(cur.qty * c.unitPrice) };
    } else {
      lines[idx] = line; // RZ: replace all values
    }
  }
  lines.sort((a, b) => a.lineNo - b.lineNo);
  return { lines, issues };
}

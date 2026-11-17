// Format adapters. Each one turns a partner's wire format into the same format-neutral "raw order"
// and knows how to write that partner's acknowledgment. Nothing past this file knows a wire format.
import { ParseError, isIsoDate, round2 } from '../util.js';
import { parseXml, child, children, childText, escapeXml } from './xml.js';
import { splitX12, parseX12Order, build997, build855 } from './x12.js';

const requireIso = (value, what) => {
  if (!isIsoDate(value)) throw new ParseError('BAD_DATE', `${what} "${value}" is not a valid YYYY-MM-DD date`);
  return value;
};
const optionalIso = (value, what) => (value ? requireIso(value, what) : '');

// ---------- XML (Marlowe & Finch) ----------

const XML_ACTIONS = { New: 'NEW', Replace: 'CHANGE', Cancel: 'CANCEL' };

export function parseXmlOrder(text) {
  const root = parseXml(text);
  if (root.name !== 'PurchaseOrder') throw new ParseError('XML_UNEXPECTED_ROOT', `Root element is <${root.name}>, expected <PurchaseOrder>`);
  const header = child(root, 'Header');
  if (!header) throw new ParseError('XML_MISSING_ELEMENT', 'Document has no <Header> element');
  const poNumber = childText(header, 'PONumber');
  if (!poNumber) throw new ParseError('XML_MISSING_ELEMENT', '<Header> has no <PONumber>');
  const actionText = childText(header, 'Action') || 'New';
  const action = XML_ACTIONS[actionText];
  if (!action) throw new ParseError('XML_BAD_VALUE', `<Action> "${actionText}" is not New, Replace or Cancel`);
  const linesNode = child(root, 'Lines');
  const lines = (linesNode ? children(linesNode, 'Line') : []).map((l) => ({
    lineNo: Number(l.attrs.number),
    buyerPart: childText(l, 'ItemCode'),
    description: childText(l, 'Description'),
    qty: Number(childText(l, 'Quantity')),
    uom: child(l, 'Quantity')?.attrs.uom ?? '',
    unitPrice: Number(childText(l, 'UnitPrice')),
  }));
  const summary = child(root, 'Summary');
  return {
    poNumber,
    revision: Number(childText(header, 'Revision') || 0),
    action,
    orderDate: requireIso(childText(header, 'OrderDate'), '<OrderDate>'),
    shipDate: optionalIso(childText(header, 'ShipBy'), '<ShipBy>'),
    currency: childText(header, 'Currency') || 'USD',
    shipToCode: child(header, 'ShipTo')?.attrs.code ?? '',
    lines,
    declared: summary ? { lineCount: Number(summary.attrs.lineCount), totalAmount: Number(summary.attrs.totalAmount) } : {},
    envelope: { messageId: root.attrs.messageId ?? '' },
  };
}

// ---------- JSON (Alder Home Goods) ----------

const JSON_ACTIONS = { create: 'NEW', replace: 'CHANGE', cancel: 'CANCEL' };

export function parseJsonOrder(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new ParseError('JSON_MALFORMED', `Body is not valid JSON: ${err.message}`);
  }
  const po = doc?.po;
  if (!po || !po.number) throw new ParseError('JSON_MISSING_FIELD', 'Body has no po.number');
  const action = JSON_ACTIONS[po.action ?? 'create'];
  if (!action) throw new ParseError('JSON_BAD_VALUE', `po.action "${po.action}" is not create, replace or cancel`);
  if (action !== 'CANCEL' && !Array.isArray(doc.items)) throw new ParseError('JSON_MISSING_FIELD', 'Body has no items array');
  return {
    poNumber: String(po.number),
    revision: Number(po.revision ?? 0),
    action,
    orderDate: requireIso(String(po.orderedOn ?? '').slice(0, 10), 'po.orderedOn'),
    shipDate: optionalIso(String(po.shipBy ?? '').slice(0, 10), 'po.shipBy'),
    currency: po.currency ?? 'USD',
    shipToCode: po.shipTo ?? '',
    lines: (doc.items ?? []).map((it) => ({ lineNo: Number(it.line), buyerPart: String(it.itemId ?? ''), description: it.name ?? '', qty: Number(it.qty), uom: String(it.unit ?? ''), unitPrice: Number(it.price) })),
    declared: {},
    envelope: { messageId: doc.messageId ?? '' },
  };
}

// ---------- CSV batch file over SFTP (Tidewater Wholesale) ----------

export const CSV_HEADER = 'po_number,revision,action,order_date,ship_date,ship_to,line,item,qty,uom,unit_price';
const CSV_ACTIONS = { NEW: 'NEW', CHANGE: 'CHANGE', CANCEL: 'CANCEL' };
const fromUsDate = (v, what) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  if (!m) throw new ParseError('BAD_DATE', `${what} "${v}" is not MM/DD/YYYY`);
  return requireIso(`${m[3]}-${m[1]}-${m[2]}`, what);
};

// Splitter: one file carries many orders. Each becomes its own message so one bad order cannot block the rest.
export function splitCsv(text) {
  const rows = text.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (rows.length < 2 || rows[0] !== CSV_HEADER) return [text];
  const groups = new Map();
  for (const row of rows.slice(1)) {
    const cols = row.split(',');
    // A damaged row stays with its order, so the whole order is rejected instead of posting without a line.
    const key = cols.length >= 2 ? `${cols[0]}#${cols[1]}` : `?${groups.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((g) => [CSV_HEADER, ...g].join('\n'));
}

export function parseCsvOrder(text) {
  const rows = text.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  if (rows[0] !== CSV_HEADER) throw new ParseError('CSV_HEADER', 'File header does not match the agreed column layout');
  if (rows.length < 2) throw new ParseError('CSV_EMPTY', 'File has a header and no order rows');
  const recs = rows.slice(1).map((row, i) => {
    const c = row.split(',');
    if (c.length !== 11) throw new ParseError('CSV_ROW', `Row ${i + 2} has ${c.length} columns, expected 11`);
    return c;
  });
  const [po, rev, act, orderDate, shipDate, shipTo] = recs[0];
  const action = CSV_ACTIONS[act];
  if (!action) throw new ParseError('CSV_BAD_VALUE', `action "${act}" is not NEW, CHANGE or CANCEL`);
  return {
    poNumber: po,
    revision: Number(rev || 0),
    action,
    orderDate: fromUsDate(orderDate, 'order_date'),
    shipDate: shipDate ? fromUsDate(shipDate, 'ship_date') : '',
    currency: 'USD',
    shipToCode: shipTo,
    lines: action === 'CANCEL' ? [] : recs.map((c) => ({ lineNo: Number(c[6]), buyerPart: c[7], description: '', qty: Number(c[8]), uom: c[9], unitPrice: Number(c[10]) })),
    declared: {},
    envelope: {},
  };
}

// ---------- acknowledgments back to the partner ----------

const outcomeWord = { accepted: 'Accepted', changed: 'AcceptedWithChanges', rejected: 'Rejected' };

// `outcome` is accepted | changed | rejected. Returns the documents to send, in order.
export function buildAck(partner, { order, outcome, soNumber, reasons = [], controlNumber, date, md }) {
  const amount = order?.totals?.amount ?? 0;
  switch (partner.format) {
    case 'x12':
      return [{ type: '855 PO Acknowledgment', text: build855({ receiverId: partner.interchangeId, control: controlNumber, date, order, ackType: { accepted: 'AD', changed: 'AC', rejected: 'RD' }[outcome], soNumber, rawUom: (u) => md.rawUom(partner.id, u) }) }];
    case 'xml':
      return [{
        type: 'OrderResponse',
        text: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          `<OrderResponse status="${outcomeWord[outcome]}">`,
          `  <PONumber>${escapeXml(order.poNumber)}</PONumber>`,
          `  <Revision>${order.revision}</Revision>`,
          soNumber ? `  <SalesOrder>${soNumber}</SalesOrder>` : null,
          `  <ConfirmedShipDate>${order.requestedShipDate}</ConfirmedShipDate>`,
          `  <TotalAmount currency="${order.currency}">${amount.toFixed(2)}</TotalAmount>`,
          ...reasons.map((r) => `  <Reason code="${escapeXml(r.code)}">${escapeXml(r.message)}</Reason>`),
          '</OrderResponse>',
        ].filter(Boolean).join('\n'),
      }];
    case 'json':
      return [{ type: 'Order response', text: JSON.stringify({ po: order.poNumber, revision: order.revision, status: outcomeWord[outcome], salesOrder: soNumber ?? null, confirmedShipDate: order.requestedShipDate, totalAmount: round2(amount), reasons: reasons.map((r) => ({ code: r.code, message: r.message })) }, null, 2) }];
    default:
      return [{ type: 'Confirmation file row', text: `po_number,revision,status,sales_order,confirmed_ship_date,total_amount\n${order.poNumber},${order.revision},${outcomeWord[outcome]},${soNumber ?? ''},${order.requestedShipDate},${amount.toFixed(2)}` }];
  }
}

// Sent when the payload could not be read at all, so there is no order to acknowledge.
export function buildSyntaxReject(partner, { error, controlNumber, date }) {
  switch (partner.format) {
    case 'x12':
      if (!error.detail?.groupControl) return [{ type: 'No acknowledgment possible', text: `The interchange envelope could not be read, so no 997 can reference it.\nIn production this returns a TA1 interchange acknowledgment or an alert to the partner's EDI contact.\n\n${error.code}: ${error.message}` }];
      return [{ type: '997 Functional Acknowledgment (rejected)', text: build997({ receiverId: partner.interchangeId, control: controlNumber, date, ack: error.detail, accepted: false }) }];
    case 'xml':
      return [{ type: 'Error response', text: `<?xml version="1.0" encoding="UTF-8"?>\n<Error code="${escapeXml(error.code)}">${escapeXml(error.message)}</Error>` }];
    case 'json':
      return [{ type: 'HTTP 400 response', text: JSON.stringify({ error: error.code, message: error.message }, null, 2) }];
    default:
      return [{ type: 'Rejected rows report', text: `status,code,message\nRejected,${error.code},${error.message.replaceAll(',', ';')}` }];
  }
}

export function buildSyntaxAccept(partner, { envelope, controlNumber, date }) {
  if (partner.format !== 'x12') return [];
  return [{ type: '997 Functional Acknowledgment', text: build997({ receiverId: partner.interchangeId, control: controlNumber, date, ack: envelope, accepted: true }) }];
}

export const adapters = {
  x12: { label: 'X12 EDI 4010', split: splitX12, parse: parseX12Order },
  xml: { label: 'XML', split: (t) => [t], parse: parseXmlOrder },
  json: { label: 'JSON', split: (t) => [t], parse: parseJsonOrder },
  csv: { label: 'CSV file', split: splitCsv, parse: parseCsvOrder },
};

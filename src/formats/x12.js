// ANSI X12 version 004010, the subset an order-to-acknowledgment flow needs:
//   inbound  850 Purchase Order, 860 Purchase Order Change Request (buyer initiated)
//   outbound 997 Functional Acknowledgment, 855 Purchase Order Acknowledgment
// This is a reference implementation for study and demonstration, not a certified translator.
import { ParseError, pad, compactDate } from '../util.js';

const EL = '*';
const TERM = '~';
const toIso = (d, what) => {
  if (!/^\d{8}$/.test(d ?? '')) throw new ParseError('X12_BAD_DATE', `${what} "${d ?? ''}" is not a CCYYMMDD date`);
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
};

// The ISA segment is fixed width, so the delimiters are read from known positions rather than assumed.
export function tokenize(text) {
  const t = text.replace(/^\s+/, '');
  if (!t.startsWith('ISA')) throw new ParseError('X12_NO_ISA', 'Interchange does not start with an ISA segment');
  const el = t[3];
  let term = t.length > 105 ? t[105] : TERM;
  if (/[A-Za-z0-9 ]/.test(term)) term = TERM;
  const segs = t
    .split(term)
    .map((s) => s.replace(/[\r\n]+/g, '').trim())
    .filter(Boolean)
    .map((s) => s.split(el));
  return { el, term, segs };
}

export function parseInterchange(text) {
  const { segs } = tokenize(text);
  const isa = segs[0];
  if (isa.length < 17) throw new ParseError('X12_BAD_ISA', `ISA segment has ${isa.length - 1} elements, expected 16`);
  const iea = segs.at(-1);
  if (iea[0] !== 'IEA') throw new ParseError('X12_NO_IEA', 'Interchange is not closed by an IEA segment');
  const out = { senderId: isa[6].trim(), receiverId: isa[8].trim(), controlNumber: isa[13], groups: [] };
  if (iea[2] !== isa[13]) {
    throw new ParseError('X12_CONTROL_MISMATCH', `IEA control number ${iea[2]} does not match ISA ${isa[13]}`);
  }

  let group = null;
  let tx = null;
  for (const s of segs.slice(1, -1)) {
    const ctx = () => ({ senderId: out.senderId, groupControl: group?.controlNumber, functionalId: group?.functionalId, txType: tx?.type, txControl: tx?.controlNumber });
    if (s[0] === 'GS') {
      group = { functionalId: s[1], controlNumber: s[6], transactions: [] };
      out.groups.push(group);
    } else if (s[0] === 'GE') {
      if (!group) throw new ParseError('X12_ENVELOPE', 'GE segment without a matching GS');
      if (Number(s[1]) !== group.transactions.length || s[2] !== group.controlNumber) {
        throw new ParseError('X12_GROUP_COUNT', `GE reports ${s[1]} transaction sets, found ${group.transactions.length}`, ctx());
      }
      group = null;
    } else if (s[0] === 'ST') {
      if (!group) throw new ParseError('X12_ENVELOPE', 'ST segment outside a functional group');
      tx = { type: s[1], controlNumber: s[2], segments: [] };
      group.transactions.push(tx);
    } else if (s[0] === 'SE') {
      if (!tx) throw new ParseError('X12_ENVELOPE', 'SE segment without a matching ST');
      const counted = tx.segments.length + 2; // ST and SE are included in the count
      if (Number(s[1]) !== counted) {
        throw new ParseError('X12_SEGMENT_COUNT', `SE01 reports ${s[1]} segments, counted ${counted}`, ctx());
      }
      if (s[2] !== tx.controlNumber) {
        throw new ParseError('X12_CONTROL_MISMATCH', `SE02 ${s[2]} does not match ST02 ${tx.controlNumber}`, ctx());
      }
      tx = null;
    } else {
      if (!tx) throw new ParseError('X12_ENVELOPE', `Segment ${s[0]} appears outside a transaction set`);
      tx.segments.push(s);
    }
  }
  if (tx) throw new ParseError('X12_ENVELOPE', 'Transaction set is not closed by an SE segment', { senderId: out.senderId, groupControl: group?.controlNumber, functionalId: group?.functionalId, txType: tx.type, txControl: tx.controlNumber });
  if (Number(iea[1]) !== out.groups.length) {
    throw new ParseError('X12_GROUP_COUNT', `IEA reports ${iea[1]} groups, found ${out.groups.length}`);
  }
  if (!out.groups.length || !out.groups[0].transactions.length) {
    throw new ParseError('X12_EMPTY', 'Interchange carries no transaction set');
  }
  return out;
}

// One inbound message per transaction set. An interchange with several is re-enveloped per set.
export function splitX12(text) {
  let tok;
  try {
    tok = tokenize(text);
  } catch {
    return [text];
  }
  const { el, term, segs } = tok;
  const stCount = segs.filter((s) => s[0] === 'ST').length;
  if (stCount <= 1) return [text];
  const join = (rows) => rows.map((r) => r.join(el) + term).join('\n');
  const isa = segs[0];
  const gs = segs.find((s) => s[0] === 'GS');
  const out = [];
  let cur = null;
  for (const s of segs) {
    if (s[0] === 'ST') cur = [s];
    else if (s[0] === 'SE' && cur) {
      cur.push(s);
      out.push(join([isa, gs, ...cur, ['GE', '1', gs[6]], ['IEA', '1', isa[13]]]));
      cur = null;
    } else if (cur) cur.push(s);
  }
  return out.length ? out : [text];
}

const productId = (seg, from, qualifier) => {
  for (let i = from; i + 1 < seg.length; i += 2) if (seg[i] === qualifier) return seg[i + 1];
  return '';
};

export function parseX12Order(text) {
  const ic = parseInterchange(text);
  const group = ic.groups[0];
  const tx = group.transactions[0];
  const ctx = { senderId: ic.senderId, groupControl: group.controlNumber, functionalId: group.functionalId, txType: tx.type, txControl: tx.controlNumber };
  const first = (id) => tx.segments.find((s) => s[0] === id);
  const need = (id) => {
    const s = first(id);
    if (!s) throw new ParseError('X12_MISSING_SEGMENT', `${tx.type} is missing the mandatory ${id} segment`, ctx);
    return s;
  };
  const envelope = { interchangeControl: ic.controlNumber, groupControl: group.controlNumber, functionalId: group.functionalId, txType: tx.type, txControl: tx.controlNumber, senderId: ic.senderId };

  try {
    if (tx.type === '850') {
      const beg = need('BEG');
      if (beg[1] !== '00') throw new ParseError('X12_UNSUPPORTED', `BEG01 purpose code ${beg[1]} is not supported (00 Original only)`, ctx);
      const ship = tx.segments.find((s) => s[0] === 'DTM' && s[1] === '010');
      const shipTo = tx.segments.find((s) => s[0] === 'N1' && s[1] === 'ST');
      const lines = [];
      for (const s of tx.segments) {
        if (s[0] === 'PO1') lines.push({ lineNo: Number(s[1]), qty: Number(s[2]), uom: s[3], unitPrice: Number(s[4]), buyerPart: productId(s, 6, 'BP'), description: '' });
        else if (s[0] === 'PID' && lines.length) lines.at(-1).description = s[5] ?? '';
      }
      const ctt = first('CTT');
      if (ctt && Number(ctt[1]) !== lines.length) {
        throw new ParseError('X12_CTT_MISMATCH', `CTT01 reports ${ctt[1]} line items, found ${lines.length}`, ctx);
      }
      return { poNumber: beg[3], revision: 0, action: 'NEW', orderDate: toIso(beg[5], 'BEG05 order date'), shipDate: ship ? toIso(ship[2], 'DTM requested ship date') : '', currency: 'USD', shipToCode: shipTo?.[4] ?? '', lines, declared: { lineCount: ctt ? Number(ctt[1]) : null }, envelope };
    }
    if (tx.type === '860') {
      const bch = need('BCH');
      const action = bch[1] === '01' ? 'CANCEL' : bch[1] === '04' ? 'CHANGE' : null;
      if (!action) throw new ParseError('X12_UNSUPPORTED', `BCH01 purpose code ${bch[1]} is not supported (01 Cancellation, 04 Change)`, ctx);
      const ship = tx.segments.find((s) => s[0] === 'DTM' && s[1] === '010');
      const changes = tx.segments
        .filter((s) => s[0] === 'POC')
        .map((s) => ({ lineNo: Number(s[1]), op: s[2], qty: Number(s[3]), uom: s[5], unitPrice: Number(s[6]), buyerPart: productId(s, 8, 'BP') }));
      return { poNumber: bch[3], revision: Number(bch[5] || 1), action, orderDate: toIso(bch[6], 'BCH06 order date'), shipDate: ship ? toIso(ship[2], 'DTM requested ship date') : '', currency: 'USD', shipToCode: '', lines: null, changes, declared: {}, envelope };
    }
  } catch (err) {
    if (err instanceof ParseError && !err.detail.groupControl) err.detail = ctx;
    throw err;
  }
  throw new ParseError('X12_UNSUPPORTED', `Transaction set ${tx.type} is not handled by this hub`, ctx);
}

// ---------- writers ----------

const seg = (...els) => {
  const a = els.map((e) => (e == null ? '' : String(e)));
  while (a.length > 1 && a.at(-1) === '') a.pop();
  return a.join(EL) + TERM;
};

export function envelope({ senderId, receiverId, date, time = '0800', control, functionalId, txType, txControl = '0001', body, seOverride }) {
  const ctl = pad(control, 9);
  const isa = ['ISA', '00', ' '.repeat(10), '00', ' '.repeat(10), 'ZZ', senderId.padEnd(15), 'ZZ', receiverId.padEnd(15), date.slice(2), time, 'U', '00401', ctl, '0', 'P', '>'].join(EL) + TERM;
  return [
    isa,
    seg('GS', functionalId, senderId, receiverId, date, time, Number(control), 'X', '004010'),
    seg('ST', txType, txControl),
    ...body,
    seg('SE', seOverride ?? body.length + 2, txControl),
    seg('GE', 1, Number(control)),
    seg('IEA', 1, ctl),
  ].join('\n');
}

export const HUB_ID = 'ORDERBRIDGE';

// Used by the synthetic-order generator to produce what a partner would transmit.
export function build850({ senderId, control, po, corruptSegmentCount = false }) {
  const body = [seg('BEG', '00', 'SA', po.poNumber, '', compactDate(po.orderDate)), seg('DTM', '010', compactDate(po.shipDate)), seg('N1', 'ST', po.shipToName, '92', po.shipToCode)];
  for (const l of po.lines) {
    body.push(seg('PO1', l.lineNo, l.qty, l.uom, l.unitPrice.toFixed(2), '', 'BP', l.buyerPart));
    body.push(seg('PID', 'F', '', '', '', l.description));
  }
  body.push(seg('CTT', po.lines.length));
  return envelope({ senderId, receiverId: HUB_ID, date: compactDate(po.orderDate), control, functionalId: 'PO', txType: '850', body, seOverride: corruptSegmentCount ? body.length + 5 : undefined });
}

export function build860({ senderId, control, po }) {
  const body = [seg('BCH', po.action === 'CANCEL' ? '01' : '04', 'SA', po.poNumber, '', po.revision, compactDate(po.orderDate))];
  if (po.shipDate) body.push(seg('DTM', '010', compactDate(po.shipDate)));
  for (const c of po.changes ?? []) body.push(seg('POC', c.lineNo, c.op, c.qty, c.qty, c.uom, c.unitPrice.toFixed(2), '', 'BP', c.buyerPart));
  body.push(seg('CTT', (po.changes ?? []).length));
  return envelope({ senderId, receiverId: HUB_ID, date: compactDate(po.orderDate), control, functionalId: 'PC', txType: '860', body });
}

// 997: tells the sender whether the transaction set was syntactically accepted. It says nothing about the business outcome.
export function build997({ receiverId, control, date, ack, accepted }) {
  const body = [
    seg('AK1', ack.functionalId ?? 'PO', ack.groupControl ?? 0),
    seg('AK2', ack.txType ?? '850', ack.txControl ?? '0001'),
    accepted ? seg('AK5', 'A') : seg('AK5', 'R', '5'),
    seg('AK9', accepted ? 'A' : 'R', 1, 1, accepted ? 1 : 0),
  ];
  return envelope({ senderId: HUB_ID, receiverId, date: compactDate(date), control, functionalId: 'FA', txType: '997', body });
}

// 855: the business answer. AD = acknowledged, no change. AC = acknowledged with change. RD = rejected.
export function build855({ receiverId, control, date, order, ackType, soNumber, rawUom }) {
  const body = [seg('BAK', '00', ackType, order.poNumber, compactDate(order.orderDate), '', '', '', soNumber ?? '')];
  for (const l of order.lines ?? []) {
    body.push(seg('PO1', l.lineNo, l.qty, rawUom(l.uom), l.unitPrice.toFixed(2), '', 'BP', l.buyerPart));
    body.push(seg('ACK', ackType === 'RD' ? 'IR' : 'IA', l.qty, rawUom(l.uom), '068', compactDate(order.requestedShipDate)));
  }
  body.push(seg('CTT', (order.lines ?? []).length));
  return envelope({ senderId: HUB_ID, receiverId, date: compactDate(date), control, functionalId: 'PR', txType: '855', body });
}

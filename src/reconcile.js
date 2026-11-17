// Reconciliation. Retries and idempotency protect a call. They cannot see an ERP that answers "created"
// and then fails its own posting job. Only comparing what the hub believes it posted with what the ERP
// actually holds finds that, so reconciliation is a scheduled control, not an afterthought.
import { round2 } from './util.js';

export const RESULTS = {
  MATCHED: 'Matched',
  MISSING_IN_ERP: 'Missing in ERP',
  DUPLICATE_IN_ERP: 'Posted more than once',
  VERSION_BEHIND: 'ERP is on an older revision',
  AMOUNT_MISMATCH: 'Amount differs',
  STATUS_MISMATCH: 'Cancellation not applied',
  ORPHAN_IN_ERP: 'In ERP, unknown to the hub',
};

export function reconcile(hub) {
  const rows = [];
  const control = {};
  const bucket = (partnerId) => (control[partnerId] ??= { partnerId, hubOrders: 0, hubAmount: 0, erpOrders: 0, erpAmount: 0 });

  for (const st of hub.orders.values()) {
    if (st.postedRevision < 0) continue;
    const cancelled = st.status === 'CANCELLED';
    const hubAmount = st.canonical.totals.amount;
    const sos = hub.erp.salesOrdersFor(st.key);
    const erp = sos[0] ?? null;
    const base = { key: st.key, partnerId: st.partnerId, poNumber: st.poNumber, hubRevision: st.postedRevision, hubAmount, hubStatus: st.status, soNumber: erp?.soNumber ?? st.soNumber, erpVersion: erp?.version ?? null, erpAmount: erp?.amount ?? null, erpStatus: erp?.status ?? null };
    if (!cancelled) {
      const b = bucket(st.partnerId);
      b.hubOrders++;
      b.hubAmount = round2(b.hubAmount + hubAmount);
    }

    if (!erp) {
      rows.push({ ...base, result: 'MISSING_IN_ERP', detail: `The hub received a success response for sales order ${st.soNumber}; the ERP holds no such order` });
      continue;
    }
    let clean = true;
    if (sos.length > 1) {
      clean = false;
      rows.push({ ...base, result: 'DUPLICATE_IN_ERP', extras: sos.slice(1).map((s) => s.soNumber), detail: `${sos.length} sales orders exist for one customer PO: ${sos.map((s) => s.soNumber).join(', ')}` });
    }
    if (erp.version !== st.postedRevision) {
      clean = false;
      rows.push({ ...base, result: 'VERSION_BEHIND', detail: `Hub posted revision ${st.postedRevision}; the ERP is at version ${erp.version}` });
    } else if (cancelled && erp.status !== 'CANCELLED') {
      clean = false;
      rows.push({ ...base, result: 'STATUS_MISMATCH', detail: 'The hub posted a cancellation; the ERP order is still open' });
    } else if (!cancelled && Math.abs(erp.amount - hubAmount) > 0.005) {
      clean = false;
      rows.push({ ...base, result: 'AMOUNT_MISMATCH', detail: `Hub ${hubAmount.toFixed(2)} against ERP ${erp.amount.toFixed(2)}` });
    }
    if (clean) rows.push({ ...base, result: 'MATCHED', detail: '' });
  }

  for (const [key, list] of hub.erp.byKey) {
    for (const so of list) {
      const order = hub.erp.orders.get(so);
      if (order.status === 'OPEN') {
        const b = bucket(order.customer);
        b.erpOrders++;
        b.erpAmount = round2(b.erpAmount + order.amount);
      }
    }
    const st = hub.orders.get(key);
    if (list.length && (!st || st.postedRevision < 0)) {
      const order = hub.erp.orders.get(list[0]);
      rows.push({ key, partnerId: order.customer, poNumber: order.customerPo, hubRevision: null, hubAmount: null, hubStatus: null, soNumber: order.soNumber, erpVersion: order.version, erpAmount: order.amount, erpStatus: order.status, result: 'ORPHAN_IN_ERP', detail: 'The ERP committed this order; the hub never saw a success response. Usually a lost response on a message that later went to dead letters' });
    }
  }

  // Known to the hub and not yet in the ERP. These are not breaks; they explain timing differences.
  const open = {};
  for (const m of hub.messages.values()) {
    if (m.internal || !m.canonical) continue;
    if (['EXCEPTION', 'DEAD', 'PARKED', 'RETRYING', 'POSTING', 'PROCESSING'].includes(m.status)) {
      const o = (open[m.status] ??= { status: m.status, count: 0, amount: 0 });
      o.count++;
      o.amount = round2(o.amount + (m.canonical.totals?.amount ?? 0));
    }
  }

  const summary = {};
  for (const r of rows) summary[r.result] = (summary[r.result] ?? 0) + 1;
  const breaks = rows.filter((r) => r.result !== 'MATCHED');
  const controlTotals = Object.values(control).map((c) => ({ ...c, orderDiff: c.erpOrders - c.hubOrders, amountDiff: round2(c.erpAmount - c.hubAmount) }));
  return { at: hub.now, rows, breaks, summary, controlTotals, open: Object.values(open), clean: breaks.length === 0 };
}

// Returns a description of what was done, or null when the break needs a person.
export function repair(hub, row) {
  switch (row.result) {
    case 'MISSING_IN_ERP':
      hub.repost(row.key, { method: 'POST', reason: `PO ${row.poNumber} missing in ERP; reposting the accepted revision` });
      return 'Reposted to the ERP';
    case 'VERSION_BEHIND':
    case 'AMOUNT_MISMATCH':
      hub.repost(row.key, { method: 'PUT', force: true, reason: `PO ${row.poNumber} out of step with the ERP; resending the accepted revision` });
      return 'Resent the accepted revision';
    case 'STATUS_MISMATCH':
      hub.repost(row.key, { method: 'DELETE', force: true, reason: `Cancellation of PO ${row.poNumber} was not applied; resending` });
      return 'Resent the cancellation';
    case 'DUPLICATE_IN_ERP':
      for (const so of row.extras ?? []) hub.erp.removeSalesOrder(so);
      hub.emit('REPAIR', null, `Reconciliation removed duplicate sales order${row.extras.length > 1 ? 's' : ''} ${row.extras.join(', ')} for PO ${row.poNumber}`);
      return 'Removed the duplicate sales orders';
    default:
      return null;
  }
}

export function repairAll(hub, report) {
  return report.breaks.map((row) => repair(hub, row)).filter(Boolean).length;
}

// Business validation. These rules decide whether an order may be posted without a person looking at it.
// Syntax is judged earlier by the adapters; this file only judges meaning.
import { issue } from './canonical.js';
import { addDays, daysBetween, round2 } from './util.js';

export const earliestShipDate = (order, partner) => addDays(order.orderDate, partner.leadDays);

export function validateOrder(order, partner, md) {
  const issues = [];
  if (order.type === 'CANCEL') return issues;

  if (!order.lines.length) issues.push(issue('NO_LINES', 'Order carries no line items'));

  const seen = new Set();
  for (const l of order.lines) {
    if (seen.has(l.lineNo)) issues.push(issue('DUPLICATE_LINE', `Line number ${l.lineNo} appears more than once`, { lineNo: l.lineNo }));
    seen.add(l.lineNo);

    if (!Number.isInteger(l.qty) || l.qty <= 0) issues.push(issue('QTY_INVALID', `Line ${l.lineNo}: quantity ${l.qty} is not a positive whole number`, { lineNo: l.lineNo }));

    const item = l.sku ? md.items[l.sku] : null;
    if (item && !item.active) issues.push(issue('ITEM_INACTIVE', `Line ${l.lineNo}: ${l.sku} ${item.description} is discontinued`, { lineNo: l.lineNo }));

    if (item && (l.uom === 'EA' || l.uom === 'CS') && Number.isFinite(l.unitPrice)) {
      const contract = md.contractPrice(partner.id, l.sku, l.uom);
      const diffPct = contract ? Math.abs(l.unitPrice - contract) / contract * 100 : 0;
      if (diffPct > partner.tolerancePct) {
        issues.push(issue('PRICE_MISMATCH', `Line ${l.lineNo}: buyer price ${l.unitPrice.toFixed(2)} against contract ${contract.toFixed(2)} (${round2(diffPct)}% apart, tolerance ${partner.tolerancePct}%)`, { lineNo: l.lineNo, contract }));
      }
    }
  }

  if (order.requestedShipDate && order.orderDate && daysBetween(order.orderDate, order.requestedShipDate) < partner.leadDays) {
    issues.push(issue('SHIP_DATE_TOO_EARLY', `Ship date ${order.requestedShipDate} is under the ${partner.leadDays}-day lead time; earliest is ${earliestShipDate(order, partner)}`));
  }

  const declared = order.declared?.totalAmount;
  if (Number.isFinite(declared) && Math.abs(declared - order.totals.amount) > 0.01) {
    issues.push(issue('TOTAL_MISMATCH', `Document declares ${declared.toFixed(2)}, lines add up to ${order.totals.amount.toFixed(2)}`));
  }
  return issues;
}

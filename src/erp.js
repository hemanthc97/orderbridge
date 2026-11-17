// A stand-in ERP with the failure modes that make order integration hard in practice:
//   - it goes offline or answers 503 under load
//   - it commits a document and the response never reaches the caller
//   - it acknowledges a document and then fails its own posting job
//   - it refuses documents for business reasons (customer on hold, material blocked)
// It keeps no uniqueness check on customer PO number, like many ERPs where a duplicate PO is only a
// warning. Protection against double posting therefore has to come from the caller's idempotency key.

export class MockErp {
  constructor({ rng, md }) {
    this.rng = rng;
    this.md = md;
    this.config = { latencyMs: [150, 700], transientRate: 0, lostResponseRate: 0, silentDropRate: 0, offline: false };
    this.blockedCustomers = new Set();
    this.blockedMaterials = new Set();
    this.orders = new Map(); // sales order number -> order
    this.byKey = new Map(); // "PARTNER:PO" -> [sales order numbers]
    this.idempotency = new Map(); // key -> stored response
    this.nextSo = 5000001;
    this.stats = { calls: 0, committed: 0, replays: 0, dropped: 0, lostResponses: 0 };
  }

  // Returns { latency, response }. A null response means the caller will never hear back.
  request(req) {
    this.stats.calls++;
    const [lo, hi] = this.config.latencyMs;
    const latency = this.rng.int(lo, hi);
    if (this.config.offline) return { latency: 60, response: { status: 503, body: { error: 'SERVICE_UNAVAILABLE', message: 'ERP is not reachable' } } };
    if (this.rng.chance(this.config.transientRate)) return { latency, response: { status: 503, body: { error: 'SERVICE_UNAVAILABLE', message: 'ERP is busy' } } };
    const response = this.#apply(req);
    if (response.status < 300 && this.rng.chance(this.config.lostResponseRate)) {
      this.stats.lostResponses++;
      return { latency, response: null };
    }
    return { latency, response };
  }

  current(key) {
    const list = this.byKey.get(key) ?? [];
    return list.length ? this.orders.get(list[0]) : null;
  }

  salesOrdersFor(key) {
    return (this.byKey.get(key) ?? []).map((so) => this.orders.get(so));
  }

  // Administrative clean-up used by reconciliation when a duplicate is found.
  removeSalesOrder(soNumber) {
    const order = this.orders.get(soNumber);
    if (!order) return false;
    this.orders.delete(soNumber);
    this.byKey.set(order.key, (this.byKey.get(order.key) ?? []).filter((s) => s !== soNumber));
    return true;
  }

  #apply(req) {
    const idemKey = req.idempotencyKey;
    if (idemKey && this.idempotency.has(idemKey)) {
      this.stats.replays++;
      return { ...this.idempotency.get(idemKey), replayed: true };
    }
    const b = req.body;
    if (this.blockedCustomers.has(b.customer)) return { status: 422, body: { error: 'CUSTOMER_BLOCKED', message: `Customer ${b.customer} is on credit hold` } };
    const bad = (b.lines ?? []).find((l) => !this.md.items[l.material] || this.blockedMaterials.has(l.material));
    if (bad) return { status: 422, body: { error: 'MATERIAL_BLOCKED', message: `Material ${bad.material} is not available for sale in the ERP` } };

    const drop = this.rng.chance(this.config.silentDropRate);
    const amount = Math.round((b.lines ?? []).reduce((s, l) => s + l.amount, 0) * 100) / 100;
    let response;

    if (req.method === 'POST') {
      const so = String(this.nextSo++);
      if (drop) this.stats.dropped++;
      else {
        this.orders.set(so, { soNumber: so, key: req.key, customer: b.customer, customerPo: b.customerPo, version: b.revision, status: 'OPEN', lines: b.lines, amount, shipDate: b.requestedShipDate, shipTo: b.shipTo });
        this.byKey.set(req.key, [...(this.byKey.get(req.key) ?? []), so]);
        this.stats.committed++;
      }
      response = { status: 201, body: { salesOrder: so, version: b.revision } };
    } else {
      const cur = this.current(req.key);
      if (!cur) return { status: 404, body: { error: 'ORDER_NOT_FOUND', message: `No sales order exists for customer PO ${b.customerPo}` } };
      if (!b.force && cur.version !== b.revision - 1) {
        return { status: 409, body: { error: 'VERSION_CONFLICT', message: `Sales order ${cur.soNumber} is at version ${cur.version}; revision ${b.revision} cannot apply` } };
      }
      if (drop) this.stats.dropped++;
      else {
        if (req.method === 'DELETE') cur.status = 'CANCELLED';
        else Object.assign(cur, { lines: b.lines, amount, shipDate: b.requestedShipDate });
        cur.version = b.revision;
        this.stats.committed++;
      }
      response = { status: 200, body: { salesOrder: cur.soNumber, version: b.revision } };
    }
    if (idemKey) this.idempotency.set(idemKey, response);
    return response;
  }
}

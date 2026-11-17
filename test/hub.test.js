import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/hub.js';
import { OrderFactory } from '../src/generator.js';
import { RetryPolicy, CircuitBreaker } from '../src/reliability.js';
import { reconcile, repairAll } from '../src/reconcile.js';
import { SCENARIOS, loadScenario } from '../src/scenarios.js';
import { NEW_ITEM_SKU } from '../src/masterdata.js';
import { Scheduler, createRng } from '../src/util.js';

const setup = (seed = 3) => {
  const hub = new Hub({ seed });
  return { hub, factory: new OrderFactory(hub.md, seed), erp: hub.erp };
};
const send = (hub, factory, spec, opts) => hub.ingest({ partnerId: spec.partnerId, text: factory.render(spec, opts) })[0];
const run = (hub) => hub.scheduler.drain();

test('scheduler runs events in time order and same-instant events in scheduling order', () => {
  const s = new Scheduler();
  const seen = [];
  s.at(50, () => seen.push('b'));
  s.at(10, () => seen.push('a'));
  s.at(50, () => seen.push('c'));
  s.advanceTo(20);
  assert.deepEqual(seen, ['a']);
  s.drain();
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(s.now, 50);
});

test('retry policy: exponential backoff, capped, with bounded jitter', () => {
  const policy = new RetryPolicy({ maxAttempts: 6, baseMs: 1000, factor: 2, maxMs: 10_000, jitter: 0.2 });
  assert.deepEqual(policy.schedule(), [1000, 2000, 4000, 8000, 10_000]);
  const rng = createRng(5);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const base = policy.schedule()[attempt - 1];
    for (let i = 0; i < 50; i++) {
      const d = policy.delay(attempt, rng);
      assert.ok(d >= base * 0.8 - 1 && d <= base * 1.2 + 1, `attempt ${attempt} delay ${d}`);
    }
  }
});

test('circuit breaker: closed -> open -> half-open probe -> closed, and a failed probe reopens', () => {
  const b = new CircuitBreaker({ failureThreshold: 3, openMs: 1000 });
  assert.equal(b.allow(0).ok, true);
  b.failure(1); b.failure(2);
  assert.equal(b.state, 'CLOSED');
  b.failure(3);
  assert.equal(b.state, 'OPEN');
  assert.deepEqual(b.allow(500), { ok: false, retryAt: 1003 });
  b.failure(600); // a late in-flight failure must not extend the window
  assert.equal(b.allow(900).retryAt, 1003);
  const probe = b.allow(1003);
  assert.deepEqual(probe, { ok: true, probe: true });
  assert.equal(b.allow(1004).ok, false, 'only one probe at a time');
  b.failure(1100);
  assert.equal(b.state, 'OPEN');
  assert.equal(b.allow(2100).probe, true);
  b.success(2200);
  assert.equal(b.state, 'CLOSED');
  assert.deepEqual(b.transitions.map((t) => t.to), ['OPEN', 'HALF_OPEN', 'OPEN', 'HALF_OPEN', 'CLOSED']);
});

test('happy path: an order is posted once and acknowledged in the partner format', () => {
  for (const partnerId of ['KESTREL', 'MARLOWE', 'ALDER', 'TIDEWATER']) {
    const { hub, factory, erp } = setup();
    const spec = factory.order(partnerId, 0, { lines: 2 });
    const m = send(hub, factory, spec);
    run(hub);
    assert.equal(m.status, 'ACKNOWLEDGED', partnerId);
    assert.equal(erp.orders.size, 1);
    const so = erp.current(`${partnerId}:${spec.poNumber}`);
    assert.equal(so.soNumber, m.soNumber);
    assert.equal(so.amount, m.canonical.totals.amount);
    assert.ok(m.outbound.length >= 1);
    assert.equal(m.touched, false);
  }
});

test('idempotency: the ERP commits, the response is lost, the retry does not create a second order', () => {
  const { hub, factory, erp } = setup();
  erp.config.lostResponseRate = 1;
  const m = send(hub, factory, factory.order('KESTREL', 0));
  hub.scheduler.advanceTo(9000); // first attempt has timed out
  assert.equal(m.status, 'RETRYING');
  assert.equal(erp.orders.size, 1, 'the first attempt committed');
  erp.config.lostResponseRate = 0;
  run(hub);
  assert.equal(m.status, 'ACKNOWLEDGED');
  assert.equal(erp.orders.size, 1);
  assert.equal(erp.stats.replays, 1);
  assert.equal(m.erpCalls.at(-1).replayed, true);
  assert.deepEqual(hub.integrity(), { postedTwice: 0, missing: 0 });
});

test('without idempotency keys the same failure posts the order twice, and reconciliation finds it', () => {
  const { hub, factory, erp } = setup();
  hub.safeguards.idempotencyKeys = false;
  erp.config.lostResponseRate = 1;
  send(hub, factory, factory.order('KESTREL', 0));
  hub.scheduler.advanceTo(9000);
  erp.config.lostResponseRate = 0;
  run(hub);
  assert.equal(erp.orders.size, 2);
  assert.equal(hub.integrity().postedTwice, 1);
  const report = reconcile(hub);
  assert.equal(report.summary.DUPLICATE_IN_ERP, 1);
  repairAll(hub, report);
  assert.equal(reconcile(hub).clean, true);
});

test('inbound duplicates: identical bytes and re-enveloped resends are both dropped', () => {
  const { hub, factory, erp } = setup();
  const spec = factory.order('MARLOWE', 0);
  const text = factory.render(spec);
  const first = hub.ingest({ partnerId: 'MARLOWE', text })[0];
  const same = hub.ingest({ partnerId: 'MARLOWE', text })[0];
  run(hub);
  const reEnveloped = send(hub, factory, spec);
  run(hub);
  assert.equal(first.status, 'ACKNOWLEDGED');
  assert.equal(same.status, 'DUPLICATE');
  assert.equal(same.duplicateOf, first.id);
  assert.equal(reEnveloped.status, 'DUPLICATE');
  assert.equal(erp.orders.size, 1);
});

test('same PO and revision with different content is held as a conflict, not posted', () => {
  const { hub, factory, erp } = setup();
  const spec = factory.order('ALDER', 0, { lines: 2 });
  send(hub, factory, spec);
  run(hub);
  const altered = { ...spec, lines: spec.lines.map((l, i) => (i ? l : { ...l, qty: l.qty + 6 })) };
  const m = send(hub, factory, altered);
  run(hub);
  assert.equal(m.status, 'EXCEPTION');
  assert.deepEqual(m.issues.map((i) => i.code), ['CONFLICTING_RESEND']);
  assert.equal(erp.orders.size, 1);
});

test('transient failures retry with backoff, then go to dead letters; replay succeeds once the ERP is back', () => {
  const { hub, factory, erp } = setup();
  hub.safeguards.circuitBreaker = false;
  erp.config.offline = true;
  const m = send(hub, factory, factory.order('ALDER', 0));
  run(hub);
  assert.equal(m.status, 'DEAD');
  assert.equal(m.totalAttempts, 5);
  assert.match(m.deadReason, /Retries exhausted after 5 attempts/);
  const waits = m.events.filter((e) => e.type === 'RETRY_SCHEDULED').length;
  assert.equal(waits, 4);
  erp.config.offline = false;
  assert.equal(hub.replay(m.id), true);
  run(hub);
  assert.equal(m.status, 'ACKNOWLEDGED');
  assert.equal(m.touched, true);
});

test('a permanent ERP refusal goes straight to dead letters without retrying', () => {
  const { hub, factory, erp } = setup();
  erp.blockedCustomers.add('KESTREL');
  const m = send(hub, factory, factory.order('KESTREL', 0));
  run(hub);
  assert.equal(m.status, 'DEAD');
  assert.equal(m.totalAttempts, 1);
  assert.match(m.deadReason, /422 CUSTOMER_BLOCKED/);
  assert.equal(hub.breaker.state, 'CLOSED', 'a business refusal is not an availability failure');
});

test('circuit breaker preserves retry budgets through a long outage', () => {
  const { hub, factory, erp } = setup();
  erp.config.offline = true;
  const msgs = [];
  for (let i = 0; i < 20; i++) hub.scheduler.at(i * 500, () => msgs.push(send(hub, factory, factory.order('ALDER', hub.now))));
  hub.scheduler.at(240_000, () => { erp.config.offline = false; });
  hub.scheduler.advanceTo(200_000);
  assert.equal(hub.breaker.state === 'OPEN' || hub.breaker.state === 'HALF_OPEN', true);
  assert.equal(msgs.filter((m) => m.status === 'DEAD').length, 0, 'nothing died during four minutes offline');
  run(hub);
  assert.equal(msgs.every((m) => m.status === 'ACKNOWLEDGED'), true);
  assert.equal(erp.orders.size, 20);
  assert.equal(hub.breaker.state, 'CLOSED');
});

test('sequencing: a change that arrives first is parked, then applied after its original', () => {
  const { hub, factory, erp } = setup();
  const v0 = factory.order('KESTREL', 0, { lines: 2 });
  const v1 = factory.change(v0, 'addLine');
  const v2 = factory.change(v1, 'qty');
  const m2 = send(hub, factory, v2);
  const m1 = send(hub, factory, v1);
  hub.scheduler.advanceTo(5000);
  assert.equal(m1.status, 'PARKED');
  assert.equal(m2.status, 'PARKED');
  const m0 = send(hub, factory, v0);
  run(hub);
  assert.deepEqual([m0.status, m1.status, m2.status], ['ACKNOWLEDGED', 'ACKNOWLEDGED', 'ACKNOWLEDGED']);
  const so = erp.current(`KESTREL:${v0.poNumber}`);
  assert.equal(so.version, 2);
  assert.equal(so.lines.length, 3);
  assert.equal(so.amount, m2.canonical.totals.amount);
  assert.equal(erp.orders.size, 1);
});

test('sequencing: cancellation closes the order and later changes are held', () => {
  const { hub, factory, erp } = setup();
  const v0 = factory.order('MARLOWE', 0, { lines: 2 });
  const cancel = factory.change(v0, 'cancel');
  send(hub, factory, v0);
  send(hub, factory, cancel);
  run(hub);
  assert.equal(erp.current(`MARLOWE:${v0.poNumber}`).status, 'CANCELLED');
  const late = send(hub, factory, { ...factory.change(v0, 'qty'), revision: 2 });
  run(hub);
  assert.equal(late.status, 'EXCEPTION');
  assert.equal(late.issues[0].code, 'ORDER_CANCELLED');
});

test('sequencing: a change whose original never arrives asks for a person after the parking limit', () => {
  const { hub, factory } = setup();
  const m = send(hub, factory, factory.change(factory.order('ALDER', 0), 'qty'));
  hub.scheduler.advanceTo(599_000);
  assert.equal(m.status, 'PARKED');
  run(hub);
  assert.equal(m.status, 'EXCEPTION');
  assert.equal(m.issues.at(-1).code, 'PREDECESSOR_MISSING');
});

test('exceptions: mapping one unknown item releases every order held for it', () => {
  const { hub, factory, erp } = setup();
  const held = [0, 1, 2].map(() => send(hub, factory, factory.order('KESTREL', 0, { defect: 'unknownItem' })));
  const other = send(hub, factory, factory.order('MARLOWE', 0, { defect: 'unknownItem' }));
  run(hub);
  assert.equal(held.every((m) => m.status === 'EXCEPTION'), true);
  const buyerPart = held[0].issues.find((i) => i.code === 'UNKNOWN_ITEM').buyerPart;
  hub.resolve(held[0].id, 'mapItem', { buyerPart, sku: NEW_ITEM_SKU });
  run(hub);
  assert.equal(held.every((m) => m.status === 'ACKNOWLEDGED' && m.touched), true);
  assert.equal(other.status, 'EXCEPTION', 'another partner keeps its own cross-reference');
  assert.equal(erp.orders.size, 3);
  assert.equal(hub.md.partners.KESTREL.addedXref.length, 1);
});

test('exceptions: accept price, move ship date (acknowledged with change) and reject', () => {
  const { hub, factory, erp } = setup();
  const price = send(hub, factory, factory.order('ALDER', 0, { defect: 'price' }));
  const early = send(hub, factory, factory.order('KESTREL', 0, { defect: 'earlyShip' }));
  const gone = send(hub, factory, factory.order('MARLOWE', 0, { defect: 'inactive' }));
  run(hub);
  assert.deepEqual([price.status, early.status, gone.status], ['EXCEPTION', 'EXCEPTION', 'EXCEPTION']);
  hub.resolve(price.id, 'acceptPrice');
  hub.resolve(early.id, 'moveShipDate');
  hub.resolve(gone.id, 'reject');
  run(hub);
  assert.equal(price.status, 'ACKNOWLEDGED');
  assert.equal(price.issues[0].waived, true);
  assert.equal(early.status, 'ACKNOWLEDGED');
  assert.match(early.outbound.at(-1).text, /BAK\*00\*AC\*/);
  assert.equal(gone.status, 'REJECTED');
  assert.match(gone.outbound.at(-1).text, /status="Rejected"/);
  assert.equal(erp.orders.size, 2);
});

test('syntax rejects answer the partner and never reach the ERP', () => {
  const { hub, factory, erp } = setup();
  const msgs = ['KESTREL', 'MARLOWE', 'ALDER'].map((p) => send(hub, factory, factory.order(p, 0, { defect: 'syntax' })));
  run(hub);
  assert.equal(msgs.every((m) => m.status === 'REJECTED' && m.rejection.kind === 'syntax'), true);
  assert.match(msgs[0].outbound[0].text, /AK5\*R/);
  assert.equal(erp.stats.calls, 0);
});

test('reconciliation finds what retries cannot: accepted by the ERP, never posted', () => {
  const { hub, factory, erp } = setup();
  erp.config.silentDropRate = 1;
  const m = send(hub, factory, factory.order('TIDEWATER', 0));
  run(hub);
  assert.equal(m.status, 'ACKNOWLEDGED');
  assert.equal(erp.orders.size, 0);
  const report = reconcile(hub);
  assert.equal(report.summary.MISSING_IN_ERP, 1);
  assert.equal(report.controlTotals[0].orderDiff, -1);
  erp.config.silentDropRate = 0;
  repairAll(hub, report);
  run(hub);
  const after = reconcile(hub);
  assert.equal(after.clean, true);
  assert.equal(after.controlTotals[0].amountDiff, 0);
});

test('reconciliation flags an ERP left on an older revision and resyncs it', () => {
  const { hub, factory, erp } = setup();
  const v0 = factory.order('MARLOWE', 0, { lines: 2 });
  send(hub, factory, v0);
  run(hub);
  erp.config.silentDropRate = 1;
  send(hub, factory, factory.change(v0, 'qty'));
  run(hub);
  erp.config.silentDropRate = 0;
  const report = reconcile(hub);
  assert.equal(report.summary.VERSION_BEHIND, 1);
  repairAll(hub, report);
  run(hub);
  assert.equal(reconcile(hub).clean, true);
});

test('every scenario settles, is reproducible, and never posts twice or loses an order silently', () => {
  for (const scenario of SCENARIOS) {
    const runOnce = (seed) => {
      const hub = new Hub({ seed });
      loadScenario(hub, scenario.id, seed);
      hub.scheduler.drain();
      return hub;
    };
    const hub = runOnce(4);
    const m = hub.metrics();
    assert.equal(m.inFlight, 0, `${scenario.id}: every message reached a final or human-owned state`);
    assert.equal(hub.integrity().postedTwice, 0, `${scenario.id}: nothing posted twice`);
    const posted = [...hub.messages.values()].filter((x) => x.status === 'ACKNOWLEDGED' && !x.internal);
    assert.ok(posted.length > 0, scenario.id);
    if (scenario.id !== 'silent') assert.equal(reconcile(hub).clean, true, `${scenario.id}: reconciliation is clean`);
    const again = runOnce(4).metrics();
    assert.deepEqual(again, m, `${scenario.id}: same seed, same result`);
  }
});

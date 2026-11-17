// Scenarios: scripted traffic plus scripted trouble. Each one isolates a failure that order
// integrations meet in production and shows which safeguard deals with it.
import { createRng } from './util.js';
import { OrderFactory } from './generator.js';

const SEC = 1000;
const MIN = 60 * SEC;
const PARTNER_MIX = ['KESTREL', 'KESTREL', 'KESTREL', 'MARLOWE', 'MARLOWE', 'ALDER', 'ALDER', 'TIDEWATER'];

// Schedules `count` orders at random moments inside a window. Tidewater orders travel as batch files.
function traffic(ctx, { count, fromMs = 2 * SEC, overMs, defectRate = 0, defects = [], resendRate = 0, reEnvelopeRate = 0 }) {
  const { rng, factory, hub } = ctx;
  let sent = 0;
  while (sent < count) {
    const at = fromMs + Math.floor(rng() * overMs);
    const partnerId = rng.pick(PARTNER_MIX);
    const pickDefect = () => (rng.chance(defectRate) ? rng.pick(defects) : null);
    if (partnerId === 'TIDEWATER') {
      const size = Math.min(count - sent, rng.int(2, 5));
      const defectList = Array.from({ length: size }, pickDefect);
      sent += size;
      ctx.at(at, () => {
        const specs = defectList.map((defect) => factory.order(partnerId, hub.now, { defect }));
        specs.forEach((s) => ctx.sent.push(s));
        hub.ingest({ partnerId, text: factory.renderFile(specs) });
      });
      continue;
    }
    const defect = pickDefect();
    const resends = rng.chance(resendRate) ? rng.int(1, 3) : 0;
    const reEnvelope = rng.chance(reEnvelopeRate);
    const gaps = Array.from({ length: resends }, () => rng.int(5, 60) * SEC);
    const reGap = rng.int(10, 90) * SEC;
    sent++;
    ctx.at(at, () => {
      const spec = factory.order(partnerId, hub.now, { defect });
      ctx.sent.push(spec);
      const text = factory.render(spec);
      hub.ingest({ partnerId, text });
      let offset = 0;
      for (const gap of gaps) {
        offset += gap;
        ctx.at(offset, () => hub.ingest({ partnerId, text })); // the same bytes again
      }
      if (reEnvelope) ctx.at(reGap, () => hub.ingest({ partnerId, text: factory.render(spec) })); // same order, new envelope
    });
  }
}

export const SCENARIOS = [
  {
    id: 'steady',
    title: 'A normal trading day',
    premise: 'Sixty orders from four partners in four formats. The ERP answers 503 on about 3% of calls.',
    watch: 'Every order ends acknowledged without a person touching it. The few 503s are absorbed by retries.',
    durationMs: 9 * MIN,
    run(ctx) {
      ctx.hub.erp.config.transientRate = 0.03;
      traffic(ctx, { count: 60, overMs: 7 * MIN });
    },
  },
  {
    id: 'outage',
    title: 'The ERP goes down for three minutes',
    premise: 'Eighty orders keep arriving while the ERP is offline from 08:01:30 to 08:04:30. For a minute after it returns, one response in four is lost on the way back.',
    watch: 'The circuit breaker opens, so waiting orders keep their retry budget. On recovery everything drains, and the lost responses do not create a second sales order.',
    tryThis: 'Switch off the circuit breaker and run again: orders burn their five attempts inside 30 seconds and pile up in dead letters.',
    durationMs: 10 * MIN,
    run(ctx) {
      const { erp } = ctx.hub;
      traffic(ctx, { count: 80, overMs: 7 * MIN });
      ctx.at(90 * SEC, () => { erp.config.offline = true; ctx.hub.emit('CHAOS', null, 'ERP went offline'); });
      ctx.at(270 * SEC, () => { erp.config.offline = false; erp.config.lostResponseRate = 0.25; ctx.hub.emit('CHAOS', null, 'ERP is back; responses are unreliable for one minute'); });
      ctx.at(330 * SEC, () => { erp.config.lostResponseRate = 0; ctx.hub.emit('CHAOS', null, 'ERP responses are reliable again'); });
    },
  },
  {
    id: 'duplicates',
    title: 'A partner resends everything',
    premise: 'Forty orders. A third are re-sent byte for byte up to three times, some are re-sent in a new envelope, and the ERP loses one response in five.',
    watch: 'Resends stop at the door. Lost responses trigger retries that carry the same idempotency key, so the ERP returns its first answer. Posted twice stays at zero.',
    tryThis: 'Switch off idempotency keys and run again: every lost response becomes a second sales order.',
    durationMs: 9 * MIN,
    run(ctx) {
      ctx.hub.erp.config.lostResponseRate = 0.2;
      traffic(ctx, { count: 40, overMs: 6 * MIN, resendRate: 0.35, reEnvelopeRate: 0.2 });
    },
  },
  {
    id: 'dirty',
    title: 'Bad data from partners',
    premise: 'Forty-five orders, nearly half with a defect: an item nobody has cross-referenced yet, an off-contract price, a ship date inside the lead time, a discontinued item, a broken file.',
    watch: 'Unreadable payloads are rejected back to the sender at once. Readable ones with a business problem wait in Work queues for a decision.',
    tryThis: 'Open Work queues and map the unknown item once: every order held for that same gap is released together.',
    durationMs: 8 * MIN,
    run(ctx) {
      traffic(ctx, { count: 45, overMs: 6 * MIN, defectRate: 0.45, defects: ['unknownItem', 'unknownItem', 'price', 'earlyShip', 'inactive', 'syntax', 'total'] });
    },
  },
  {
    id: 'revisions',
    title: 'Changes arrive out of order',
    premise: 'Twenty-four orders, most followed by changes and cancellations. A quarter of the first changes are delivered before the order they amend, and one change refers to an order that never arrives.',
    watch: 'Early changes are parked, then released the moment their predecessor posts. The orphan change waits ten minutes and then asks for a person.',
    durationMs: 16 * MIN,
    run(ctx) {
      const { rng, factory, hub } = ctx;
      for (let i = 0; i < 24; i++) {
        const partnerId = rng.pick(['KESTREL', 'KESTREL', 'MARLOWE', 'ALDER']);
        const at = 3 * SEC + Math.floor(rng() * 4 * MIN);
        const changed = rng.chance(0.7);
        const early = changed && rng.chance(0.35);
        const second = changed && rng.chance(0.45);
        const kinds = [rng.pick(['qty', 'addLine', 'qty']), rng.pick(['cancel', 'qty', 'dropLine'])];
        const gaps = [rng.int(20, 70) * SEC, rng.int(30, 80) * SEC];
        ctx.at(at, () => {
          const v0 = factory.order(partnerId, hub.now, { lines: rng.int(2, 4) });
          ctx.sent.push(v0);
          const v1 = changed ? factory.change(v0, kinds[0]) : null;
          const v2 = second ? factory.change(v1, kinds[1]) : null;
          const send = (spec, delay) => ctx.at(delay, () => hub.ingest({ partnerId, text: factory.render(spec) }));
          if (early) {
            send(v1, 0);
            send(v0, 25 * SEC);
          } else {
            send(v0, 0);
            if (v1) send(v1, gaps[0]);
          }
          if (v2) send(v2, gaps[0] + gaps[1]);
        });
      }
      // A change for an order whose original is never transmitted.
      ctx.at(40 * SEC, () => {
        const ghost = factory.order('MARLOWE', hub.now, { lines: 2 });
        hub.ingest({ partnerId: 'MARLOWE', text: factory.render(factory.change(ghost, 'qty')) });
      });
    },
  },
  {
    id: 'silent',
    title: 'The ERP says yes and posts nothing',
    premise: 'Fifty orders. On about one call in eight the ERP returns success and a sales order number, then fails its own posting job.',
    watch: 'Every order looks acknowledged, and Missing in ERP climbs. No retry can catch this. Open Reconciliation, run it, and repair the breaks.',
    durationMs: 8 * MIN,
    run(ctx) {
      ctx.hub.erp.config.silentDropRate = 0.12;
      traffic(ctx, { count: 50, overMs: 6 * MIN });
    },
  },
  {
    id: 'peak',
    title: 'Peak load with everything going wrong',
    premise: 'Four hundred orders in six minutes with 503s, lost responses, resends and bad data all at once.',
    watch: 'Throughput holds, the queues stay explainable, and the two integrity counters stay at zero.',
    durationMs: 9 * MIN,
    run(ctx) {
      Object.assign(ctx.hub.erp.config, { transientRate: 0.05, lostResponseRate: 0.05 });
      traffic(ctx, { count: 400, overMs: 6 * MIN, defectRate: 0.06, defects: ['unknownItem', 'price', 'earlyShip', 'syntax'], resendRate: 0.1, reEnvelopeRate: 0.05 });
    },
  },
];

export const scenarioById = (id) => SCENARIOS.find((s) => s.id === id);

// Loads a scenario onto a hub. Nothing runs until the scheduler is advanced.
export function loadScenario(hub, id, seed = 1) {
  const scenario = scenarioById(id);
  if (!scenario) throw new Error(`Unknown scenario ${id}`);
  const ctx = {
    hub,
    rng: createRng(seed + 97),
    factory: new OrderFactory(hub.md, seed),
    sent: [],
    at: (delayMs, fn) => hub.scheduler.at(delayMs, fn),
  };
  scenario.run(ctx);
  return { scenario, ...ctx };
}

#!/usr/bin/env node
// Runs a scenario headless and prints what happened. Exits non-zero if an integrity rule is broken.
//   node cli/run.js                      list scenarios
//   node cli/run.js outage               run one
//   node cli/run.js all --seed 7         run every scenario
//   node cli/run.js duplicates --no-idempotency --no-breaker --no-dedupe
import { Hub, SCENARIOS, loadScenario, reconcile, repairAll, RESULTS, clockLabel } from '../src/index.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const which = args.find((a) => !a.startsWith('--') && a !== option('seed'));
const seed = Number(option('seed', 1));

if (!which) {
  console.log('Scenarios:\n');
  for (const s of SCENARIOS) console.log(`  ${s.id.padEnd(11)} ${s.title}`);
  console.log('\nUsage: node cli/run.js <scenario|all> [--seed n] [--no-idempotency] [--no-breaker] [--no-dedupe] [--trace]');
  process.exit(0);
}

const pct = (v) => (v == null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
let failed = false;

for (const scenario of which === 'all' ? SCENARIOS : SCENARIOS.filter((s) => s.id === which)) {
  const hub = new Hub({ seed });
  hub.safeguards.idempotencyKeys = !flag('no-idempotency');
  hub.safeguards.circuitBreaker = !flag('no-breaker');
  hub.safeguards.inboundDedupe = !flag('no-dedupe');
  if (flag('trace')) hub.on((e) => console.log(`  ${clockLabel(e.t)} ${e.id ?? '      '} ${e.type.padEnd(15)} ${e.note}`));
  loadScenario(hub, scenario.id, seed);
  hub.scheduler.drain();

  const m = hub.metrics();
  const report = reconcile(hub);
  const integrity = hub.integrity();
  console.log(`\n${scenario.title}  (seed ${seed}, finished at ${clockLabel(hub.now)})`);
  console.log(`  ${scenario.premise}`);
  console.log(`  received ${m.received} | acknowledged ${m.byStatus.ACKNOWLEDGED ?? 0} | duplicates stopped ${m.duplicatesStopped} | rejected ${m.byStatus.REJECTED ?? 0} | exceptions ${m.byStatus.EXCEPTION ?? 0} | dead letters ${m.byStatus.DEAD ?? 0}`);
  console.log(`  straight-through ${pct(m.straightThroughRate)} | retries ${m.retries} | ERP calls ${m.erpCalls} | median ${(m.p50 / 1000).toFixed(1)} s | p95 ${(m.p95 / 1000).toFixed(1)} s`);
  console.log(`  ERP sales orders ${m.erpSalesOrders} | posted twice ${integrity.postedTwice} | missing in ERP ${integrity.missing}`);
  const breaks = Object.entries(report.summary).filter(([k]) => k !== 'MATCHED').map(([k, v]) => `${RESULTS[k]} ${v}`);
  console.log(`  reconciliation: ${report.summary.MATCHED ?? 0} matched${breaks.length ? `, ${breaks.join(', ')}` : ', no breaks'}`);

  if (!report.clean) {
    // A repair travels the same road as any other post, so it can meet the same fault. Repeat until clean.
    let current = report;
    let passes = 0;
    let fixed = 0;
    while (!current.clean && passes < 8) {
      const n = repairAll(hub, current);
      if (!n) break;
      fixed += n;
      passes++;
      hub.scheduler.drain();
      current = reconcile(hub);
    }
    console.log(`  repair: ${fixed} action${fixed === 1 ? '' : 's'} over ${passes} pass${passes === 1 ? '' : 'es'}; ${current.clean ? 'reconciliation is now clean' : `${current.breaks.length} break${current.breaks.length === 1 ? '' : 's'} need a person`}`);
  }
  if (m.inFlight) {
    console.log(`  INTEGRITY FAILURE: ${m.inFlight} messages never reached a final state`);
    failed = true;
  }
  if (hub.safeguards.idempotencyKeys && integrity.postedTwice) {
    console.log('  INTEGRITY FAILURE: an order was posted twice with idempotency keys on');
    failed = true;
  }
}
process.exit(failed ? 1 : 0);

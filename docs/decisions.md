# Design decisions

Nine decisions carry this design. Each is stated with what breaks without it and what it costs.

## 1. One canonical order

Code: `src/canonical.js`

**Decision.** Every partner format is translated at the edge into one order shape. Rules, sequencing and the ERP connector only ever see that shape.

**Without it.** Each new partner multiplies the work: its own validation, its own ERP mapping, its own bugs. Four formats and one ERP already means four of everything.

**What it costs.** The canonical model becomes a contract that needs an owner and versioning. A field one partner needs and nobody else has still has to find a home in it.

## 2. Two acknowledgments, two meanings

Code: `src/formats/x12.js`

**Decision.** A 997 says the file was readable. An 855 says the order was accepted, changed or rejected. They are sent at different stages and never merged.

**Without it.** The partner reads "received" as "accepted" and plans against an order that is sitting in an exception queue.

**What it costs.** Partners must process both documents. Some only want one, which is a mapping-profile setting, not a redesign.

## 3. Three layers against duplicates

Code: `src/hub.js`, `src/erp.js`

**Decision.** A payload hash stops byte-identical resends. A business key (partner, PO, revision) stops the same order in a new envelope. An idempotency key on the ERP call stops a retry from posting again after a lost response.

**Without it.** Switch off idempotency keys and run "A partner resends everything". Each lost response becomes a second sales order, and a second shipment.

**What it costs.** The idempotency key only works if the ERP side honours it. Where it cannot, the fallback is a lookup by customer PO before every create, which costs a call and still leaves a race.

## 4. Retry only what can pass

Code: `src/reliability.js`

**Decision.** Timeouts and 5xx responses retry with exponential backoff and jitter: 2, 4, 8, 16 seconds, each spread by 20%. A 4xx goes straight to dead letters.

**Without it.** Retrying a rejected document five times delays the alert and loads the ERP for nothing. Retrying without jitter sends every waiting order at the same instant when the ERP comes back.

**What it costs.** Five attempts in 30 seconds is tuned for an interactive order flow. A nightly batch would want fewer, longer waits.

## 5. A circuit breaker that protects retry budgets

Code: `src/reliability.js`

**Decision.** After five consecutive failures the breaker opens for 30 seconds. Waiting orders are held without spending attempts. One probe call tests recovery, and a failed probe is not charged to the order that carried it.

**Without it.** Switch it off and run the outage scenario. Orders exhaust five attempts in half a minute of a three-minute outage, and a person has to replay dozens of dead letters.

**What it costs.** One breaker for the whole ERP is coarse. If only one endpoint is failing, healthy calls wait too. A breaker per endpoint fixes that at the cost of more state.

## 6. Two queues because two people own them

Code: `src/hub.js`

**Decision.** Exceptions hold orders the business must decide on: an unknown item, an off-contract price. Dead letters hold orders the integration team must deliver: an outage outlasted, a document the ERP refused.

**Without it.** One "error queue" mixes data problems with delivery problems. Customer service cannot fix a 503 and the integration team should not approve a price.

**What it costs.** The boundary needs agreeing case by case. A blocked customer in the ERP is a delivery failure here, and some teams would route it to credit control instead.

## 7. Changes apply in revision order

Code: `src/hub.js`, `src/canonical.js`

**Decision.** A change that arrives before its predecessor is parked and released the moment that predecessor posts. An older revision is ignored. Deltas (X12 860) and full replacements end as the same complete document.

**Without it.** A change posted before its original fails, or worse, the original then overwrites the change and the ERP holds the old quantity.

**What it costs.** Parking needs a time limit. Ten minutes here, then a person is asked. Too short raises false alarms, too long hides a missing file.

## 8. Reconciliation is a control, not a report

Code: `src/reconcile.js`

**Decision.** The hub compares what it believes it posted with what the ERP holds: by order, by revision, by amount, and by control totals per partner. Breaks can be repaired from the same screen.

**Without it.** Run "The ERP says yes and posts nothing". Every order shows acknowledged, and one in eight does not exist. No retry, no alert and no dashboard built on the hub's own records can see it.

**What it costs.** It needs read access to ERP data and a schedule. Run hourly, a missing order can be an hour old before anyone knows.

## 9. A simulation you can replay

Code: `src/util.js`, `src/scenarios.js`

**Decision.** The engine runs on a virtual clock and a seeded random source. The same seed sends the same bytes and produces the same result, in the browser and in the test suite.

**Without it.** A failure seen once cannot be reproduced, and a test that depends on real timers is slow and flaky.

**What it costs.** Virtual time hides real concurrency. Production needs the same logic on a durable queue with locking on the order key.

## From this simulation to production

| In this repository | In production |
|---|---|
| Scheduler and in-memory message list | A durable queue with delayed delivery and a dead-letter queue (Amazon SQS, Azure Service Bus, Kafka with retry topics) |
| Maps for payload hashes, order state and idempotency keys | A relational store with unique constraints on the business key, written in the same transaction as the state change |
| Mock ERP | The ERP connector: IDoc or OData for SAP, ION BODs or M3 APIs for Infor, REST for cloud ERPs |
| ingest() called directly | Channel listeners: an AS2 endpoint or VAN mailbox, an HTTPS API behind a gateway, an SFTP poller |
| Mapping profiles in code | Mapping profiles as versioned configuration, with a test pack per partner |
| Event list in memory | Structured logs and traces keyed by message id and business key, with alerts on queue depth and age |

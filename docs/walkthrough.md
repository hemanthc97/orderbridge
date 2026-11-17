# Five-minute walkthrough

A guided tour of the [live control room](https://hemanthc97.github.io/orderbridge/). Each step shows one failure mode and the safeguard that handles it.

## 1. The happy path (30 seconds)

1. Leave the scenario on **A normal trading day** and select **Run scenario**.
2. Watch the line map. Coloured dots are orders, coloured by partner. They travel Receive, Parse, Map, Sequence, Validate, Post, ERP, Acknowledge.
3. Select any row in the ledger. The **Timeline** shows each stage with a timestamp. **Inbound** shows the raw EDI, XML, JSON or CSV. **Canonical** shows the one shape they all become. **Sent back** shows the 997 and 855, or the partner's own response format.

What to notice: four formats enter and one document shape reaches the ERP.

## 2. An outage (60 seconds)

1. Choose **The ERP goes down for three minutes** and run it.
2. At 08:01:30 the ERP turns red. Five calls fail, then the status under the ERP reads **circuit open**.
3. The **Retrying** counter climbs. **Dead letters** stays at zero.
4. At 08:04:30 the ERP returns. One probe call succeeds, the circuit closes and the backlog drains.

Now switch off **Circuit breaker** in the left panel and run it again. Orders burn five attempts in about 30 seconds and land in dead letters. Open **Work queues** and select **Replay all**.

What to notice: the breaker does not make calls succeed. It stops orders from wasting their retry budget on a system that is known to be down.

## 3. Duplicates (60 seconds)

1. Switch the circuit breaker back on. Choose **A partner resends everything** and run it.
2. The **Duplicates** side track fills. **Posted twice** in the dark band stays at 0.
3. Find an order with two or more in the **Calls** column and open **ERP calls**. The first attempt timed out. The second carries the same `Idempotency-Key` and comes back marked "stored result replayed": the first attempt had committed.

Now switch off **Idempotency keys on ERP calls** and run it again. **Posted twice** turns red. Open **Reconciliation**, run it, and repair.

What to notice: inbound duplicate detection cannot help here. The duplicate is created by the hub's own retry, so the protection has to sit on the ERP call.

## 4. Bad data (60 seconds)

1. Switch idempotency keys back on. Choose **Bad data from partners** and run it.
2. Broken payloads go to **Rejected** at the Parse stage, and the partner gets a negative acknowledgment.
3. Readable orders with a business problem go to **Exceptions**. Open **Work queues**.
4. On an order with "Item code has no cross-reference", select **Map and release**. Every order from that partner held for the same item is released together.

What to notice: syntax failures go back to the sender. Business failures go to a person. Fixing master data once clears every order waiting on it.

## 5. The failure no retry can see (60 seconds)

1. Choose **The ERP says yes and posts nothing** and run it.
2. Every order ends **Acknowledged**. The ledger looks perfect. **Missing in ERP** in the dark band does not.
3. Open **Reconciliation** and select **Run reconciliation**. The control totals show which partners are short and by how much.
4. Select **Repair all**. The fault is still on, so a repair can be dropped as well. Repair again until the report is clean.

What to notice: the hub's own records said everything was fine. Only a comparison with the ERP's data found the gap.

## 6. Out-of-order changes (30 seconds)

1. Choose **Changes arrive out of order** and run it at 120x.
2. The **Parked** side track fills and empties as early changes wait for, and then follow, their originals.
3. One change never finds its original. After ten simulated minutes it moves to **Exceptions**.

## Send your own

Use **Send your own** in the left panel to send a single clean or defective order from any partner, or to resend the last transmission. Combine it with the fault sliders to build a case that is not in the scenario list.

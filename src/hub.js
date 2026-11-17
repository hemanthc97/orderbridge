// The integration hub. One message moves through seven stages:
//
//   receive -> parse -> map -> sequence -> validate -> post -> acknowledge
//
// Every exit from that line is explicit and visible:
//   DUPLICATE  the same payload or the same order revision arrived again
//   REJECTED   the payload could not be read, or a reviewer refused it; the partner is told
//   PARKED     a change arrived before the revision it depends on
//   STALE      a revision older than what is already posted
//   EXCEPTION  a business rule failed; a person decides
//   RETRYING   the ERP failed in a way that may pass; backoff or an open circuit
//   DEAD       retries exhausted or the ERP refused permanently; a person replays or closes it
import { Scheduler, createRng, fnv1a, pad, isoDate, percentile, ParseError, BASE_EPOCH } from './util.js';
import { buildMasterData } from './masterdata.js';
import { adapters, buildAck, buildSyntaxAccept, buildSyntaxReject } from './formats/index.js';
import { toCanonical, semanticString, applyChanges, totals, issue } from './canonical.js';
import { validateOrder, earliestShipDate } from './rules.js';
import { MockErp } from './erp.js';
import { RetryPolicy, CircuitBreaker } from './reliability.js';

export const DONE = new Set(['ACKNOWLEDGED', 'DUPLICATE', 'STALE', 'REJECTED']);
export const NEEDS_PERSON = new Set(['EXCEPTION', 'DEAD']);

export class Hub {
  constructor({ seed = 1, config = {} } = {}) {
    this.scheduler = new Scheduler();
    this.rng = createRng(seed);
    this.md = buildMasterData();
    this.erp = new MockErp({ rng: createRng(seed + 7919), md: this.md });
    this.retry = new RetryPolicy(config.retry);
    this.breaker = new CircuitBreaker(config.breaker);
    this.config = { timeoutMs: 8000, parkTtlMs: 600_000, stageMs: { parse: 40, map: 60, sequence: 30, validate: 70, ack: 120 }, ...config };
    // Each safeguard can be switched off to show what it prevents.
    this.safeguards = { inboundDedupe: true, idempotencyKeys: true, circuitBreaker: true };
    this.messages = new Map();
    this.ledger = [];
    this.transmissions = [];
    this.orders = new Map(); // business key -> order state
    this.byContent = new Map(); // payload hash -> first message id
    this.bySemantic = new Map(); // key#revision -> { id, sem }
    this.events = [];
    this.listeners = new Set();
    this.msgSeq = 0;
    this.eventSeq = 0;
    this.control = 700;
  }

  get now() {
    return this.scheduler.now;
  }
  get today() {
    return isoDate(BASE_EPOCH + this.now);
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, m, note, data = {}) {
    const event = { seq: ++this.eventSeq, t: this.now, type, id: m?.id ?? null, partnerId: m?.partnerId ?? null, note, ...data };
    if (m) m.events.push({ t: this.now, type, note });
    this.events.push(event);
    if (this.events.length > 20_000) this.events.splice(0, 5000);
    for (const fn of this.listeners) fn(event);
    return event;
  }

  // ---------- inbound ----------

  // A transmission is whatever arrives on a channel: an EDI interchange, an HTTP body, a file.
  ingest({ partnerId, text }) {
    const partner = this.md.partners[partnerId];
    if (!partner) throw new Error(`Unknown trading partner ${partnerId}`);
    const transmissionId = `T${pad(this.transmissions.length + 1, 4)}`;
    this.transmissions.push({ id: transmissionId, partnerId, text, at: this.now });
    let parts;
    try {
      parts = adapters[partner.format].split(text);
    } catch {
      parts = [text];
    }
    return parts.map((raw) => this.#receive(partner, raw, transmissionId));
  }

  #receive(partner, raw, transmissionId) {
    const id = `M${pad(++this.msgSeq, 5)}`;
    const m = {
      id, partnerId: partner.id, channel: partner.channel, format: partner.format, transmissionId, raw,
      receivedAt: this.now, status: 'RECEIVED', stage: 'receive', attempts: 0, totalAttempts: 0, token: 0,
      events: [], issues: [], mapIssues: [], seqIssues: [], waivers: new Set(), overrides: {},
      erpCalls: [], outbound: [], touched: false, internal: false, contentHash: fnv1a(`${partner.id}|${raw.trim()}`),
    };
    this.messages.set(id, m);
    this.ledger.push(id);
    this.emit('RECEIVED', m, `Received ${adapters[partner.format].label} from ${partner.name} over ${partner.channel}`);

    // First line of defence: a byte-identical payload is a resend, whatever the reason.
    const first = this.byContent.get(m.contentHash);
    if (first && this.safeguards.inboundDedupe) {
      m.duplicateOf = first;
      this.#finish(m, 'DUPLICATE', 'DUPLICATE', `Byte-identical payload already received as ${first}; dropped`);
      return m;
    }
    if (!first) this.byContent.set(m.contentHash, id);
    this.#later(m, this.config.stageMs.parse, () => this.#parse(m));
    return m;
  }

  // Continuations are cancelled when a person intervenes on the message in the meantime.
  #later(m, delayMs, fn) {
    const token = m.token;
    this.scheduler.at(delayMs, () => {
      if (m.token === token) fn();
    });
  }
  #finish(m, status, type, note) {
    m.status = status;
    m.completedAt = this.now;
    this.emit(type, m, note);
  }
  #ctl() {
    return ++this.control;
  }
  #state(key, partnerId, poNumber) {
    if (!this.orders.has(key)) this.orders.set(key, { key, partnerId, poNumber, postedRevision: -1, canonical: null, soNumber: null, status: 'NONE', waiters: new Map(), versions: [] });
    return this.orders.get(key);
  }

  #parse(m) {
    const partner = this.md.partners[m.partnerId];
    try {
      m.rawOrder = adapters[m.format].parse(m.raw);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      m.rejection = { kind: 'syntax', code: err.code, message: err.message };
      m.outbound.push(...buildSyntaxReject(partner, { error: err, controlNumber: this.#ctl(), date: this.today }));
      this.#finish(m, 'REJECTED', 'REJECTED', `${err.code}: ${err.message}. Negative acknowledgment returned to ${partner.name}`);
      return;
    }
    const r = m.rawOrder;
    Object.assign(m, { poNumber: r.poNumber, revision: r.revision, action: r.action });
    const syntaxAck = buildSyntaxAccept(partner, { envelope: r.envelope, controlNumber: this.#ctl(), date: this.today });
    m.outbound.push(...syntaxAck);
    m.status = 'PROCESSING';
    m.stage = 'parse';
    this.emit('PARSED', m, `Read PO ${r.poNumber} revision ${r.revision} (${r.action.toLowerCase()})${syntaxAck.length ? '; 997 functional acknowledgment sent' : ''}`);
    this.#later(m, this.config.stageMs.map, () => this.#map(m));
  }

  #map(m) {
    const partner = this.md.partners[m.partnerId];
    const { order, issues } = toCanonical(m.rawOrder, partner, this.md, { channel: m.channel, format: m.format, messageId: m.id, receivedAt: new Date(BASE_EPOCH + m.receivedAt).toISOString() });
    m.canonical = order;
    m.mapIssues = issues;
    m.businessKey = order.orderId;
    m.conflict = null;

    // Second line of defence: the same order revision re-sent in a new envelope.
    const semKey = `${order.orderId}#${order.revision}`;
    const sem = fnv1a(semanticString(order));
    const prior = this.bySemantic.get(semKey);
    const priorLive = prior && prior.id !== m.id && this.messages.get(prior.id).status !== 'REJECTED';
    if (priorLive && prior.sem === sem && this.safeguards.inboundDedupe) {
      m.duplicateOf = prior.id;
      this.#finish(m, 'DUPLICATE', 'DUPLICATE', `Same PO and revision as ${prior.id}, re-sent in a new envelope; dropped`);
      return;
    }
    if (priorLive && prior.sem !== sem) {
      m.conflict = issue('CONFLICTING_RESEND', `${prior.id} already carries PO ${order.poNumber} revision ${order.revision} with different content. A correction must come as a new revision`);
    }
    if (!priorLive) this.bySemantic.set(semKey, { id: m.id, sem });

    m.status = 'PROCESSING';
    m.stage = 'map';
    this.emit('MAPPED', m, `Mapped to canonical order ${order.orderId}${issues.length ? ` with ${issues.length} mapping gap${issues.length > 1 ? 's' : ''}` : ''}`);
    this.#later(m, this.config.stageMs.sequence, () => this.#sequence(m));
  }

  // Ordering. A change may only be applied to the revision it was written against.
  #sequence(m) {
    const o = m.canonical;
    const st = this.#state(o.orderId, m.partnerId, o.poNumber);
    m.seqIssues = m.conflict ? [m.conflict] : [];

    if (o.type === 'NEW') {
      if (st.postedRevision >= 0 && !m.conflict) {
        this.#finish(m, 'STALE', 'STALE', `PO ${o.poNumber} is already posted at revision ${st.postedRevision}; this original was ignored`);
        return;
      }
    } else if (st.status === 'CANCELLED') {
      m.seqIssues.push(issue('ORDER_CANCELLED', `PO ${o.poNumber} was cancelled at revision ${st.postedRevision}`));
    } else if (o.revision <= st.postedRevision) {
      this.#finish(m, 'STALE', 'STALE', `Revision ${o.revision} is not newer than posted revision ${st.postedRevision}; ignored`);
      return;
    } else if (st.postedRevision < 0 || o.revision !== st.postedRevision + 1) {
      const waitingFor = st.postedRevision + 1;
      st.waiters.set(o.revision, m.id);
      m.status = 'PARKED';
      m.stage = 'sequence';
      this.emit('PARKED', m, `Revision ${o.revision} arrived before revision ${waitingFor} was posted; parked for up to ${Math.round(this.config.parkTtlMs / 60000)} minutes`);
      this.#later(m, this.config.parkTtlMs, () => {
        st.waiters.delete(o.revision);
        m.seqIssues.push(issue('PREDECESSOR_MISSING', `Revision ${waitingFor} of PO ${o.poNumber} never arrived, so revision ${o.revision} cannot be applied`));
        m.issues = [...m.mapIssues, ...m.seqIssues];
        this.#toException(m);
      });
      return;
    } else {
      // In sequence: build the full document the ERP will receive.
      const base = st.canonical;
      if (o.changes) {
        const applied = applyChanges(base.lines, o.changes);
        o.lines = applied.lines;
        m.seqIssues.push(...applied.issues);
      } else if (o.type === 'CANCEL') {
        o.lines = base.lines.map((l) => ({ ...l }));
      }
      o.totals = totals(o.lines);
      o.shipTo ??= base.shipTo;
      o.requestedShipDate ||= base.requestedShipDate;
    }

    m.status = 'PROCESSING';
    m.stage = 'sequence';
    this.emit('SEQUENCED', m, o.type === 'NEW' ? 'Original order: nothing to wait for' : `Revision ${o.revision} follows posted revision ${st.postedRevision}`);
    this.#later(m, this.config.stageMs.validate, () => this.#validate(m));
  }

  #validate(m) {
    const partner = this.md.partners[m.partnerId];
    const o = m.canonical;
    if (m.overrides.shipDate) o.requestedShipDate = m.overrides.shipDate;
    const all = [...m.mapIssues, ...m.seqIssues, ...validateOrder(o, partner, this.md)];
    for (const i of all) i.waived = m.waivers.has(i.code);
    m.issues = all;
    if (all.some((i) => !i.waived)) {
      this.#toException(m);
      return;
    }
    m.status = 'PROCESSING';
    m.stage = 'validate';
    this.emit('VALIDATED', m, all.length ? `Passed with ${all.length} issue${all.length > 1 ? 's' : ''} waived by a reviewer` : 'Passed every business rule');
    this.#later(m, 20, () => this.#post(m));
  }

  #toException(m) {
    m.status = 'EXCEPTION';
    m.stage = 'validate';
    const open = m.issues.filter((i) => !i.waived);
    this.emit('EXCEPTION', m, `Held for review: ${[...new Set(open.map((i) => i.title))].join('; ')}`);
  }

  // ---------- outbound to the ERP ----------

  #erpRequest(m) {
    const o = m.canonical;
    const method = m.repair?.method ?? (o.type === 'NEW' ? 'POST' : o.type === 'CANCEL' ? 'DELETE' : 'PUT');
    // The key is derived from the business identity, never from the attempt. Every retry of the same
    // order revision carries the same key, so the ERP can recognise a repeat and return the first result.
    const key = `${o.orderId}#${o.revision}${m.repair ? `#repair-${m.id}` : ''}`;
    return {
      method,
      path: method === 'POST' ? '/sales-orders' : `/sales-orders/by-po/${o.partnerId}/${o.poNumber}`,
      key: o.orderId,
      idempotencyKey: this.safeguards.idempotencyKeys ? key : null,
      body: {
        customer: o.partnerId, customerPo: o.poNumber, revision: o.revision, force: Boolean(m.repair?.force),
        requestedShipDate: o.requestedShipDate, shipTo: o.shipTo?.code ?? null, currency: o.currency,
        lines: o.lines.map((l) => ({ lineNo: l.lineNo, material: l.sku, quantity: l.qtyBase, uom: 'EA', amount: l.lineAmount })),
      },
    };
  }

  #post(m) {
    const gate = this.safeguards.circuitBreaker ? this.breaker.allow(this.now) : { ok: true, probe: false };
    this.#noteBreaker();
    if (!gate.ok) {
      const first = m.waitReason !== 'circuit';
      m.status = 'RETRYING';
      m.stage = 'post';
      m.waitReason = 'circuit';
      m.nextRetryAt = gate.retryAt + this.rng.int(0, 1500);
      if (first) this.emit('CIRCUIT_WAIT', m, 'Circuit breaker is open: call held back without spending a retry attempt');
      this.#later(m, m.nextRetryAt - this.now, () => this.#post(m));
      return;
    }
    m.attempts++;
    m.totalAttempts++;
    m.status = 'POSTING';
    m.stage = 'post';
    m.waitReason = null;
    const req = this.#erpRequest(m);
    const res = this.erp.request(req);
    const call = { attempt: m.totalAttempts, at: this.now, request: req, probe: gate.probe };
    m.erpCalls.push(call);
    this.emit('POST_ATTEMPT', m, `${req.method} ${req.path}, attempt ${m.attempts} of ${this.retry.maxAttempts}${gate.probe ? ' (circuit breaker probe)' : ''}`);

    if (!res.response || res.latency > this.config.timeoutMs) {
      this.#later(m, this.config.timeoutMs, () => {
        Object.assign(call, { outcome: 'TIMEOUT', latency: this.config.timeoutMs });
        this.#transient(m, `No response within ${this.config.timeoutMs / 1000} s`, gate.probe);
      });
    } else {
      this.#later(m, res.latency, () => {
        Object.assign(call, { status: res.response.status, response: res.response.body, latency: res.latency, replayed: Boolean(res.response.replayed) });
        this.#onResponse(m, res.response, gate.probe);
      });
    }
  }

  #onResponse(m, response, probe = false) {
    if (response.status < 300) {
      if (this.safeguards.circuitBreaker) this.breaker.success(this.now);
      this.#noteBreaker();
      this.#posted(m, response);
    } else if (response.status >= 500) {
      this.#transient(m, `ERP answered ${response.status} ${response.body.error}`, probe);
    } else {
      // A 4xx proves the ERP is up and has judged the document. Retrying the same document cannot help.
      if (this.safeguards.circuitBreaker) this.breaker.success(this.now);
      this.#noteBreaker();
      this.#dead(m, `ERP refused the document: ${response.status} ${response.body.error}. ${response.body.message}`);
    }
  }

  #transient(m, why, probe = false) {
    if (this.safeguards.circuitBreaker) this.breaker.failure(this.now);
    this.#noteBreaker();
    // A failed probe was sent on the breaker's behalf, so it does not count against the message's own budget.
    if (probe) m.attempts = Math.max(0, m.attempts - 1);
    if (m.attempts >= this.retry.maxAttempts) {
      this.#dead(m, `${why}. Retries exhausted after ${m.attempts} attempts`);
      return;
    }
    const delay = this.retry.delay(m.attempts, this.rng);
    m.status = 'RETRYING';
    m.waitReason = 'backoff';
    m.nextRetryAt = this.now + delay;
    this.emit('RETRY_SCHEDULED', m, `${why}. Attempt ${m.attempts + 1} in ${(delay / 1000).toFixed(1)} s`);
    this.#later(m, delay, () => this.#post(m));
  }

  #dead(m, reason) {
    m.status = 'DEAD';
    m.deadReason = reason;
    this.emit('DEAD', m, `Moved to dead letters. ${reason}`);
  }

  #noteBreaker() {
    const s = this.breaker.state;
    if (s === this.lastBreakerState) return;
    const prev = this.lastBreakerState ?? 'CLOSED';
    this.lastBreakerState = s;
    if (s === prev) return;
    const text = { OPEN: `Circuit breaker opened after ${this.breaker.failureThreshold} consecutive ERP failures; calls paused for ${this.breaker.openMs / 1000} s`, HALF_OPEN: 'Circuit breaker half-open: one probe call allowed', CLOSED: 'Circuit breaker closed: ERP is answering again' }[s];
    this.emit('BREAKER', null, text, { state: s });
  }

  #posted(m, response) {
    const o = m.canonical;
    const st = this.#state(o.orderId, m.partnerId, o.poNumber);
    m.soNumber = response.body.salesOrder;
    m.postedAt = this.now;
    m.status = 'POSTED';
    const replayNote = response.replayed ? '. The ERP returned its stored result for this idempotency key: an earlier attempt had already committed' : '';

    if (m.repair) {
      st.soNumber = m.soNumber;
      this.#finish(m, 'ACKNOWLEDGED', 'POSTED', `Repair posted to sales order ${m.soNumber}${replayNote}`);
      return;
    }
    Object.assign(st, { postedRevision: o.revision, canonical: o, soNumber: m.soNumber, status: o.type === 'CANCEL' ? 'CANCELLED' : 'OPEN', lastMessageId: m.id });
    st.versions.push({ revision: o.revision, messageId: m.id, amount: o.totals.amount, at: this.now });
    const verb = o.type === 'NEW' ? 'created' : o.type === 'CANCEL' ? 'cancelled' : `updated to version ${o.revision}`;
    this.emit('POSTED', m, `Sales order ${m.soNumber} ${verb}${replayNote}`);

    const waiterId = st.waiters.get(o.revision + 1);
    if (waiterId) {
      st.waiters.delete(o.revision + 1);
      const w = this.messages.get(waiterId);
      if (w.status === 'PARKED') {
        w.token++;
        w.status = 'PROCESSING';
        this.emit('RELEASED', w, `Revision ${o.revision} is posted; released from parking`);
        this.#later(w, 10, () => this.#sequence(w));
      }
    }
    this.#later(m, this.config.stageMs.ack, () => this.#ack(m));
  }

  #ack(m) {
    const partner = this.md.partners[m.partnerId];
    const outcome = m.overrides.shipDate ? 'changed' : 'accepted';
    const docs = buildAck(partner, { order: m.canonical, outcome, soNumber: m.soNumber, controlNumber: this.#ctl(), date: this.today, md: this.md });
    m.outbound.push(...docs);
    this.#finish(m, 'ACKNOWLEDGED', 'ACK_SENT', `${docs[0].type} sent to ${partner.name}`);
  }

  // ---------- actions a person takes ----------

  resolve(id, action, params = {}) {
    const m = this.messages.get(id);
    if (!m || m.status !== 'EXCEPTION') return false;
    const partner = this.md.partners[m.partnerId];
    const reprocess = (msg, note) => {
      msg.token++;
      msg.touched = true;
      msg.status = 'PROCESSING';
      this.emit('RESOLVED', msg, note);
      this.#later(msg, 10, () => this.#map(msg));
    };
    if (action === 'mapItem') {
      partner.xref[params.buyerPart] = params.sku;
      partner.addedXref.push({ buyerPart: params.buyerPart, sku: params.sku, at: this.now });
      reprocess(m, `Reviewer added cross-reference ${params.buyerPart} to ${params.sku}; reprocessing`);
      // The fix is master data, so every other order held for the same gap is released with it.
      for (const other of this.messages.values()) {
        if (other.id !== m.id && other.status === 'EXCEPTION' && other.partnerId === m.partnerId && other.issues.some((i) => i.code === 'UNKNOWN_ITEM' && i.buyerPart === params.buyerPart)) {
          reprocess(other, `Cross-reference ${params.buyerPart} added on ${m.id}; reprocessing`);
        }
      }
    } else if (action === 'acceptPrice') {
      m.waivers.add('PRICE_MISMATCH');
      reprocess(m, 'Reviewer accepted the buyer price; reprocessing');
    } else if (action === 'moveShipDate') {
      m.overrides.shipDate = earliestShipDate(m.canonical, partner);
      reprocess(m, `Reviewer moved the ship date to ${m.overrides.shipDate}; the partner will receive an acknowledgment with change`);
    } else if (action === 'retry') {
      reprocess(m, 'Reviewer asked for the message to be reprocessed');
    } else if (action === 'reject') {
      m.token++;
      m.touched = true;
      const reasons = m.issues.filter((i) => !i.waived);
      m.rejection = { kind: 'business', code: 'BUSINESS_REJECT', message: params.reason ?? reasons.map((r) => r.title).join('; ') };
      if (m.canonical) m.outbound.push(...buildAck(partner, { order: m.canonical, outcome: 'rejected', reasons, controlNumber: this.#ctl(), date: this.today, md: this.md }));
      this.#finish(m, 'REJECTED', 'REJECTED', `Rejected by reviewer: ${m.rejection.message}. Rejection sent to ${partner.name}`);
    } else return false;
    return true;
  }

  replay(id) {
    const m = this.messages.get(id);
    if (!m || m.status !== 'DEAD') return false;
    m.token++;
    m.touched = true;
    m.attempts = 0;
    m.status = 'PROCESSING';
    this.emit('REPLAYED', m, 'Replayed from dead letters with a fresh retry budget');
    this.#later(m, 10, () => this.#post(m));
    return true;
  }

  replayAll() {
    return [...this.messages.values()].filter((m) => m.status === 'DEAD').map((m) => this.replay(m.id)).length;
  }

  // Used by reconciliation: push the hub's latest accepted version of an order into the ERP again.
  repost(key, { method, force = false, reason }) {
    const st = this.orders.get(key);
    if (!st?.canonical) return null;
    const partner = this.md.partners[st.partnerId];
    const id = `M${pad(++this.msgSeq, 5)}`;
    const m = {
      id, partnerId: partner.id, channel: 'INTERNAL', format: 'repair', transmissionId: null, raw: JSON.stringify(st.canonical, null, 2),
      receivedAt: this.now, status: 'PROCESSING', stage: 'post', attempts: 0, totalAttempts: 0, token: 0,
      events: [], issues: [], mapIssues: [], seqIssues: [], waivers: new Set(), overrides: {}, erpCalls: [], outbound: [],
      touched: true, internal: true, canonical: st.canonical, businessKey: key, poNumber: st.poNumber, revision: st.postedRevision, action: 'REPAIR',
      repair: { method, force },
    };
    this.messages.set(id, m);
    this.ledger.push(id);
    this.emit('REPAIR', m, `Reconciliation repair: ${reason}`);
    this.#later(m, 10, () => this.#post(m));
    return m;
  }

  // ---------- reading the state ----------

  metrics() {
    const byStatus = {};
    const latencies = [];
    let received = 0, attemptsBeyondFirst = 0, straightThrough = 0, decided = 0;
    for (const m of this.messages.values()) {
      if (m.internal) continue;
      received++;
      byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
      attemptsBeyondFirst += Math.max(0, m.totalAttempts - 1);
      if (m.status === 'ACKNOWLEDGED') {
        latencies.push(m.completedAt - m.receivedAt);
        if (!m.touched) straightThrough++;
      }
      if (m.status === 'ACKNOWLEDGED' || m.status === 'EXCEPTION' || m.status === 'DEAD' || (m.status === 'REJECTED' && m.rejection?.kind === 'business')) decided++;
    }
    latencies.sort((a, b) => a - b);
    const count = (s) => byStatus[s] ?? 0;
    return {
      received, byStatus,
      posted: count('ACKNOWLEDGED') + count('POSTED'),
      duplicatesStopped: count('DUPLICATE') + count('STALE'),
      needsPerson: count('EXCEPTION') + count('DEAD'),
      inFlight: count('RECEIVED') + count('PROCESSING') + count('POSTING') + count('RETRYING') + count('PARKED') + count('POSTED'),
      retries: attemptsBeyondFirst,
      straightThroughRate: decided ? straightThrough / decided : null,
      p50: percentile(latencies, 50), p95: percentile(latencies, 95),
      erpCalls: this.erp.stats.calls, erpSalesOrders: this.erp.orders.size,
      breaker: this.safeguards.circuitBreaker ? this.breaker.state : 'OFF',
    };
  }

  // Two questions that decide whether an integration can be trusted, answered from the ERP's own data.
  integrity() {
    let postedTwice = 0;
    for (const list of this.erp.byKey.values()) if (list.length > 1) postedTwice += list.length - 1;
    let missing = 0;
    for (const st of this.orders.values()) if (st.postedRevision >= 0 && !this.erp.current(st.key)) missing++;
    return { postedTwice, missing };
  }
}

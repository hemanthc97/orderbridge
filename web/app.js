// The control room. It owns no integration logic: it drives the engine in ../src on a virtual clock,
// listens to its events and draws them.
import { Hub, SCENARIOS, scenarioById, loadScenario, reconcile, repair, repairAll, RESULTS, OrderFactory, clockLabel, adapters } from '../src/index.js';
import { FIELD_MAPS, DESIGN_NOTES, PRODUCTION_SWAPS } from './content.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n == null ? '' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const STATUS = {
  RECEIVED: ['Received', 'flow'], PROCESSING: ['Processing', 'flow'], POSTING: ['Posting', 'flow'], POSTED: ['Posted', 'flow'],
  ACKNOWLEDGED: ['Acknowledged', 'ok'], DUPLICATE: ['Duplicate', 'mute'], STALE: ['Stale', 'mute'], REJECTED: ['Rejected', 'reject'],
  PARKED: ['Parked', 'wait'], RETRYING: ['Retrying', 'wait'], EXCEPTION: ['Exception', 'hold'], DEAD: ['Dead letter', 'dead'],
};
const chip = (status) => `<span class="chip ${STATUS[status][1]}">${STATUS[status][0]}</span>`;

// ---------- state ----------

const state = {
  hub: null, factory: null, scenarioId: 'steady', seed: 1, speed: 30,
  running: false, loaded: false, finished: false,
  tab: 'ledger', selected: null, detailTab: 'timeline',
  filter: { group: 'all', partner: 'all', q: '' },
  mapPartner: 'KESTREL', report: null, announce: '',
  pass: {}, queue: [], dots: [], safeguards: { inboundDedupe: true, idempotencyKeys: true, circuitBreaker: true },
  sig: {},
};

function newHub() {
  const hub = new Hub({ seed: state.seed });
  Object.assign(hub.safeguards, state.safeguards);
  hub.on((e) => state.queue.push(e));
  Object.assign(state, { hub, factory: new OrderFactory(hub.md, state.seed + 500), running: false, loaded: false, finished: false, selected: null, report: null, pass: {}, queue: [], sig: {}, announce: '' });
  for (const d of state.dots) d.el.remove();
  state.dots = [];
}

// ---------- line map ----------

const P = {
  receive: [230, 130], parse: [360, 130], map: [490, 130], sequence: [620, 130], validate: [750, 130], post: [880, 130], erp: [1030, 130], ack: [1170, 130],
  duplicate: [230, 232], rejected: [360, 232], stale: [490, 232], parked: [620, 232], exception: [750, 232], dead: [880, 232], retry: [955, 44],
};
const ORIGIN = { KESTREL: 46, MARLOWE: 102, ALDER: 158, TIDEWATER: 214 };
const STATIONS = [['receive', 'Receive'], ['parse', 'Parse'], ['map', 'Map'], ['sequence', 'Sequence'], ['validate', 'Validate'], ['post', 'Post'], ['ack', 'Acknowledge']];
const SIDINGS = [['duplicate', 'Duplicates', 'mute', 'receive'], ['rejected', 'Rejected', 'reject', 'parse'], ['stale', 'Stale', 'mute', 'sequence'], ['parked', 'Parked', 'wait', 'sequence'], ['exception', 'Exceptions', 'hold', 'validate'], ['dead', 'Dead letters', 'dead', 'post']];

function buildMap() {
  const hub = state.hub;
  const feeders = Object.entries(ORIGIN).map(([id, y]) => {
    const p = hub.md.partners[id];
    return `<g class="origin p-${id}">
      <circle cx="14" cy="${y}" r="6"/>
      <text x="28" y="${y - 2}" class="origin-name">${esc(p.name)}</text>
      <text x="28" y="${y + 14}" class="origin-meta">${esc(adapters[p.format].label)} over ${esc(p.channel)}</text>
      <path d="M184 ${y} C 202 ${y} 190 130 206 130"/>
    </g>`;
  }).join('');
  const sidings = SIDINGS.map(([key, label, tone, from]) => {
    const [x, y] = P[key];
    const [fx, fy] = P[from];
    return `<g class="siding ${tone}" data-siding="${key}">
      <path d="M${fx} ${fy} L${x} ${y}"/>
      <circle cx="${x}" cy="${y}" r="7"/>
      <text x="${x}" y="${y + 24}" class="siding-name">${label}</text>
      <text x="${x}" y="${y + 50}" class="siding-count" id="sc-${key}">0</text>
    </g>`;
  }).join('');
  const stations = STATIONS.map(([key, label]) => {
    const [x, y] = P[key];
    return `<g class="station">
      <text x="${x}" y="${y - 44}" class="pass" id="pc-${key}">0</text>
      <text x="${x}" y="${y - 24}" class="station-name">${label}</text>
      <circle cx="${x}" cy="${y}" r="9"/>
    </g>`;
  }).join('');
  const [rx, ry] = P.retry;
  $('#map').innerHTML = `
    ${feeders}
    <path class="track" d="M206 130 H1170"/>
    <g class="siding wait" data-siding="retry">
      <path d="M906 130 C 906 88 922 50 ${rx} ${ry}"/>
      <circle cx="${rx}" cy="${ry}" r="7"/>
      <text x="${rx + 16}" y="${ry - 4}" class="siding-name start">Retrying</text>
      <text x="${rx + 16}" y="${ry + 20}" class="siding-count start" id="sc-retry">0</text>
    </g>
    ${sidings}
    ${stations}
    <g class="erp" id="erp-node">
      <text x="1030" y="86" class="pass" id="pc-erp">0</text>
      <rect x="1004" y="104" width="52" height="52" rx="6"/>
      <text x="1030" y="136" class="erp-name">ERP</text>
      <text x="1030" y="180" class="erp-state" id="erp-state">online</text>
      <text x="1030" y="198" class="erp-breaker" id="erp-breaker">circuit closed</text>
    </g>
    <g id="dots"></g>`;
}

function moveFor(e) {
  const m = e.id ? state.hub.messages.get(e.id) : null;
  switch (e.type) {
    case 'RECEIVED': return [[184, ORIGIN[e.partnerId]], P.receive];
    case 'DUPLICATE': return [P.receive, P.duplicate];
    case 'PARSED': return [P.receive, P.parse];
    case 'REJECTED': return m?.rejection?.kind === 'business' ? [P.exception, P.rejected] : [P.parse, P.rejected];
    case 'MAPPED': return [P.parse, P.map];
    case 'SEQUENCED': return [P.map, P.sequence];
    case 'PARKED': return [P.sequence, P.parked];
    case 'RELEASED': return [P.parked, P.sequence];
    case 'STALE': return [P.sequence, P.stale];
    case 'VALIDATED': return [P.sequence, P.validate];
    case 'EXCEPTION': return [P.validate, P.exception];
    case 'RESOLVED': return [P.exception, P.validate];
    case 'POST_ATTEMPT': return [m && m.totalAttempts > 1 ? P.retry : P.validate, P.post];
    case 'RETRY_SCHEDULED': case 'CIRCUIT_WAIT': return [P.post, P.retry];
    case 'DEAD': return [P.post, P.dead];
    case 'REPLAYED': return [P.dead, P.post];
    case 'POSTED': return [P.post, P.erp];
    case 'ACK_SENT': return [P.erp, P.ack];
    default: return null;
  }
}
const PASS_ON = { RECEIVED: 'receive', PARSED: 'parse', MAPPED: 'map', SEQUENCED: 'sequence', VALIDATED: 'validate', POST_ATTEMPT: 'post', POSTED: 'erp', ACK_SENT: 'ack' };

function drainEvents(ts) {
  if (!state.queue.length) return false;
  let spawned = 0;
  for (const e of state.queue) {
    const stop = PASS_ON[e.type];
    if (stop) state.pass[stop] = (state.pass[stop] ?? 0) + 1;
    if (!e.id && e.note) state.announce = `${clockLabel(e.t)}  ${e.note}`;
    if (reducedMotion || spawned >= 10 || state.dots.length >= 90) continue;
    const mv = moveFor(e);
    if (!mv) continue;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    el.setAttribute('r', '5');
    el.setAttribute('class', `dot p-${e.partnerId}`);
    $('#dots').append(el);
    state.dots.push({ el, from: mv[0], to: mv[1], t0: ts + spawned * 18, dur: 420 });
    spawned++;
  }
  state.queue = [];
  return true;
}

function animateDots(ts) {
  if (!state.dots.length) return;
  state.dots = state.dots.filter((d) => {
    const k = (ts - d.t0) / d.dur;
    if (k >= 1) {
      d.el.remove();
      return false;
    }
    const e = k <= 0 ? 0 : 1 - (1 - k) ** 3;
    d.el.setAttribute('cx', d.from[0] + (d.to[0] - d.from[0]) * e);
    d.el.setAttribute('cy', d.from[1] + (d.to[1] - d.from[1]) * e);
    return true;
  });
}

// ---------- top of page ----------

function paintTop() {
  const { hub } = state;
  const m = hub.metrics();
  const s = (k) => m.byStatus[k] ?? 0;
  $('#clock').textContent = clockLabel(hub.now);

  for (const [key] of STATIONS) $(`#pc-${key}`).textContent = state.pass[key] ?? 0;
  $('#pc-erp').textContent = state.pass.erp ?? 0;
  const sidingCounts = { duplicate: s('DUPLICATE'), rejected: s('REJECTED'), stale: s('STALE'), parked: s('PARKED'), exception: s('EXCEPTION'), dead: s('DEAD'), retry: s('RETRYING') };
  for (const [key, n] of Object.entries(sidingCounts)) {
    $(`#sc-${key}`).textContent = n;
    $(`[data-siding="${key}"]`).classList.toggle('active', n > 0);
  }
  const offline = hub.erp.config.offline;
  $('#erp-node').classList.toggle('down', offline);
  $('#erp-state').textContent = offline ? 'offline' : 'online';
  const breaker = { CLOSED: 'circuit closed', OPEN: 'circuit open', HALF_OPEN: 'circuit half-open', OFF: 'no circuit breaker' }[m.breaker];
  $('#erp-breaker').textContent = breaker;
  $('#erp-node').dataset.breaker = m.breaker;
  $('#announce').textContent = state.announce;

  const stp = m.straightThroughRate == null ? 'n/a' : `${(m.straightThroughRate * 100).toFixed(1)}%`;
  const kpis = [
    ['Received', m.received],
    ['Acknowledged', s('ACKNOWLEDGED')],
    ['Straight through', stp],
    ['Duplicates stopped', m.duplicatesStopped],
    ['Median time', m.p50 ? `${(m.p50 / 1000).toFixed(1)} s` : 'n/a'],
    ['ERP calls', m.erpCalls],
  ];
  $('#kpis').innerHTML = kpis.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  const integrity = hub.integrity();
  $('#integrity').innerHTML = `
    <p class="integrity-title">Integrity, read from the ERP</p>
    <div class="integrity-pair">
      <div class="${integrity.postedTwice ? 'bad' : ''}"><strong>${integrity.postedTwice}</strong><span>posted twice</span></div>
      <div class="${integrity.missing ? 'bad' : ''}"><strong>${integrity.missing}</strong><span>missing in ERP</span></div>
      <div class="${m.needsPerson ? 'warn' : ''}"><strong>${m.needsPerson}</strong><span>waiting for a person</span></div>
    </div>`;

  const badge = $('#q-badge');
  badge.hidden = m.needsPerson === 0;
  badge.textContent = m.needsPerson;

  // Controls follow the engine: a scenario script may flip these while it runs.
  const cfg = hub.erp.config;
  const sync = (id, value, out) => {
    const el = $(`#${id}`);
    if (document.activeElement !== el) el.value = value;
    $(`#${out}`).textContent = `${Math.round(value)}%`;
  };
  $('#offline').checked = cfg.offline;
  sync('transient', cfg.transientRate * 100, 'o-transient');
  sync('lost', cfg.lostResponseRate * 100, 'o-lost');
  sync('silent', cfg.silentDropRate * 100, 'o-silent');

  const run = $('#run');
  run.textContent = state.running ? 'Pause' : state.finished ? 'Run again' : state.loaded ? 'Resume' : 'Run scenario';
}

function paintScenario() {
  const sc = scenarioById(state.scenarioId);
  $('#premise').textContent = sc.premise;
  $('#watch').textContent = sc.watch;
  $('#try').textContent = sc.tryThis ?? '';
  $('#try').hidden = !sc.tryThis;
}

// ---------- views ----------

const GROUPS = {
  all: () => true,
  moving: (m) => ['RECEIVED', 'PROCESSING', 'POSTING', 'POSTED', 'RETRYING', 'PARKED'].includes(m.status),
  done: (m) => m.status === 'ACKNOWLEDGED',
  stopped: (m) => ['DUPLICATE', 'STALE', 'REJECTED'].includes(m.status),
  person: (m) => m.status === 'EXCEPTION' || m.status === 'DEAD',
};

const revisionLabel = (m) => (m.action == null ? '' : m.action === 'NEW' ? 'New' : m.action === 'REPAIR' ? 'Repair' : `${m.action === 'CANCEL' ? 'Cancel' : 'Change'} ${m.revision}`);

function ledgerRows() {
  const { hub, filter } = state;
  const q = filter.q.trim().toLowerCase();
  const out = [];
  for (let i = hub.ledger.length - 1; i >= 0 && out.length < 250; i--) {
    const m = hub.messages.get(hub.ledger[i]);
    if (!GROUPS[filter.group](m)) continue;
    if (filter.partner !== 'all' && m.partnerId !== filter.partner) continue;
    if (q && !`${m.id} ${m.poNumber ?? ''} ${m.soNumber ?? ''}`.toLowerCase().includes(q)) continue;
    out.push(m);
  }
  return out;
}

function viewLedger(root, fresh) {
  const { hub } = state;
  if (fresh) {
    root.innerHTML = `
      <div class="toolbar">
        <div class="seg" role="group" aria-label="Filter by state">
          ${[['all', 'All'], ['moving', 'In flight'], ['done', 'Acknowledged'], ['stopped', 'Stopped'], ['person', 'Needs a person']].map(([k, l]) => `<button type="button" data-action="group" data-value="${k}" aria-pressed="${state.filter.group === k}">${l}</button>`).join('')}
        </div>
        <select data-action="partner" aria-label="Filter by partner">
          <option value="all">All partners</option>
          ${hub.md.partnerIds.map((id) => `<option value="${id}" ${state.filter.partner === id ? 'selected' : ''}>${esc(hub.md.partners[id].name)}</option>`).join('')}
        </select>
        <input type="search" data-action="search" placeholder="Find a message, PO or sales order" value="${esc(state.filter.q)}" aria-label="Search">
      </div>
      <div class="split">
        <div class="table-wrap" id="ledger-table"></div>
        <aside class="detail" id="detail" aria-label="Message detail"></aside>
      </div>`;
  }
  const rows = ledgerRows();
  const table = $('#ledger-table', root);
  const scroll = table.scrollTop;
  table.innerHTML = rows.length ? `
    <table class="grid">
      <thead><tr><th>Time</th><th>Message</th><th>Partner</th><th>PO</th><th>Revision</th><th class="num">Amount</th><th>State</th><th class="num">Calls</th></tr></thead>
      <tbody>${rows.map((m) => `
        <tr tabindex="0" data-action="select" data-id="${m.id}" class="${m.id === state.selected ? 'selected' : ''}">
          <td>${clockLabel(m.receivedAt)}</td>
          <td class="code">${m.id}</td>
          <td title="${esc(hub.md.partners[m.partnerId].name)}"><span class="pdot p-${m.partnerId}"></span>${esc(hub.md.partners[m.partnerId].name.split(' ')[0])}</td>
          <td class="code">${esc(m.poNumber ?? '')}</td>
          <td>${revisionLabel(m)}</td>
          <td class="num">${m.canonical?.totals ? money(m.canonical.totals.amount) : ''}</td>
          <td>${chip(m.status)}</td>
          <td class="num">${m.totalAttempts || ''}</td>
        </tr>`).join('')}
      </tbody>
    </table>` : `<p class="empty">${hub.ledger.length ? 'No message matches this filter.' : 'Nothing has arrived yet. Run the scenario, or send an order from the panel on the left.'}</p>`;
  table.scrollTop = scroll;
  paintDetail($('#detail', root));
}

function paintDetail(el) {
  const { hub } = state;
  const m = state.selected ? hub.messages.get(state.selected) : null;
  if (!m) {
    el.innerHTML = '<p class="empty">Select a message to follow it through the hub: every stage, every ERP call, every document sent back.</p>';
    return;
  }
  const partner = hub.md.partners[m.partnerId];
  const tabs = [['timeline', 'Timeline'], ['inbound', 'Inbound'], ['canonical', 'Canonical'], ['erp', `ERP calls (${m.erpCalls.length})`], ['outbound', `Sent back (${m.outbound.length})`]];
  let body = '';
  if (state.detailTab === 'timeline') {
    body = `<ol class="timeline">${m.events.map((e) => `<li class="ev-${e.type}"><time>${clockLabel(e.t, true)}</time><p>${esc(e.note)}</p></li>`).join('')}</ol>`;
  } else if (state.detailTab === 'inbound') {
    body = `<p class="cap">${esc(m.internal ? 'Internal repair message' : `${adapters[m.format].label} as received over ${m.channel}`)}</p><pre>${esc(m.raw)}</pre>`;
  } else if (state.detailTab === 'canonical') {
    body = m.canonical ? `<p class="cap">The one shape every format is translated into</p><pre>${esc(JSON.stringify(m.canonical, null, 2))}</pre>` : '<p class="empty">This message never reached mapping.</p>';
  } else if (state.detailTab === 'erp') {
    body = m.erpCalls.length ? m.erpCalls.map((c) => `
      <div class="call">
        <p class="cap">Attempt ${c.attempt} at ${clockLabel(c.at, true)}${c.probe ? ', circuit breaker probe' : ''}: ${c.outcome === 'TIMEOUT' ? 'no response, timed out' : c.status == null ? 'in flight' : `HTTP ${c.status} in ${c.latency} ms${c.replayed ? ', stored result replayed' : ''}`}</p>
        <pre>${esc(`${c.request.method} ${c.request.path}\nIdempotency-Key: ${c.request.idempotencyKey ?? '(none sent)'}\n\n${JSON.stringify(c.request.body, null, 2)}`)}</pre>
        ${c.response ? `<pre>${esc(JSON.stringify(c.response, null, 2))}</pre>` : ''}
      </div>`).join('') : '<p class="empty">No ERP call was made for this message.</p>';
  } else {
    body = m.outbound.length ? m.outbound.map((o) => `<p class="cap">${esc(o.type)}</p><pre>${esc(o.text)}</pre>`).join('') : '<p class="empty">Nothing has been sent back to the partner yet.</p>';
  }
  const open = m.issues.filter((i) => !i.waived);
  el.innerHTML = `
    <header class="detail-head">
      <h3><span class="code">${m.id}</span> ${chip(m.status)}</h3>
      <p>${esc(partner.name)}${m.poNumber ? `, PO <span class="code">${esc(m.poNumber)}</span> revision ${m.revision}` : ''}${m.soNumber ? `, sales order <span class="code">${m.soNumber}</span>` : ''}</p>
      ${m.status === 'EXCEPTION' ? `<p class="note hold">${esc([...new Set(open.map((i) => i.title))].join('; '))}. <button type="button" class="link" data-action="tab" data-value="queues">Decide in Work queues</button></p>` : ''}
      ${m.status === 'DEAD' ? `<p class="note dead">${esc(m.deadReason)} <button type="button" class="link" data-action="replay" data-id="${m.id}">Replay</button></p>` : ''}
      ${m.duplicateOf ? `<p class="note">Duplicate of <button type="button" class="link code" data-action="select" data-id="${m.duplicateOf}">${m.duplicateOf}</button></p>` : ''}
    </header>
    <div class="subtabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" data-action="detail-tab" data-value="${k}" aria-selected="${state.detailTab === k}">${l}</button>`).join('')}</div>
    <div class="detail-body">${body}</div>`;
}

function viewQueues(root) {
  const { hub } = state;
  const all = [...hub.messages.values()];
  const exceptions = all.filter((m) => m.status === 'EXCEPTION');
  const dead = all.filter((m) => m.status === 'DEAD');
  const parked = all.filter((m) => m.status === 'PARKED');
  const head = (m) => `<span class="code">${m.id}</span> ${esc(hub.md.partners[m.partnerId].name)}, PO <span class="code">${esc(m.poNumber ?? '')}</span> revision ${m.revision ?? 0}${m.canonical?.totals ? `, ${money(m.canonical.totals.amount)}` : ''}`;

  const exceptionCard = (m) => {
    const partner = hub.md.partners[m.partnerId];
    const open = m.issues.filter((i) => !i.waived);
    const fixes = new Set(open.map((i) => i.fix).filter(Boolean));
    const unknown = [...new Set(open.filter((i) => i.code === 'UNKNOWN_ITEM').map((i) => i.buyerPart))];
    const actions = [];
    for (const part of unknown) {
      const suggested = Object.keys(partner.unmapped).find((sku) => partner.unmapped[sku] === part);
      const held = exceptions.filter((x) => x.partnerId === m.partnerId && x.issues.some((i) => !i.waived && i.code === 'UNKNOWN_ITEM' && i.buyerPart === part)).length;
      actions.push(`<span class="fix">Map <span class="code">${esc(part)}</span> to
        <select data-part="${esc(part)}" aria-label="Internal SKU for ${esc(part)}">${Object.values(hub.md.items).filter((i) => i.active).map((i) => `<option value="${i.sku}" ${i.sku === suggested ? 'selected' : ''}>${i.sku} ${esc(i.description)}</option>`).join('')}</select>
        <button type="button" class="btn small primary" data-action="resolve" data-fix="mapItem" data-id="${m.id}" data-part="${esc(part)}">Map and release ${plural(held, 'order')}</button></span>`);
    }
    if (fixes.has('acceptPrice')) actions.push(`<button type="button" class="btn small primary" data-action="resolve" data-fix="acceptPrice" data-id="${m.id}">Accept buyer price</button>`);
    if (fixes.has('moveShipDate')) actions.push(`<button type="button" class="btn small primary" data-action="resolve" data-fix="moveShipDate" data-id="${m.id}">Move ship date to earliest</button>`);
    actions.push(`<button type="button" class="btn small" data-action="resolve" data-fix="retry" data-id="${m.id}">Reprocess</button>`);
    actions.push(`<button type="button" class="btn small danger" data-action="resolve" data-fix="reject" data-id="${m.id}">Reject to partner</button>`);
    return `<li>
      <p class="q-head">${head(m)} <button type="button" class="link" data-action="open" data-id="${m.id}">Open</button></p>
      <ul class="issues">${open.map((i) => `<li><strong>${esc(i.title)}.</strong> ${esc(i.message)}</li>`).join('')}</ul>
      <div class="q-actions">${actions.join('')}</div>
    </li>`;
  };

  root.innerHTML = `
    <section class="queue hold">
      <h3>Exceptions <span>${exceptions.length}</span></h3>
      <p class="lede">Readable orders that failed a business rule. The business decides; a master-data fix releases every order held for the same gap.</p>
      ${exceptions.length ? `<ul class="q-list">${exceptions.slice(0, 40).map(exceptionCard).join('')}</ul>${exceptions.length > 40 ? `<p class="hint">Showing 40 of ${exceptions.length}.</p>` : ''}` : '<p class="empty">No order is waiting for a business decision.</p>'}
    </section>
    <section class="queue dead">
      <h3>Dead letters <span>${dead.length}</span></h3>
      <p class="lede">Valid orders the hub could not deliver: retries exhausted, or the ERP refused the document. Fix the cause, then replay.</p>
      ${dead.length ? `<p><button type="button" class="btn small primary" data-action="replay-all">Replay all ${dead.length}</button></p>
        <ul class="q-list">${dead.slice(0, 40).map((m) => `<li><p class="q-head">${head(m)} <button type="button" class="link" data-action="open" data-id="${m.id}">Open</button></p><p>${esc(m.deadReason)}</p><div class="q-actions"><button type="button" class="btn small" data-action="replay" data-id="${m.id}">Replay</button></div></li>`).join('')}</ul>` : '<p class="empty">Nothing is undelivered.</p>'}
    </section>
    <section class="queue wait">
      <h3>Parked <span>${parked.length}</span></h3>
      <p class="lede">Changes that arrived before the revision they amend. They release themselves; after ten minutes they ask for a person.</p>
      ${parked.length ? `<ul class="q-list">${parked.map((m) => `<li><p class="q-head">${head(m)} <button type="button" class="link" data-action="open" data-id="${m.id}">Open</button></p><p>${esc(m.events.at(-1).note)}</p></li>`).join('')}</ul>` : '<p class="empty">No change is waiting for an earlier revision.</p>'}
    </section>`;
}

function viewRecon(root) {
  const { hub, report } = state;
  if (!report) {
    root.innerHTML = `
      <div class="recon-intro">
        <h3>Compare the hub's ledger with the ERP</h3>
        <p>Retries and idempotency keys protect a single call. They cannot see an ERP that answers "created" and then fails its own posting job. Reconciliation compares, order by order, what the hub believes it posted with what the ERP holds.</p>
        <button type="button" class="btn primary" data-action="reconcile">Run reconciliation</button>
      </div>`;
    return;
  }
  const order = ['MATCHED', 'MISSING_IN_ERP', 'DUPLICATE_IN_ERP', 'VERSION_BEHIND', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH', 'ORPHAN_IN_ERP'];
  root.innerHTML = `
    <div class="toolbar">
      <p class="stamp">Run at ${clockLabel(report.at)} simulated time. ${report.clean ? 'The hub and the ERP agree on every posted order.' : `${plural(report.breaks.length, 'break')} found.`}</p>
      <button type="button" class="btn" data-action="reconcile">Run again</button>
      ${report.breaks.some((b) => b.result !== 'ORPHAN_IN_ERP') ? '<button type="button" class="btn primary" data-action="repair-all">Repair all</button>' : ''}
    </div>
    ${!report.clean && hub.erp.config.silentDropRate > 0 ? '<p class="note hold">The fault is still switched on, so a repair can be dropped like any other post. Repair again, or set "Accepted, never posted" to 0% first.</p>' : ''}
    <dl class="tally">${order.filter((k) => k === 'MATCHED' || report.summary[k]).map((k) => `<div class="${k === 'MATCHED' ? 'ok' : 'bad'}"><dt>${RESULTS[k]}</dt><dd>${report.summary[k] ?? 0}</dd></div>`).join('')}</dl>
    <h3>Control totals by partner</h3>
    <div class="table-wrap flat"><table class="grid">
      <thead><tr><th>Partner</th><th class="num">Open orders, hub</th><th class="num">Open orders, ERP</th><th class="num">Difference</th><th class="num">Amount, hub</th><th class="num">Amount, ERP</th><th class="num">Difference</th></tr></thead>
      <tbody>${report.controlTotals.map((c) => `<tr class="${c.orderDiff || c.amountDiff ? 'off' : ''}"><td>${esc(hub.md.partners[c.partnerId]?.name ?? c.partnerId)}</td><td class="num">${c.hubOrders}</td><td class="num">${c.erpOrders}</td><td class="num">${c.orderDiff}</td><td class="num">${money(c.hubAmount)}</td><td class="num">${money(c.erpAmount)}</td><td class="num">${money(c.amountDiff)}</td></tr>`).join('') || '<tr><td colspan="7">No posted orders yet.</td></tr>'}</tbody>
    </table></div>
    ${report.open.length ? `<p class="hint">Not breaks, only timing: ${report.open.map((o) => `${o.count} ${STATUS[o.status][0].toLowerCase()} worth ${money(o.amount)}`).join(', ')} are known to the hub and not yet in the ERP.</p>` : ''}
    <h3>Breaks</h3>
    ${report.breaks.length ? `<div class="table-wrap flat"><table class="grid">
      <thead><tr><th>Finding</th><th>Partner</th><th>PO</th><th>Sales order</th><th class="num">Hub rev</th><th class="num">ERP ver</th><th>Detail</th><th></th></tr></thead>
      <tbody>${report.breaks.map((b, i) => `<tr><td><span class="chip dead">${RESULTS[b.result]}</span></td><td>${esc(hub.md.partners[b.partnerId]?.name ?? b.partnerId)}</td><td class="code">${esc(b.poNumber)}</td><td class="code">${esc(b.soNumber ?? '')}</td><td class="num">${b.hubRevision ?? ''}</td><td class="num">${b.erpVersion ?? ''}</td><td>${esc(b.detail)}</td><td>${b.result === 'ORPHAN_IN_ERP' ? 'Needs a person' : `<button type="button" class="btn small" data-action="repair" data-index="${i}">Repair</button>`}</td></tr>`).join('')}</tbody>
    </table></div>` : '<p class="empty">No breaks. Every order the hub posted exists in the ERP once, at the right revision and amount.</p>'}`;
}

function viewMappings(root) {
  const { hub } = state;
  const p = hub.md.partners[state.mapPartner];
  const sample = [...hub.messages.values()].reverse().find((m) => m.partnerId === p.id && !m.internal)?.raw ?? sampleFor(p.id);
  const added = new Set(p.addedXref.map((x) => x.buyerPart));
  root.innerHTML = `
    <div class="toolbar">
      <div class="seg" role="group" aria-label="Partner">${hub.md.partnerIds.map((id) => `<button type="button" data-action="map-partner" data-value="${id}" aria-pressed="${id === p.id}"><span class="pdot p-${id}"></span>${esc(hub.md.partners[id].name)}</button>`).join('')}</div>
    </div>
    <dl class="facts">
      <div><dt>Channel</dt><dd>${esc(p.channel)}</dd></div>
      <div><dt>Format</dt><dd>${esc(adapters[p.format].label)}</dd></div>
      <div><dt>Acknowledged with</dt><dd>${{ x12: '997, then 855', xml: 'OrderResponse document', json: 'JSON response', csv: 'Confirmation file' }[p.format]}</dd></div>
      <div><dt>Changes arrive as</dt><dd>${p.format === 'x12' ? 'Deltas (860)' : 'Full replacement'}</dd></div>
      <div><dt>Price tolerance</dt><dd>${p.tolerancePct}%</dd></div>
      <div><dt>Lead time</dt><dd>${p.leadDays} days</dd></div>
    </dl>
    <div class="map-cols">
      <section>
        <h3>Field mapping</h3>
        <div class="table-wrap flat"><table class="grid">
          <thead><tr><th>Partner field</th><th>Canonical order</th><th>ERP request</th></tr></thead>
          <tbody>${FIELD_MAPS[p.format].map(([a, b, c]) => `<tr><td class="code">${esc(a)}</td><td>${esc(b)}</td><td>${esc(c)}</td></tr>`).join('')}</tbody>
        </table></div>
        <h3>Units and locations</h3>
        <p>${Object.entries(p.uomMap).map(([raw, canon]) => `<span class="code">${esc(raw)}</span> is ${canon === 'CS' ? 'a case' : 'each'}`).join(', ')}. Ship-to codes on file: ${Object.entries(p.shipTos).map(([code, s]) => `<span class="code">${esc(code)}</span> ${esc(s.city)}`).join(', ')}.</p>
      </section>
      <section>
        <h3>Item cross-reference</h3>
        <div class="table-wrap flat short"><table class="grid">
          <thead><tr><th>Partner item code</th><th>Internal SKU</th><th>Description</th><th class="num">Contract, each</th></tr></thead>
          <tbody>${Object.entries(p.xref).map(([part, sku]) => `<tr class="${added.has(part) ? 'new' : ''}"><td class="code">${esc(part)}</td><td class="code">${sku}</td><td>${esc(hub.md.items[sku].description)}${hub.md.items[sku].active ? '' : ' (discontinued)'}${added.has(part) ? ' (added by a reviewer)' : ''}</td><td class="num">${money(hub.md.contractPrice(p.id, sku))}</td></tr>`).join('')}</tbody>
        </table></div>
        <h3>What ${esc(p.name)} sends</h3>
        <pre class="sample">${esc(sample)}</pre>
      </section>
    </div>`;
}

function viewDesign(root) {
  const m = state.hub.metrics();
  const measured = m.straightThroughRate;
  root.innerHTML = `
    <div class="design">
      <p class="lede">Nine decisions carry this design. Each is stated with what breaks without it and what it costs, because every one of them is a trade.</p>
      ${DESIGN_NOTES.map((n) => `
        <article>
          <header><h3>${esc(n.title)}</h3><p class="code">${esc(n.file)}</p></header>
          <dl>
            <div><dt>Decision</dt><dd>${esc(n.decision)}</dd></div>
            <div><dt>Without it</dt><dd>${esc(n.without)}</dd></div>
            <div><dt>What it costs</dt><dd>${esc(n.tradeoff)}</dd></div>
          </dl>
        </article>`).join('')}
      <h3 class="section">From this simulation to production</h3>
      <div class="table-wrap flat"><table class="grid">
        <thead><tr><th>In this repository</th><th>In production</th></tr></thead>
        <tbody>${PRODUCTION_SWAPS.map(([a, b]) => `<tr><td>${esc(a)}</td><td>${esc(b)}</td></tr>`).join('')}</tbody>
      </table></div>
      <h3 class="section">What the automation is worth</h3>
      <p>Hours saved are the orders that pass without a person, times the minutes a person no longer spends keying each one. Change the inputs to match the operation being assessed.</p>
      <form class="calc" id="calc">
        <label>Orders a month <input type="number" name="orders" value="5000" min="0" step="100"></label>
        <label>Minutes to key one order by hand <input type="number" name="manual" value="30" min="0" step="1"></label>
        <label>Minutes to review one exception <input type="number" name="review" value="5" min="0" step="1"></label>
        <label>Straight-through rate, % <input type="number" name="stp" value="${measured == null ? 90 : (measured * 100).toFixed(1)}" min="0" max="100" step="0.1"></label>
        <label>Loaded cost per hour, USD <input type="number" name="rate" value="35" min="0" step="1"></label>
      </form>
      <p class="hint">${measured == null ? 'Run a scenario to replace the straight-through rate with a measured one.' : 'The straight-through rate is the one measured in the current run.'}</p>
      <dl class="tally" id="calc-out"></dl>
    </div>`;
  paintCalc();
}

function paintCalc() {
  const form = $('#calc');
  if (!form) return;
  const v = Object.fromEntries(new FormData(form).entries());
  const n = (k) => Math.max(0, Number(v[k]) || 0);
  const before = n('orders') * n('manual') / 60;
  const after = n('orders') * (1 - n('stp') / 100) * n('review') / 60;
  const saved = Math.max(0, before - after);
  $('#calc-out').innerHTML = [
    ['Hours a month by hand', Math.round(before).toLocaleString('en-US')],
    ['Hours a month with the hub', Math.round(after).toLocaleString('en-US')],
    ['Hours saved a month', Math.round(saved).toLocaleString('en-US')],
    ['Saved a year', Math.round(saved * 12 * n('rate')).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })],
  ].map(([k, val], i) => `<div class="${i >= 2 ? 'ok' : ''}"><dt>${k}</dt><dd>${val}</dd></div>`).join('');
}

// An example payload for a partner that has not sent anything in this run yet.
const samples = new Map();
function sampleFor(partnerId) {
  if (!samples.has(partnerId)) {
    const f = new OrderFactory(state.hub.md, 77);
    samples.set(partnerId, f.render(f.order(partnerId, 0, { lines: 2 })));
  }
  return samples.get(partnerId);
}

const VIEWS = { ledger: viewLedger, queues: viewQueues, recon: viewRecon, mappings: viewMappings, design: viewDesign };

// Each view is redrawn only when the data behind it has changed, so open menus and scroll positions survive.
function signature() {
  const { hub } = state;
  switch (state.tab) {
    case 'ledger': return `${hub.eventSeq}|${state.selected}|${state.detailTab}|${JSON.stringify(state.filter)}`;
    case 'queues': return [...hub.messages.values()].filter((m) => ['EXCEPTION', 'DEAD', 'PARKED'].includes(m.status)).map((m) => `${m.id}${m.status}${m.issues.length}`).join(',');
    case 'recon': return `${state.report?.at}|${state.report?.breaks.length}|${Boolean(state.report)}|${state.reportStamp}`;
    case 'mappings': return `${state.mapPartner}|${hub.md.partners[state.mapPartner].addedXref.length}|${hub.ledger.length}`;
    default: return 'static';
  }
}

function paintView(force = false) {
  const root = $('#view');
  const fresh = state.sig.tab !== state.tab;
  const sig = signature();
  if (!force && !fresh && sig === state.sig.value) return;
  state.sig = { tab: state.tab, value: sig };
  VIEWS[state.tab](root, fresh || force);
}

// ---------- actions ----------

const kick = () => {
  if (state.hub.scheduler.pending) {
    state.running = true;
    state.finished = false;
  }
};

function runScenario() {
  if (state.running) {
    state.running = false;
    return;
  }
  if (state.finished) newHub();
  if (!state.loaded) {
    loadScenario(state.hub, state.scenarioId, state.seed);
    state.loaded = true;
    state.announce = `Scenario started: ${scenarioById(state.scenarioId).title}`;
  }
  state.running = true;
}

function reset() {
  newHub();
  state.sig = {};
  paintTop();
  paintView(true);
}

function runRecon() {
  state.report = reconcile(state.hub);
  state.reportStamp = Date.now();
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action], [data-tab], [data-speed]');
  if (!el) return;
  const { hub } = state;
  if (el.dataset.tab) {
    state.tab = el.dataset.tab;
    $$('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === state.tab));
    paintView();
    return;
  }
  if (el.dataset.speed) {
    state.speed = Number(el.dataset.speed);
    $$('.speed button').forEach((b) => b.setAttribute('aria-pressed', b === el));
    return;
  }
  const { action, id, value } = el.dataset;
  if (action === 'select') state.selected = id;
  else if (action === 'open') { state.selected = id; state.tab = 'ledger'; state.filter = { group: 'all', partner: 'all', q: id }; $$('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === 'ledger')); state.sig = {}; }
  else if (action === 'tab') { state.tab = value; $$('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === value)); }
  else if (action === 'detail-tab') state.detailTab = value;
  else if (action === 'group') { state.filter.group = value; $$('[data-action="group"]').forEach((b) => b.setAttribute('aria-pressed', b === el)); }
  else if (action === 'map-partner') state.mapPartner = value;
  else if (action === 'resolve') {
    const params = {};
    if (el.dataset.fix === 'mapItem') {
      params.buyerPart = el.dataset.part;
      params.sku = el.closest('.fix').querySelector('select').value;
    }
    hub.resolve(id, el.dataset.fix, params);
    kick();
  } else if (action === 'replay') { hub.replay(id); kick(); }
  else if (action === 'replay-all') { hub.replayAll(); kick(); }
  else if (action === 'reconcile') runRecon();
  else if (action === 'repair') { repair(hub, state.report.breaks[Number(el.dataset.index)]); settleThen(runRecon); }
  else if (action === 'repair-all') { repairAll(hub, state.report); settleThen(runRecon); }
  paintTop();
  paintView();
});

// Re-run reconciliation once the repairs it triggered have finished posting.
function settleThen(fn) {
  if (!state.hub.scheduler.pending) return fn();
  state.afterSettle = fn;
  kick();
}

document.addEventListener('keydown', (ev) => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('tr[data-action="select"]')) {
    ev.preventDefault();
    ev.target.click();
  }
});

document.addEventListener('input', (ev) => {
  const el = ev.target;
  const { hub } = state;
  if (el.dataset.action === 'search') state.filter.q = el.value;
  else if (el.dataset.action === 'partner') state.filter.partner = el.value;
  else if (el.id === 'transient') hub.erp.config.transientRate = el.value / 100;
  else if (el.id === 'lost') hub.erp.config.lostResponseRate = el.value / 100;
  else if (el.id === 'silent') hub.erp.config.silentDropRate = el.value / 100;
  else if (el.id === 'offline') { hub.erp.config.offline = el.checked; hub.emit('CHAOS', null, el.checked ? 'ERP taken offline by hand' : 'ERP brought back online by hand'); }
  else if (el.id === 'sg-dedupe') state.safeguards.inboundDedupe = hub.safeguards.inboundDedupe = el.checked;
  else if (el.id === 'sg-idem') state.safeguards.idempotencyKeys = hub.safeguards.idempotencyKeys = el.checked;
  else if (el.id === 'sg-breaker') state.safeguards.circuitBreaker = hub.safeguards.circuitBreaker = el.checked;
  else if (el.closest('#calc')) { paintCalc(); return; }
  else return;
  paintTop();
  paintView();
});

$('#run').addEventListener('click', () => { runScenario(); paintTop(); });
$('#reset').addEventListener('click', reset);
$('#skip').addEventListener('click', () => {
  if (!state.loaded && !state.finished) { loadScenario(state.hub, state.scenarioId, state.seed); state.loaded = true; }
  state.hub.scheduler.drain();
  const notes = state.queue.filter((e) => !e.id && e.note);
  if (notes.length) state.announce = `${clockLabel(notes.at(-1).t)}  ${notes.at(-1).note}`;
  state.queue = []; // skip the dot animation backlog
  recountPass();
  state.running = true; // the loop notices the empty scheduler and finishes the run
});
$('#scenario').addEventListener('change', (ev) => { state.scenarioId = ev.target.value; paintScenario(); reset(); });
$('#seed').addEventListener('change', (ev) => { state.seed = Math.max(1, Number(ev.target.value) || 1); reset(); });
$('#send').addEventListener('click', () => {
  const { hub, factory } = state;
  const partnerId = $('#send-partner').value;
  const spec = factory.order(partnerId, hub.now, { defect: $('#send-kind').value || null });
  const [m] = hub.ingest({ partnerId, text: factory.render(spec) });
  state.selected = m.id;
  kick();
});
$('#resend').addEventListener('click', () => {
  const { hub } = state;
  const last = hub.transmissions.at(-1);
  if (!last) { state.announce = 'Nothing has been transmitted yet, so there is nothing to resend.'; paintTop(); return; }
  const [m] = hub.ingest({ partnerId: last.partnerId, text: last.text });
  state.selected = m.id;
  kick();
});

function recountPass() {
  state.pass = {};
  for (const e of state.hub.events) {
    const stop = PASS_ON[e.type];
    if (stop) state.pass[stop] = (state.pass[stop] ?? 0) + 1;
  }
}

// ---------- loop ----------

let last = performance.now();
let lastPaint = 0;
function frame(ts) {
  const dt = Math.min(100, ts - last);
  last = ts;
  const { hub } = state;
  if (state.running) {
    hub.scheduler.advanceTo(hub.now + dt * state.speed);
    state.dirty = true;
    if (hub.scheduler.pending === 0) {
      state.running = false;
      if (state.loaded) state.finished = true;
      if (state.afterSettle) { const fn = state.afterSettle; state.afterSettle = null; fn(); }
      else if (state.loaded) {
        const i = hub.integrity();
        const need = hub.metrics().needsPerson;
        state.announce = `${clockLabel(hub.now)}  Run finished. ${i.missing ? `${plural(i.missing, 'order')} missing in the ERP: open Reconciliation. ` : ''}${i.postedTwice ? `${plural(i.postedTwice, 'order')} posted twice: open Reconciliation. ` : ''}${need ? `${plural(need, 'message')} waiting in Work queues.` : i.missing || i.postedTwice ? '' : 'Nothing lost, nothing posted twice.'}`;
      }
    }
  }
  if (drainEvents(ts)) state.dirty = true;
  animateDots(ts);
  // The flag survives until a paint happens, so the last change before the clock stops is never skipped.
  if (state.dirty && ts - lastPaint > 110) {
    lastPaint = ts;
    state.dirty = false;
    paintTop();
    paintView();
  }
  requestAnimationFrame(frame);
}

// ---------- start ----------

$('#scenario').innerHTML = SCENARIOS.map((s) => `<option value="${s.id}">${esc(s.title)}</option>`).join('');
newHub();
$('#send-partner').innerHTML = state.hub.md.partnerIds.map((id) => `<option value="${id}">${esc(state.hub.md.partners[id].name)}</option>`).join('');
buildMap();
paintScenario();
paintTop();
paintView(true);
requestAnimationFrame(frame);

// A hook for automated checks and for anyone exploring from the browser console.
window.orderbridge = { state, reconcile: () => reconcile(state.hub) };

// Retry policy and circuit breaker. Both are small on purpose: the behaviour is easier to reason
// about, and to explain, when each fits on one screen.

// Exponential backoff with jitter. Jitter spreads retries so that a recovering ERP is not hit by
// every waiting message at the same instant.
export class RetryPolicy {
  constructor({ maxAttempts = 5, baseMs = 2000, factor = 2, maxMs = 60_000, jitter = 0.2 } = {}) {
    Object.assign(this, { maxAttempts, baseMs, factor, maxMs, jitter });
  }

  // Delay before the attempt that follows `attempt` (1-based).
  delay(attempt, random = Math.random) {
    const raw = Math.min(this.maxMs, this.baseMs * this.factor ** (attempt - 1));
    const spread = 1 + (random() * 2 - 1) * this.jitter;
    return Math.round(raw * spread);
  }

  // The schedule without jitter, for documentation and tests.
  schedule() {
    return Array.from({ length: this.maxAttempts - 1 }, (_, i) => Math.min(this.maxMs, this.baseMs * this.factor ** i));
  }
}

// CLOSED: calls pass. After `failureThreshold` consecutive failures the breaker opens.
// OPEN: calls are refused for `openMs` so the ERP gets room to recover and messages keep their retry budget.
// HALF_OPEN: one probe call is let through. Success closes the breaker, failure reopens it.
export class CircuitBreaker {
  constructor({ failureThreshold = 5, openMs = 30_000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.openMs = openMs;
    this.state = 'CLOSED';
    this.failures = 0;
    this.openedAt = 0;
    this.probeInFlight = false;
    this.transitions = [];
  }

  #go(state, now) {
    if (state === this.state) return;
    this.transitions.push({ at: now, from: this.state, to: state });
    this.state = state;
  }

  allow(now) {
    if (this.state === 'OPEN') {
      if (now - this.openedAt < this.openMs) return { ok: false, retryAt: this.openedAt + this.openMs };
      this.#go('HALF_OPEN', now);
      this.probeInFlight = false;
    }
    if (this.state === 'HALF_OPEN') {
      if (this.probeInFlight) return { ok: false, retryAt: now + 1000 };
      this.probeInFlight = true;
      return { ok: true, probe: true };
    }
    return { ok: true, probe: false };
  }

  success(now) {
    this.failures = 0;
    this.probeInFlight = false;
    this.#go('CLOSED', now);
  }

  failure(now) {
    this.failures++;
    this.probeInFlight = false;
    // In-flight calls can still fail after the breaker opens; they must not extend the open window.
    if (this.state === 'OPEN') return;
    if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.openedAt = now;
      this.#go('OPEN', now);
    }
  }
}

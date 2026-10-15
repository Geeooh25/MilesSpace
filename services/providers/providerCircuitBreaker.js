'use strict';

const DEFAULTS = { threshold: 5, cooldownMs: 60_000, halfOpenProbes: 1 };

const PER_PROVIDER = {
    dtone:       { threshold: 8, cooldownMs: 90_000 },
    nowpayments: { threshold: 6, cooldownMs: 60_000 },
    korapay:     { threshold: 5, cooldownMs: 60_000 },
    paystack:    { threshold: 5, cooldownMs: 60_000 },
    vtpass:      { threshold: 5, cooldownMs: 60_000 },
    smmwiz:      { threshold: 5, cooldownMs: 60_000 },
    virtualsms:  { threshold: 5, cooldownMs: 60_000 }
};

// NOTE: state is per-process. If you ever run more than one backend
// instance, move this to Postgres. Interface stays identical.
const _state = new Map();

function _policy(provider) { return { ...DEFAULTS, ...(PER_PROVIDER[provider] || {}) }; }

function _get(name) {
    if (!_state.has(name)) {
        _state.set(name, { state: 'CLOSED', failures: 0, openedAt: null, probes: 0 });
    }
    return _state.get(name);
}

function allowRequest(provider) {
    const s = _get(provider);
    const p = _policy(provider);
    if (s.state === 'CLOSED') return true;
    if (s.state === 'OPEN') {
        if (Date.now() - s.openedAt >= p.cooldownMs) { s.state = 'HALF'; s.probes = 0; return true; }
        return false;
    }
    if (s.state === 'HALF') {
        if (s.probes < p.halfOpenProbes) { s.probes++; return true; }
        return false;
    }
    return true;
}

function recordSuccess(provider) {
    const s = _get(provider);
    s.failures = 0;
    s.state = 'CLOSED';
    s.openedAt = null;
    s.probes = 0;
}

function recordFailure(provider) {
    const s = _get(provider);
    const p = _policy(provider);
    s.failures++;
    if (s.state === 'HALF') {
        s.state = 'OPEN';
        s.openedAt = Date.now();
        return;
    }
    if (s.failures >= p.threshold) {
        s.state = 'OPEN';
        s.openedAt = Date.now();
    }
}

function reset(provider) { _state.delete(provider); }
function resetAll() { _state.clear(); }

function snapshot() {
    const out = {};
    for (const [name, s] of _state.entries()) {
        const p = _policy(name);
        out[name] = {
            state: s.state,
            failures: s.failures,
            probes: s.probes,
            openedAt: s.openedAt,
            threshold: p.threshold,
            cooldownMs: p.cooldownMs
        };
    }
    return out;
}

module.exports = { allowRequest, recordSuccess, recordFailure, reset, resetAll, snapshot };
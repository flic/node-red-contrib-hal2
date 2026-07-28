'use strict';
const assert = require('node:assert');
const { createBayes, logit, sigmoid } = require('../lib/bayes');

// ---- helpers ----------------------------------------------------------------

const MIN = 60e3;

function cfg(overrides) {
    return Object.assign({
        prior: 0.2, pOn: 0.85, pOff: 0.30, clamp: 6, halfLifeMs: 20 * MIN,
        observations: [], composites: [], candidateRow: '', candidateWindowMs: 5 * MIN
    }, overrides);
}

function eventRow(id, overrides) {
    return Object.assign({ id, name: id, type: 'event', operator: 'true', value: '',
        valueType: 'bool', lr: 3, halfLifeMs: null, onlyAsCandidate: false }, overrides);
}

function stateRow(id, overrides) {
    return Object.assign(eventRow(id), { type: 'state' }, overrides);
}

// Presence-lab composite: door cycle (≤3 min) confirmed by motion (≤2 min window).
function doorComposite(overrides) {
    return Object.assign({ id: 'c1', name: 'entry', armRow: 'door', armPattern: 'cycle',
        cycleMaxMs: 3 * MIN, confirmRow: 'motion', confirmWindowMs: 2 * MIN,
        confirmDuringArm: true, lr: 30, onlyAsCandidate: false }, overrides);
}

function labSetup(compOverrides, cfgOverrides) {
    return createBayes(cfg(Object.assign({
        observations: [
            eventRow('radio'),
            eventRow('door',   { lr: 1 }),
            eventRow('motion', { lr: 1 })
        ],
        composites: [doorComposite(compOverrides)]
    }, cfgOverrides)));
}

const noState = () => undefined;
const pOf = (b, t) => b.evaluate(noState, t).p;

// ---- 1. math primitives -----------------------------------------------------

describe('bayes math', function() {
    it('logit/sigmoid roundtrip', function() {
        for (const p of [0.01, 0.2, 0.5, 0.85, 0.99]) {
            assert.ok(Math.abs(sigmoid(logit(p)) - p) < 1e-12);
        }
    });

    it('posterior is clamped to ±clamp', function() {
        const b = createBayes(cfg({ observations: [eventRow('e', { lr: 1e9 })], clamp: 6 }));
        b.handleEvent(['e'], true, 0);
        const r = b.evaluate(noState, 0);
        assert.ok(r.logOdds <= 6);
        assert.ok(r.p < 1);
    });

    it('per-term ln(LR) is capped to ±clamp', function() {
        const b = createBayes(cfg({ observations: [eventRow('e', { lr: Math.exp(10) })], clamp: 6 }));
        b.handleEvent(['e'], true, 0);
        // single term capped at 6 + prior logit ≈ -1.386 → below hard clamp
        assert.ok(Math.abs(b.evaluate(noState, 0).logOdds - (logit(0.2) + 6)) < 1e-9);
    });

    it('empty estimator sits at the prior', function() {
        const b = createBayes(cfg({ prior: 0.3 }));
        assert.ok(Math.abs(pOf(b, 0) - 0.3) < 1e-12);
    });
});

// ---- 2-3. state vs event evidence -------------------------------------------

describe('state rows', function() {
    it('contribute while the condition holds, vanish when it stops, never decay', function() {
        const b = createBayes(cfg({ observations: [stateRow('tv', { lr: 4 })] }));
        let raw = true;
        const resolve = () => raw;
        const pOn = b.evaluate(resolve, 0).p;
        assert.ok(pOn > 0.2);
        // 10 hours later: identical contribution — no decay
        assert.ok(Math.abs(b.evaluate(resolve, 600 * MIN).p - pOn) < 1e-12);
        raw = false;
        assert.ok(Math.abs(b.evaluate(resolve, 600 * MIN).p - 0.2) < 1e-12);
    });
});

describe('event rows', function() {
    it('rising edge adds a term; repeated identical reports do not', function() {
        const b = createBayes(cfg({ observations: [eventRow('e')] }));
        b.handleEvent(['e'], true, 0);
        const p1 = pOf(b, 0);
        b.handleEvent(['e'], true, 0);
        b.handleEvent(['e'], true, 0);
        assert.ok(Math.abs(pOf(b, 0) - p1) < 1e-12);
        assert.strictEqual(b.evaluate(noState, 0).terms.length, 1);
    });

    it('contribution exactly halves after one half-life', function() {
        const b = createBayes(cfg({ observations: [eventRow('e')] }));
        b.handleEvent(['e'], true, 0);
        const t0 = b.evaluate(noState, 0).logOdds - logit(0.2);
        const t1 = b.evaluate(noState, 20 * MIN).logOdds - logit(0.2);
        assert.ok(Math.abs(t1 - t0 / 2) < 1e-9);
    });

    it('per-row half-life override is honored', function() {
        const b = createBayes(cfg({ observations: [eventRow('e', { halfLifeMs: 5 * MIN })] }));
        b.handleEvent(['e'], true, 0);
        const full = b.evaluate(noState, 0).logOdds - logit(0.2);
        const dec  = b.evaluate(noState, 5 * MIN).logOdds - logit(0.2);
        assert.ok(Math.abs(dec - full / 2) < 1e-9);
    });

    it('a re-trigger needs a falling edge first', function() {
        const b = createBayes(cfg({ observations: [eventRow('e')] }));
        b.handleEvent(['e'], true, 0);
        b.handleEvent(['e'], false, MIN);
        b.handleEvent(['e'], true, 2 * MIN);
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.length, 2);
    });

    it('LR below 1 is negative evidence', function() {
        const b = createBayes(cfg({ observations: [eventRow('gone', { operator: 'false', lr: 0.25 })] }));
        b.handleEvent(['gone'], false, 0);
        assert.ok(pOf(b, 0) < 0.2);
    });
});

// ---- 4. persistence ---------------------------------------------------------

describe('serialize/restore', function() {
    it('decays by wall clock across a restart', function() {
        const a = createBayes(cfg({ observations: [eventRow('e')] }));
        a.handleEvent(['e'], true, 0);
        const saved = a.serialize();

        const b = createBayes(cfg({ observations: [eventRow('e')] }));
        b.restore(saved);
        const expectHalf = (b.evaluate(noState, 20 * MIN).logOdds - logit(0.2));
        assert.ok(Math.abs(expectHalf - Math.log(3) / 2) < 1e-9);
    });

    it('restore tolerates garbage and old shapes', function() {
        const b = createBayes(cfg({}));
        for (const junk of [null, undefined, 42, 'x', {}, { terms: 'no', fsm: 3, binary: 'yes' }]) {
            b.restore(junk);
            const r = b.evaluate(noState, 0);
            assert.strictEqual(r.binary, false);
            assert.strictEqual(r.terms.length, 0);
        }
    });
});

// ---- 5. hysteresis ----------------------------------------------------------

describe('hysteresis', function() {
    it('on at ≥ pOn, holds in between, off at ≤ pOff', function() {
        const b = createBayes(cfg({ observations: [eventRow('big', { lr: 100 })], prior: 0.2 }));
        assert.strictEqual(b.evaluate(noState, 0).binary, false);
        b.handleEvent(['big'], true, 0);
        const on = b.evaluate(noState, 0);
        assert.ok(on.p >= 0.85);
        assert.strictEqual(on.binary, true);
        assert.strictEqual(on.changed, true);

        // decay until P is between thresholds → still on, not changed
        let t = 0, mid;
        for (t = 0; t < 600 * MIN; t += MIN) {
            mid = b.evaluate(noState, t);
            if (mid.p < 0.85) { break; }
        }
        assert.ok(mid.p > 0.30 && mid.p < 0.85);
        assert.strictEqual(mid.binary, true);
        assert.strictEqual(mid.changed, false);

        // decay to prior (0.2 ≤ pOff) → off
        const off = b.evaluate(noState, 6000 * MIN);
        assert.ok(off.p <= 0.30);
        assert.strictEqual(off.binary, false);
        assert.strictEqual(off.changed, true);
    });
});

// ---- 6-8. composite (sequence) rules ----------------------------------------

describe('composite: door cycle + motion', function() {
    it('open→close within cycleMax arms; too slow does not', function() {
        const b = labSetup();
        b.handleEvent(['door'], true, 0);
        b.handleEvent(['door'], false, MIN);           // valid cycle → pending
        b.handleEvent(['motion'], true, 1.5 * MIN);    // confirm
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.length, 1);

        const slow = labSetup();
        slow.handleEvent(['door'], true, 0);
        slow.handleEvent(['door'], false, 4 * MIN);    // > cycleMax
        slow.handleEvent(['motion'], true, 4.5 * MIN);
        assert.strictEqual(slow.evaluate(noState, 5 * MIN).terms.length, 0);
    });

    it('motion during the open phase confirms at close', function() {
        const b = labSetup();
        b.handleEvent(['door'], true, 0);
        b.handleEvent(['motion'], true, 0.5 * MIN);    // while open
        b.handleEvent(['door'], false, MIN);           // fires here
        assert.strictEqual(b.evaluate(noState, MIN).terms.length, 1);
    });

    it('motion before the door opens never counts', function() {
        const b = labSetup();
        b.handleEvent(['motion'], true, 0);
        b.handleEvent(['door'], true, MIN);
        b.handleEvent(['door'], false, 2 * MIN);
        // no motion during arm or pending → nothing fired (yet)
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.length, 0);
    });

    it('confirmDuringArm=false ignores motion during open, still allows pending confirm', function() {
        const b = labSetup({ confirmDuringArm: false });
        b.handleEvent(['door'], true, 0);
        b.handleEvent(['motion'], true, 0.5 * MIN);
        b.handleEvent(['door'], false, MIN);           // pending opens instead of firing
        assert.strictEqual(b.evaluate(noState, MIN).terms.length, 0);
        b.handleEvent(['motion'], false, 1.2 * MIN);
        b.handleEvent(['motion'], true, 1.5 * MIN);    // within pending window
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.length, 1);
    });

    it('pending confirms once, expiry clears, tick expires stale arming', function() {
        const b = labSetup();
        b.handleEvent(['door'], true, 0);
        b.handleEvent(['door'], false, MIN);
        b.handleEvent(['motion'], true, 1.5 * MIN);
        b.handleEvent(['motion'], false, 1.6 * MIN);
        b.handleEvent(['motion'], true, 1.7 * MIN);    // second motion — pending already consumed
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.length, 1);

        const exp = labSetup();
        exp.handleEvent(['door'], true, 0);
        exp.handleEvent(['door'], false, MIN);         // pending until 3 min
        exp.tick(4 * MIN);                             // expires
        exp.handleEvent(['motion'], true, 4.5 * MIN);
        assert.strictEqual(exp.evaluate(noState, 5 * MIN).terms.length, 0);

        const stale = labSetup();
        stale.handleEvent(['door'], true, 0);          // arming
        stale.tick(10 * MIN);                          // > cycleMax — arming dropped
        stale.handleEvent(['door'], false, 10.5 * MIN);
        stale.handleEvent(['motion'], true, 11 * MIN);
        assert.strictEqual(stale.evaluate(noState, 12 * MIN).terms.length, 0);
    });

    it('edge armPattern: arm rising edge opens pending directly', function() {
        const b = createBayes(cfg({
            observations: [eventRow('btn', { lr: 1 }), eventRow('motion', { lr: 1 })],
            composites: [doorComposite({ armRow: 'btn', armPattern: 'edge' })]
        }));
        b.handleEvent(['btn'], true, 0);
        b.handleEvent(['motion'], true, MIN);
        assert.strictEqual(b.evaluate(noState, MIN).terms.length, 1);
    });
});

// ---- 9. candidacy -----------------------------------------------------------

describe('candidacy (onlyAsCandidate)', function() {
    function candSetup() {
        return labSetup({ onlyAsCandidate: true }, { candidateRow: 'radio', candidateWindowMs: 5 * MIN });
    }
    function runCycle(b, t0) {
        b.handleEvent(['door'], true, t0);
        b.handleEvent(['door'], false, t0 + MIN);
        b.handleEvent(['motion'], true, t0 + 1.5 * MIN);
    }

    it('applied when trigger is fresh and estimator is off', function() {
        const b = candSetup();
        b.handleEvent(['radio'], true, 0);             // candidate trigger (also adds LR 3 term)
        runCycle(b, MIN);
        assert.strictEqual(b.evaluate(noState, 3 * MIN).terms.length, 2);
    });

    it('skipped when the trigger edge is too old', function() {
        const b = candSetup();
        b.handleEvent(['radio'], true, 0);
        runCycle(b, 10 * MIN);                          // trigger 10 min old > 5 min window
        // only the radio term exists
        assert.strictEqual(b.evaluate(noState, 12 * MIN).terms.filter(t => t.src === 'c1').length, 0);
    });

    it('exit protection: already-on estimator is never boosted', function() {
        const b = candSetup();
        b.force(true);
        b.handleEvent(['radio'], true, 0);
        runCycle(b, MIN);
        assert.strictEqual(b.evaluate(noState, 3 * MIN).terms.filter(t => t.src === 'c1').length, 0);
    });

    it('candidacy is frozen at arm time', function() {
        const b = candSetup();
        b.handleEvent(['radio'], true, 0);
        b.handleEvent(['door'], true, MIN);
        b.handleEvent(['door'], false, 2 * MIN);        // arm completes → candidacy frozen (ok)
        b.force(true);                                  // flips on after arming
        b.handleEvent(['motion'], true, 3 * MIN);       // confirm still applies
        assert.strictEqual(b.evaluate(noState, 3 * MIN).terms.filter(t => t.src === 'c1').length, 1);
    });

    it('no candidate row configured → gate degrades to "not on"', function() {
        const b = labSetup({ onlyAsCandidate: true }, { candidateRow: '' });
        runCycle(b, 0);
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.filter(t => t.src === 'c1').length, 1);
    });
});

// ---- 10. escape hatches + pruning -------------------------------------------

describe('inject / reset / force / pruning', function() {
    it('inject adds a decaying term', function() {
        const b = createBayes(cfg({}));
        assert.strictEqual(b.inject(30, 10 * MIN, 0), true);
        assert.ok(pOf(b, 0) > 0.8);
        assert.ok(pOf(b, 60 * MIN) < pOf(b, 0));
    });

    it('inject rejects nonsense', function() {
        const b = createBayes(cfg({}));
        assert.strictEqual(b.inject(0, null, 0), false);
        assert.strictEqual(b.inject(-3, null, 0), false);
        assert.strictEqual(b.inject('x', null, 0), false);
        assert.strictEqual(b.inject(1, null, 0), false);   // LR 1 = no evidence
    });

    it('reset returns to prior and clears everything', function() {
        const b = createBayes(cfg({ observations: [eventRow('e', { lr: 100 })] }));
        b.handleEvent(['e'], true, 0);
        b.evaluate(noState, 0);
        b.reset();
        const r = b.evaluate(noState, 0);
        assert.strictEqual(r.binary, false);
        assert.strictEqual(r.terms.length, 0);
        assert.ok(Math.abs(r.p - 0.2) < 1e-12);
    });

    it('tick prunes decayed-out terms', function() {
        const b = createBayes(cfg({ observations: [eventRow('e', { halfLifeMs: MIN })] }));
        b.handleEvent(['e'], true, 0);
        b.tick(30 * MIN);                               // ln3 · 2^-30 ≈ 1e-9 — dead
        assert.strictEqual(b.evaluate(noState, 30 * MIN).terms.length, 0);
    });
});

'use strict';
const assert = require('node:assert');
const { createBayes, logit, sigmoid } = require('../lib/bayes');
const scale = require('../resources/bayes-scale');

const MIN = 60e3;
const HOUR = 60 * MIN;

// ---- helpers ----------------------------------------------------------------

// evaluate() now reports every rule once, with a status, instead of an activeRules list and a
// terms list. These ask the same two questions of the new shape: which rules hold a weight
// right now, and which are carrying a decaying one.
const active = r => r.rules.filter(x => x.status === 'contributing');
const fading = r => r.rules.filter(x => x.status === 'fading' || x.status === 'injected');
const byId   = (r, id) => r.rules.find(x => x.id === id);

function cfgOf(overrides) {
    return Object.assign({
        prior: 0.2, pOn: 0.85, pOff: 0.30, clamp: 6, halfLifeMs: 20 * MIN,
        latch: false, maxHoldMs: 0, rules: []
    }, overrides);
}

function step(pattern, overrides) {
    return Object.assign({ thing: 't', item: 'i', operator: 'true', value: '', valueType: 'str',
        pattern: pattern, cycleMaxMs: 3 * MIN, windowMs: 2 * MIN }, overrides);
}

// Continuous rule: a lone level check.
function contRule(id, lr, stepOverrides) {
    return { id, lr, halfLifeMs: null, steps: [step('is', stepOverrides)] };
}

// The lab's arrival: door cycle then motion, as a two-step momentary rule.
function arrivalRule(id, lr) {
    return { id, lr, halfLifeMs: null,
        steps: [step('cycle', { thing: 'door' }), step('becomes', { thing: 'motion' })] };
}

const hit = (ruleId, stepIndex) => [{ ruleId, stepIndex }];
const noState = () => undefined;
// Level-check resolver backed by a mutable map keyed on step.thing.
const stateOf = map => (s => map[s.thing]);
const pOf = (b, t) => b.evaluate(noState, t).p;

// ---- scale helpers ----------------------------------------------------------

describe('bayes-scale', function() {
    it('required gain with defaults is 3.121', function() {
        assert.ok(Math.abs(scale.requiredGain(0.2, 0.85) - 3.1209) < 1e-3);
    });

    it('strength shares: strong 74 %, decisive over 100 %, certain saturates', function() {
        const share = lr => scale.shareOfWay(lr, 0.2, 0.85, 6);
        assert.ok(Math.abs(share(10) - 0.7378) < 1e-3);
        assert.ok(share(30) > 1);
        assert.ok(Math.abs(share(400) - Math.log(400) / 3.1209) < 1e-3);   // ln 400 ≈ 5.99, inside the clamp
    });

    it('direction false yields a negative share; shares add', function() {
        const share = lr => scale.shareOfWay(lr, 0.2, 0.85, 6);
        assert.ok(share(1 / 3) < 0);
        assert.ok(Math.abs(share(10) + share(3) - (share(10) + share(3))) < 1e-12);
        assert.ok(share(10) + share(3) > 1);                    // strong + moderate ⇒ enough
    });

    it('offAfterMs: reference momentary term decays to off in ~21 min', function() {
        // A lone moderate term at full strength on top of the prior.
        const t = scale.offAfterMs([{ l0: Math.log(3), halfLifeMs: 20 * MIN }], 0.2, 0.30, 6);
        assert.ok(t > 15 * MIN && t < 30 * MIN, 'got ' + t);
    });

    it('offAfterMs: already off gives 0, prior above pOff gives null', function() {
        assert.strictEqual(scale.offAfterMs([], 0.2, 0.30, 6), 0);
        assert.strictEqual(scale.offAfterMs([{ l0: 2, halfLifeMs: MIN }], 0.4, 0.30, 6), null);
    });

    it('scaleShare interpolates, clamps, and rejects what it cannot use', function() {
        const spec = { fromValue: 20, fromShare: 1, toValue: 60, toShare: 0 };
        assert.strictEqual(scale.scaleShare(20, spec), 1);
        assert.strictEqual(scale.scaleShare(60, spec), 0);
        assert.ok(Math.abs(scale.scaleShare(40, spec) - 0.5) < 1e-12);
        assert.strictEqual(scale.scaleShare(5, spec), 1);      // clamped below
        assert.strictEqual(scale.scaleShare(95, spec), 0);     // clamped above
        // Points may be entered in either order.
        assert.ok(Math.abs(scale.scaleShare(40, { fromValue: 60, fromShare: 0, toValue: 20, toShare: 1 }) - 0.5) < 1e-12);
        for (const bad of ['abc', null, undefined, '', '  ', NaN, true, false, {}, []]) {
            assert.strictEqual(scale.scaleShare(bad, spec), null, 'should reject ' + JSON.stringify(bad));
        }
        assert.ok(Math.abs(scale.scaleShare('40', spec) - 0.5) < 1e-12, 'numeric strings are readings');
        assert.strictEqual(scale.scaleShare(30, { fromValue: 20, fromShare: 1, toValue: 20, toShare: 0 }), null);
        assert.strictEqual(scale.scaleShare(30, null), null);
    });

    it('shareToLn inverts shareOfWay', function() {
        for (const lr of [1.5, 3, 10, 30]) {
            const share = scale.shareOfWay(lr, 0.2, 0.85, 6);
            assert.ok(Math.abs(scale.shareToLn(share, 0.2, 0.85, 6) - Math.log(lr)) < 1e-9);
        }
    });

    it('strength and fade tables resolve labels', function() {
        assert.strictEqual(scale.strengthLr('strong'), 10);
        assert.strictEqual(scale.strengthLr('unknown'), 3);
        assert.strictEqual(scale.fadeSeconds('slow'), 3600);
        assert.strictEqual(scale.fadeSeconds('unknown'), 1200);
        assert.strictEqual(scale.fadeSeconds('never'), scale.NEVER_SECONDS);
    });

    it('the "never" sentinel is finite, JSON-safe and effectively undecaying', function() {
        assert.ok(isFinite(scale.NEVER_SECONDS));
        assert.strictEqual(JSON.parse(JSON.stringify(scale.NEVER_SECONDS)), scale.NEVER_SECONDS);
        assert.ok(scale.NEVER_SECONDS * 1000 < Number.MAX_SAFE_INTEGER);
        // A century of decay leaves the contribution essentially untouched (>99.5 %).
        const century = 100 * 365 * 24 * HOUR;
        assert.ok(Math.pow(2, -century / (scale.NEVER_SECONDS * 1000)) > 0.995);
    });
});

// ---- 1-3. continuous rules --------------------------------------------------

describe('continuous rules', function() {
    it('contribute while true, gone when false, never decay', function() {
        const b = createBayes(cfgOf({ rules: [contRule('tv', 4)] }));
        let raw = true;
        const resolve = () => raw;
        const pOn = b.evaluate(resolve, 0).p;
        assert.ok(pOn > 0.2);
        assert.ok(Math.abs(b.evaluate(resolve, 600 * MIN).p - pOn) < 1e-12);   // 10 h later: identical
        raw = false;
        assert.ok(Math.abs(b.evaluate(resolve, 600 * MIN).p - 0.2) < 1e-12);
    });

    it('direction false (reciprocal LR) pushes down', function() {
        const b = createBayes(cfgOf({ rules: [contRule('away', 1 / 3)] }));
        assert.ok(b.evaluate(() => true, 0).p < 0.2);
    });

    it('a lone certain rule flips the output; certain false drops it', function() {
        const on = createBayes(cfgOf({ rules: [contRule('sure', 400)] }));
        let raw = true;
        const r1 = on.evaluate(() => raw, 0);
        assert.strictEqual(r1.binary, true);
        assert.ok(r1.p > 0.99);

        const b = createBayes(cfgOf({ rules: [contRule('sureOn', 400, { thing: 'a' }),
                                              contRule('sureOff', 1 / 400, { thing: 'x' })] }));
        const states = { a: true, x: false };
        const resolve = s => states[s.thing];
        assert.strictEqual(b.evaluate(resolve, 0).binary, true);
        states.x = true;   // certain false now also active — cancels, drops below pOff
        assert.strictEqual(b.evaluate(resolve, 1).binary, false);
    });

    it('the reference case: strong alone off, moderate alone off, both on', function() {
        // iPhone (continuous strong) + arrival (momentary moderate).
        const b = createBayes(cfgOf({ rules: [contRule('phone', 10, { thing: 'ph' }), arrivalRule('arr', 3)] }));
        let phone = false;
        const resolve = s => (s.thing === 'ph' ? phone : undefined);

        // Arrival fires alone: moderate ⇒ off.
        b.handleEvent(hit('arr', 0), true, 0);
        b.handleEvent(hit('arr', 0), false, MIN);
        b.handleEvent(hit('arr', 1), true, 1.5 * MIN);
        let r = b.evaluate(resolve, 2 * MIN);
        assert.ok(r.p < 0.85);
        assert.strictEqual(r.binary, false);

        // Phone appears: strong + moderate ⇒ on.
        phone = true;
        r = b.evaluate(resolve, 2 * MIN);
        assert.ok(r.p >= 0.85);
        assert.strictEqual(r.binary, true);

        // Phone alone (arrival decayed away): strong ⇒ stays on only via hysteresis…
        const alone = createBayes(cfgOf({ rules: [contRule('phone', 10, { thing: 'ph' })] }));
        const rAlone = alone.evaluate(() => true, 0);
        assert.ok(rAlone.p < 0.85);
        assert.strictEqual(rAlone.binary, false);
    });
});

// ---- 4. certainty interactions ---------------------------------------------

describe('certain terms', function() {
    it('a certain rule clears opposing terms when it fires', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 30), arrivalRule('exit', 1 / 400)] }));
        // Arrival fires (+ decisive term).
        b.handleEvent(hit('arr', 0), true, 0);
        b.handleEvent(hit('arr', 0), false, MIN);
        b.handleEvent(hit('arr', 1), true, 1.5 * MIN);
        assert.strictEqual(fading(b.evaluate(noState, 2 * MIN)).length, 1);
        // Exit (certain false) fires — the positive term is cleared, not fought.
        b.handleEvent(hit('exit', 0), true, 3 * MIN);
        b.handleEvent(hit('exit', 0), false, 4 * MIN);
        b.handleEvent(hit('exit', 1), true, 4.5 * MIN);
        const r = b.evaluate(noState, 5 * MIN);
        assert.deepStrictEqual(fading(r).map(t => t.id), ['exit']);
        assert.ok(r.p < 0.05);
    });

    it('any opposing firing clears a stored certain term (return home is not blocked)', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 3), arrivalRule('exit', 1 / 400)] }));
        // Exit fired earlier — a certain false statement.
        b.handleEvent(hit('exit', 0), true, 0);
        b.handleEvent(hit('exit', 0), false, MIN);
        b.handleEvent(hit('exit', 1), true, 1.5 * MIN);
        assert.strictEqual(fading(b.evaluate(noState, 2 * MIN)).length, 1);
        // Coming back: a mere moderate arrival invalidates the certain statement.
        b.handleEvent(hit('arr', 0), true, 10 * MIN);
        b.handleEvent(hit('arr', 0), false, 11 * MIN);
        b.handleEvent(hit('arr', 1), true, 11.5 * MIN);
        const r = b.evaluate(noState, 12 * MIN);
        assert.deepStrictEqual(fading(r).map(t => t.id), ['arr']);
        assert.ok(r.p > 0.2);
    });

    it('weak opposing terms accumulate — no clearing between them', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('up', 3), arrivalRule('down', 1 / 3)] }));
        b.handleEvent(hit('up', 0), true, 0);
        b.handleEvent(hit('up', 0), false, MIN);
        b.handleEvent(hit('up', 1), true, 1.5 * MIN);
        b.handleEvent(hit('down', 0), true, 3 * MIN);
        b.handleEvent(hit('down', 0), false, 4 * MIN);
        b.handleEvent(hit('down', 1), true, 4.5 * MIN);
        assert.strictEqual(fading(b.evaluate(noState, 5 * MIN)).length, 2);
    });
});

// ---- 5. momentary decay -----------------------------------------------------

describe('momentary rules decay', function() {
    it('term on completion, halves after one half-life, per-rule override honoured', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 3)] }));
        b.handleEvent(hit('arr', 0), true, 0);
        b.handleEvent(hit('arr', 0), false, MIN);
        b.handleEvent(hit('arr', 1), true, 2 * MIN);
        const full = b.evaluate(noState, 2 * MIN).logOdds - logit(0.2);
        const dec  = b.evaluate(noState, 22 * MIN).logOdds - logit(0.2);
        assert.ok(Math.abs(dec - full / 2) < 1e-9);

        const fast = createBayes(cfgOf({ rules: [Object.assign(arrivalRule('a', 3), { halfLifeMs: 5 * MIN })] }));
        fast.handleEvent(hit('a', 0), true, 0);
        fast.handleEvent(hit('a', 0), false, MIN);
        fast.handleEvent(hit('a', 1), true, 2 * MIN);
        const f0 = fast.evaluate(noState, 2 * MIN).logOdds - logit(0.2);
        const f1 = fast.evaluate(noState, 7 * MIN).logOdds - logit(0.2);
        assert.ok(Math.abs(f1 - f0 / 2) < 1e-9);
    });

    it('tick prunes decayed-out terms', function() {
        const b = createBayes(cfgOf({ rules: [Object.assign(arrivalRule('a', 3), { halfLifeMs: MIN })] }));
        b.handleEvent(hit('a', 0), true, 0);
        b.handleEvent(hit('a', 0), false, 0.5 * MIN);
        b.handleEvent(hit('a', 1), true, MIN);
        b.tick(40 * MIN);
        assert.strictEqual(fading(b.evaluate(noState, 40 * MIN)).length, 0);
    });
});

// ---- 6-10. step sequences ---------------------------------------------------

describe('step sequences', function() {
    it('valid cycle plus an edge inside the window fires; too slow a cycle does not', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        b.handleEvent(hit('arr', 0), true, 0);
        b.handleEvent(hit('arr', 0), false, MIN);            // cycle ok (≤ 3 min)
        b.handleEvent(hit('arr', 1), true, 2 * MIN);          // within 2 min window
        assert.strictEqual(fading(b.evaluate(noState, 2 * MIN)).length, 1);

        const slow = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        slow.handleEvent(hit('arr', 0), true, 0);
        slow.handleEvent(hit('arr', 0), false, 4 * MIN);      // > cycleMax
        slow.handleEvent(hit('arr', 1), true, 4.5 * MIN);
        assert.strictEqual(fading(slow.evaluate(noState, 5 * MIN)).length, 0);
    });

    it('overlap: an edge during the previous step counts at its completion', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        b.handleEvent(hit('arr', 0), true, 0);                // door opens
        b.handleEvent(hit('arr', 1), true, 0.5 * MIN);        // motion while open
        b.handleEvent(hit('arr', 0), false, MIN);             // door closes — fires here
        assert.strictEqual(fading(b.evaluate(noState, MIN)).length, 1);
    });

    it('an edge before arming never counts', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        b.handleEvent(hit('arr', 1), true, 0);                // motion before the door ever opens
        b.handleEvent(hit('arr', 0), true, 5 * MIN);
        b.handleEvent(hit('arr', 0), false, 6 * MIN);
        assert.strictEqual(fading(b.evaluate(noState, 6 * MIN)).length, 0);
        // …but fresh motion within the window still confirms
        b.handleEvent(hit('arr', 1), false, 6.5 * MIN);
        b.handleEvent(hit('arr', 1), true, 7 * MIN);
        assert.strictEqual(fading(b.evaluate(noState, 7 * MIN)).length, 1);
    });

    it('a three-step rule completes in order and not out of order', function() {
        const rule = { id: 'r3', lr: 30, halfLifeMs: null, steps: [
            step('becomes', { thing: 'phone' }),
            step('cycle',   { thing: 'door', windowMs: 5 * MIN }),
            step('becomes', { thing: 'motion', windowMs: 2 * MIN })
        ] };
        const b = createBayes(cfgOf({ rules: [rule] }));
        b.handleEvent(hit('r3', 0), true, 0);                 // phone appears
        b.handleEvent(hit('r3', 1), true, MIN);               // door opens
        b.handleEvent(hit('r3', 1), false, 2 * MIN);          // door closes
        b.handleEvent(hit('r3', 2), true, 3 * MIN);           // motion
        assert.strictEqual(fading(b.evaluate(noState, 3 * MIN)).length, 1);

        const wrong = createBayes(cfgOf({ rules: [rule] }));
        wrong.handleEvent(hit('r3', 1), true, 0);             // door first — ignored at step 0
        wrong.handleEvent(hit('r3', 1), false, MIN);
        wrong.handleEvent(hit('r3', 2), true, 1.5 * MIN);
        assert.strictEqual(fading(wrong.evaluate(noState, 2 * MIN)).length, 0);
    });

    it('timeout between steps resets the sequence; tick also cleans up', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        b.handleEvent(hit('arr', 0), true, 0);
        b.handleEvent(hit('arr', 0), false, MIN);             // pending, window 2 min
        b.handleEvent(hit('arr', 1), true, 5 * MIN);          // too late
        assert.strictEqual(fading(b.evaluate(noState, 5 * MIN)).length, 0);

        const t = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        t.handleEvent(hit('arr', 0), true, 0);                // door opens, never closes
        t.tick(10 * MIN);                                     // stale opening dropped
        t.handleEvent(hit('arr', 0), false, 10.5 * MIN);      // close without tracked open
        t.handleEvent(hit('arr', 1), true, 11 * MIN);
        assert.strictEqual(fading(t.evaluate(noState, 11 * MIN)).length, 0);
    });

    it('no rising edge on step 0 means nothing ever arms (exit protection)', function() {
        const b = createBayes(cfgOf({ rules: [{ id: 'r', lr: 30, halfLifeMs: null, steps: [
            step('becomes', { thing: 'phone' }), step('becomes', { thing: 'motion' })
        ] }] }));
        // Phone goes true→false is a falling edge on "is true" — never arms.
        b.handleEvent(hit('r', 0), false, 0);
        b.handleEvent(hit('r', 1), true, MIN);
        assert.strictEqual(fading(b.evaluate(noState, MIN)).length, 0);
    });

    it('a level check is answered when the previous step completes, whenever it turned true', function() {
        // Door-first arrival: the phone went true long before the door ever opened,
        // so an edge-based step would never fire — a level check does.
        const rule = { id: 'arr', lr: 30, halfLifeMs: null, steps: [
            step('cycle', { thing: 'door' }),
            step('is',    { thing: 'phone' })
        ] };
        const state = { phone: true };
        const b = createBayes(cfgOf({ rules: [rule] }));
        b.handleEvent(hit('arr', 0), true, 60 * MIN, stateOf(state));      // door opens
        b.handleEvent(hit('arr', 0), false, 61 * MIN, stateOf(state));     // closes → level check
        assert.strictEqual(fading(b.evaluate(noState, 61 * MIN)).length, 1);
    });

    it('a failing level check aborts the sequence', function() {
        const rule = { id: 'arr', lr: 30, halfLifeMs: null, steps: [
            step('cycle', { thing: 'door' }),
            step('is',    { thing: 'phone' })
        ] };
        const state = { phone: false };                                    // somebody else's door cycle
        const b = createBayes(cfgOf({ rules: [rule] }));
        b.handleEvent(hit('arr', 0), true, 0, stateOf(state));
        b.handleEvent(hit('arr', 0), false, MIN, stateOf(state));
        assert.strictEqual(fading(b.evaluate(noState, MIN)).length, 0);
        // …and the sequence is reset, so the next real cycle still works.
        state.phone = true;
        b.handleEvent(hit('arr', 0), true, 10 * MIN, stateOf(state));
        b.handleEvent(hit('arr', 0), false, 11 * MIN, stateOf(state));
        assert.strictEqual(fading(b.evaluate(noState, 11 * MIN)).length, 1);
    });

    it('"is or becomes" accepts a condition that already holds', function() {
        const rule = { id: 'arr', lr: 30, halfLifeMs: null, steps: [
            step('cycle',       { thing: 'door' }),
            step('isOrBecomes', { thing: 'phone' })
        ] };
        const state = { phone: true };
        const b = createBayes(cfgOf({ rules: [rule] }));
        b.handleEvent(hit('arr', 0), true, 0, stateOf(state));
        b.handleEvent(hit('arr', 0), false, MIN, stateOf(state));
        assert.strictEqual(fading(b.evaluate(noState, MIN)).length, 1);
    });

    it('"is or becomes" waits for a late sensor instead of aborting', function() {
        const rule = { id: 'arr', lr: 30, halfLifeMs: null, steps: [
            step('cycle',       { thing: 'door' }),
            step('isOrBecomes', { thing: 'phone', windowMs: 2 * MIN })
        ] };
        const state = { phone: false };                       // sensor has not caught up yet
        const b = createBayes(cfgOf({ rules: [rule] }));
        b.handleEvent(hit('arr', 0), true, 0, stateOf(state));
        b.handleEvent(hit('arr', 0), false, MIN, stateOf(state));
        assert.strictEqual(fading(b.evaluate(noState, MIN)).length, 0);   // pending, not aborted

        state.phone = true;
        b.handleEvent(hit('arr', 1), true, 2 * MIN, stateOf(state));    // arrives inside the window
        assert.strictEqual(fading(b.evaluate(noState, 2 * MIN)).length, 1);
    });

    it('"is or becomes" still times out when the sensor never reports', function() {
        const rule = { id: 'arr', lr: 30, halfLifeMs: null, steps: [
            step('cycle',       { thing: 'door' }),
            step('isOrBecomes', { thing: 'phone', windowMs: 2 * MIN })
        ] };
        const state = { phone: false };
        const b = createBayes(cfgOf({ rules: [rule] }));
        b.handleEvent(hit('arr', 0), true, 0, stateOf(state));
        b.handleEvent(hit('arr', 0), false, MIN, stateOf(state));
        state.phone = true;
        b.handleEvent(hit('arr', 1), true, 10 * MIN, stateOf(state));    // far too late
        assert.strictEqual(fading(b.evaluate(noState, 10 * MIN)).length, 0);
    });

    it('"now or soon" completes on a later tick when a polled source turns true', function() {
        // flow/global/env have no change event, so the fallback edge never arrives —
        // tick() re-checks the level instead.
        const rule = { id: 'r', lr: 30, halfLifeMs: null, steps: [
            step('cycle',       { thing: 'door' }),
            step('isOrBecomes', { thing: 'flowvar', windowMs: 5 * MIN })
        ] };
        const state = { flowvar: false };
        const b = createBayes(cfgOf({ rules: [rule] }));
        b.handleEvent(hit('r', 0), true, 0, stateOf(state));
        b.handleEvent(hit('r', 0), false, MIN, stateOf(state));      // pending, level still false
        assert.strictEqual(fading(b.evaluate(noState, MIN)).length, 0);

        state.flowvar = true;                                         // changes with no event
        b.tick(3 * MIN, stateOf(state));
        assert.strictEqual(fading(b.evaluate(noState, 3 * MIN)).length, 1);
    });

    it('a polled "now or soon" still times out if it never turns true', function() {
        const rule = { id: 'r', lr: 30, halfLifeMs: null, steps: [
            step('cycle',       { thing: 'door' }),
            step('isOrBecomes', { thing: 'flowvar', windowMs: 2 * MIN })
        ] };
        const state = { flowvar: false };
        const b = createBayes(cfgOf({ rules: [rule] }));
        b.handleEvent(hit('r', 0), true, 0, stateOf(state));
        b.handleEvent(hit('r', 0), false, MIN, stateOf(state));
        b.tick(10 * MIN, stateOf(state));                             // window long gone
        state.flowvar = true;
        b.tick(11 * MIN, stateOf(state));
        assert.strictEqual(fading(b.evaluate(noState, 11 * MIN)).length, 0);
    });

    it('a tick-completed step cascades into a following condition step', function() {
        const rule = { id: 'r', lr: 30, halfLifeMs: null, steps: [
            step('cycle',       { thing: 'door' }),
            step('isOrBecomes', { thing: 'flowvar', windowMs: 5 * MIN }),
            step('is',          { thing: 'phone' })
        ] };
        const state = { flowvar: false, phone: true };
        const b = createBayes(cfgOf({ rules: [rule] }));
        b.handleEvent(hit('r', 0), true, 0, stateOf(state));
        b.handleEvent(hit('r', 0), false, MIN, stateOf(state));
        state.flowvar = true;
        b.tick(2 * MIN, stateOf(state));
        assert.strictEqual(fading(b.evaluate(noState, 2 * MIN)).length, 1);
    });

    it('tick without a resolver leaves pending steps alone', function() {
        const rule = { id: 'r', lr: 30, halfLifeMs: null, steps: [
            step('cycle',       { thing: 'door' }),
            step('isOrBecomes', { thing: 'flowvar', windowMs: 5 * MIN })
        ] };
        const b = createBayes(cfgOf({ rules: [rule] }));
        b.handleEvent(hit('r', 0), true, 0, stateOf({ flowvar: true }));
        b.handleEvent(hit('r', 0), false, MIN, stateOf({ flowvar: false }));
        b.tick(2 * MIN);                                              // no resolver passed
        assert.strictEqual(fading(b.evaluate(noState, 2 * MIN)).length, 0);
    });

    it('level checks chain: door cycle, then motion, and the phone is here', function() {
        const rule = { id: 'arr', lr: 30, halfLifeMs: null, steps: [
            step('cycle',   { thing: 'door' }),
            step('becomes', { thing: 'motion' }),
            step('is',      { thing: 'phone' })
        ] };
        const state = { phone: true };
        const b = createBayes(cfgOf({ rules: [rule] }));
        b.handleEvent(hit('arr', 0), true, 0, stateOf(state));
        b.handleEvent(hit('arr', 0), false, MIN, stateOf(state));
        b.handleEvent(hit('arr', 1), true, 1.5 * MIN, stateOf(state));
        assert.strictEqual(fading(b.evaluate(noState, 2 * MIN)).length, 1);
    });

    it('repeated identical reports count once (edge dedupe)', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        b.handleEvent(hit('arr', 0), true, 0);
        b.handleEvent(hit('arr', 0), true, 10);               // repeat — no new edge
        b.handleEvent(hit('arr', 0), false, MIN);
        b.handleEvent(hit('arr', 1), true, 1.5 * MIN);
        b.handleEvent(hit('arr', 1), true, 1.6 * MIN);        // repeat
        assert.strictEqual(fading(b.evaluate(noState, 2 * MIN)).length, 1);
    });
});

// ---- 11-13. hysteresis and the latch ----------------------------------------

describe('hysteresis and latch', function() {
    function onThenPhoneDrops(latch, maxHoldMs) {
        const b = createBayes(cfgOf({ latch, maxHoldMs: maxHoldMs || 0,
            rules: [contRule('phone', 10, { thing: 'ph' }), arrivalRule('arr', 3)] }));
        const state = { ph: true };
        const resolve = s => state[s.thing];
        b.handleEvent(hit('arr', 0), true, 0);
        b.handleEvent(hit('arr', 0), false, MIN);
        b.handleEvent(hit('arr', 1), true, 1.5 * MIN);
        assert.strictEqual(b.evaluate(resolve, 2 * MIN).binary, true);   // on
        state.ph = false;                                                 // phone drops out
        return { b, resolve, state };
    }

    it('hysteresis holds between the thresholds', function() {
        const { b, resolve } = onThenPhoneDrops(false);
        const r = b.evaluate(resolve, 3 * MIN);       // arrival term still fresh: p ≈ 0.43
        assert.ok(r.p > 0.30 && r.p < 0.85);
        assert.strictEqual(r.binary, true);
        assert.strictEqual(r.changed, false);
    });

    it('without the latch, decay turns the output off', function() {
        const { b, resolve } = onThenPhoneDrops(false);
        const r = b.evaluate(resolve, 5 * HOUR);
        assert.strictEqual(r.binary, false);
        assert.strictEqual(r.held, false);
    });

    it('with the latch, silence keeps it on (held) until a false rule fires', function() {
        const b = createBayes(cfgOf({ latch: true,
            rules: [contRule('phone', 10, { thing: 'ph' }), arrivalRule('arr', 3),
                    arrivalRule('exit', 1 / 400)] }));
        const state = { ph: true };
        const resolve = s => state[s.thing];
        b.handleEvent(hit('arr', 0), true, 0);
        b.handleEvent(hit('arr', 0), false, MIN);
        b.handleEvent(hit('arr', 1), true, 1.5 * MIN);
        assert.strictEqual(b.evaluate(resolve, 2 * MIN).binary, true);

        state.ph = false;                                     // spurious dropout — door never opened
        const held = b.evaluate(resolve, 5 * HOUR);
        assert.strictEqual(held.binary, true);
        assert.strictEqual(held.held, true);

        // A real exit fires the certain-false rule — now it turns off.
        b.handleEvent(hit('exit', 0), true, 5 * HOUR);
        b.handleEvent(hit('exit', 0), false, 5 * HOUR + MIN);
        b.handleEvent(hit('exit', 1), true, 5 * HOUR + 1.5 * MIN);
        const off = b.evaluate(resolve, 5 * HOUR + 2 * MIN);
        assert.strictEqual(off.binary, false);
    });

    it('maxHold expires the latch after the configured silence', function() {
        const { b, resolve } = onThenPhoneDrops(true, 2 * HOUR);
        // A decaying term above the prune floor still counts as supporting evidence,
        // so each of these evaluations refreshes the silence clock.
        assert.strictEqual(b.evaluate(resolve, 10 * MIN).binary, true);
        const mid = b.evaluate(resolve, 70 * MIN);   // term ≈ 0.10 — still positive, p ≤ pOff
        assert.strictEqual(mid.binary, true);
        assert.strictEqual(mid.held, true);
        // 4 h later the term has pruned and 2 h of true silence have passed.
        const late = b.evaluate(resolve, 70 * MIN + 4 * HOUR);
        assert.strictEqual(late.binary, false);
    });

    it('blank maxHold never expires', function() {
        const { b, resolve } = onThenPhoneDrops(true, 0);
        const r = b.evaluate(resolve, 400 * HOUR);
        assert.strictEqual(r.binary, true);
        assert.strictEqual(r.held, true);
    });
});

// ---- value-scaled weight -----------------------------------------------------

describe('scaled rule weight', function() {
    // "The drier the soil, the more this matters": 20 % moisture is worth the whole way
    // to on, 60 % is worth nothing.
    const soilAt = fromShare => ({ id: 'soil', lr: 1, halfLifeMs: null,
        scale: { fromValue: 20, fromShare, toValue: 60, toShare: 0 },
        steps: [step('is', { thing: 'soil', operator: 'lt', value: '60', valueType: 'num' })] });
    const soil = () => soilAt(1.2);

    it('a continuous scaled rule tracks the reading', function() {
        const b = createBayes(cfgOf({ rules: [soil()] }));
        const state = { soil: 20 };
        const R = stateOf(state);
        const at = v => { state.soil = v; return b.evaluate(R, 0); };

        assert.ok(at(20).p >= 0.85, 'critically dry should reach the threshold');
        const mid = at(40);
        assert.ok(mid.p > 0.2 && mid.p < 0.85, 'halfway dry is partial evidence');
        assert.ok(Math.abs(at(59).p - 0.2) < 0.05, 'nearly wet contributes almost nothing');
        assert.strictEqual(active(at(70)).length, 0, 'above the condition it is not active at all');
    });

    it('a negative endpoint share pushes the estimate down', function() {
        const wet = { id: 'wet', lr: 1, halfLifeMs: null,
            scale: { fromValue: 60, fromShare: 0, toValue: 100, toShare: -1 },
            steps: [step('is', { thing: 'soil', operator: 'gt', value: '60', valueType: 'num' })] };
        const b = createBayes(cfgOf({ rules: [wet] }));
        assert.ok(b.evaluate(stateOf({ soil: 100 }), 0).p < 0.05);
    });

    it('an unusable reading makes a scaled rule contribute nothing', function() {
        const b = createBayes(cfgOf({ rules: [soil()] }));
        const r = b.evaluate(stateOf({ soil: 'n/a' }), 0);
        assert.strictEqual(active(r).length, 0);
        assert.ok(Math.abs(r.p - 0.2) < 1e-12);
    });

    it('a momentary scaled rule snapshots the weight when it fires, then decays', function() {
        const rule = { id: 'drop', lr: 1, halfLifeMs: 20 * MIN,
            scale: { fromValue: 20, fromShare: 1, toValue: 60, toShare: 0 },
            steps: [step('becomes', { thing: 'soil', operator: 'lt', value: '60', valueType: 'num' })] };
        const b = createBayes(cfgOf({ rules: [rule] }));
        const state = { soil: 20 };                       // dry at the moment it crosses
        b.handleEvent(hit('drop', 0), 20, 0, stateOf(state));
        const atFire = b.evaluate(noState, 0).logOdds - logit(0.2);
        assert.ok(atFire > 3, 'fired at full weight');
        state.soil = 55;                                  // a later reading must not rewrite history
        const later = b.evaluate(noState, 20 * MIN).logOdds - logit(0.2);
        assert.ok(Math.abs(later - atFire / 2) < 1e-9, 'decays from the snapshotted weight');
    });

    it('a scaled rule is never treated as a certain statement', function() {
        // Even at a share that saturates the clamp it must not clear opposing terms.
        const strongSoil = { id: 'soil', lr: 1, halfLifeMs: 20 * MIN,
            scale: { fromValue: 20, fromShare: 3, toValue: 60, toShare: 0 },
            steps: [step('becomes', { thing: 'soil', operator: 'lt', value: '60', valueType: 'num' })] };
        const against = { id: 'sun', lr: 1 / 3, halfLifeMs: 20 * MIN, steps: [step('becomes', { thing: 'sun' })] };
        const b = createBayes(cfgOf({ rules: [strongSoil, against] }));
        b.handleEvent(hit('sun', 0), true, 0, stateOf({ sun: true }));
        b.handleEvent(hit('soil', 0), 20, MIN, stateOf({ soil: 20 }));
        assert.strictEqual(fading(b.evaluate(noState, MIN)).length, 2, 'both terms coexist');
    });

    it('reference irrigation set: dryness can override the sun', function() {
        // Worth pinning the arithmetic: a 100 % share reaches the threshold exactly from the
        // prior, so ANY opposing evidence blocks it. To override the sun (a moderate 'false'
        // rule, −35 %) the dry end has to exceed 100 % by at least that much — hence 150 %.
        const sun = { id: 'sun', lr: 1 / 3, halfLifeMs: null, steps: [step('is', { thing: 'sun' })] };
        const b = createBayes(cfgOf({ rules: [soilAt(1.5), sun] }));
        const state = { soil: 45, sun: true };
        const R = stateOf(state);
        assert.ok(b.evaluate(R, 0).p < 0.85, 'marginally dry plus sun: hold off');
        state.soil = 20;
        assert.ok(b.evaluate(R, 0).p >= 0.85, 'critically dry overrides the sun');
    });

    it('a 100 % share alone exactly reaches the threshold and no further', function() {
        // The boundary that makes the rule above need 150 %: at 100 % the estimate lands on
        // pOn, so it turns on only when nothing opposes it.
        const b = createBayes(cfgOf({ rules: [soilAt(1)] }));
        assert.ok(Math.abs(b.evaluate(stateOf({ soil: 20 }), 0).p - 0.85) < 1e-9);
    });
});

// ---- 14-15. persistence and escape hatches ----------------------------------

describe('persistence and input', function() {
    it('serialize/restore decays by wall clock and keeps lastPositiveAt', function() {
        const a = createBayes(cfgOf({ rules: [arrivalRule('arr', 3)] }));
        a.handleEvent(hit('arr', 0), true, 0);
        a.handleEvent(hit('arr', 0), false, MIN);
        a.handleEvent(hit('arr', 1), true, 2 * MIN);
        a.evaluate(noState, 2 * MIN);
        const saved = a.serialize();
        assert.strictEqual(saved.lastPositiveAt, 2 * MIN);

        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 3)] }));
        b.restore(saved);
        const gain = b.evaluate(noState, 22 * MIN).logOdds - logit(0.2);
        assert.ok(Math.abs(gain - Math.log(3) / 2) < 1e-9);
    });

    it('distinct rules stay distinct — ids must not collide', function() {
        // Regression: rules saved without an id all mapped to the same entry, so only
        // the last one existed and every step hit resolved to it.
        const b = createBayes(cfgOf({ rules: [
            contRule('a', 10, { thing: 'x' }),
            contRule('b', 10, { thing: 'y' })
        ] }));
        const state = { x: true, y: true };
        const r = b.evaluate(stateOf(state), 0);
        assert.strictEqual(active(r).length, 2);
        assert.ok(r.p > 0.9);                      // both contribute, not just one
        state.y = false;
        assert.strictEqual(active(b.evaluate(stateOf(state), 0)).length, 1);
    });

    it('restore starts the maxHold clock when a held-on state has none', function() {
        // A held-on state saved without lastPositiveAt would otherwise leave the
        // safety valve dead forever.
        const mk = () => createBayes(cfgOf({ latch: true, maxHoldMs: 2 * HOUR,
            rules: [contRule('phone', 10, { thing: 'ph' })] }));
        const saved = mk().serialize();
        saved.binary = true;
        delete saved.lastPositiveAt;

        const b = mk();
        b.restore(saved, 100 * HOUR);                       // restore at t=100h
        const resolve = stateOf({ ph: false });             // no supporting evidence
        const early = b.evaluate(resolve, 101 * HOUR);      // 1 h of silence — still held
        assert.strictEqual(early.binary, true);
        assert.strictEqual(early.held, true);
        const late = b.evaluate(resolve, 103 * HOUR);       // 3 h — the valve finally opens
        assert.strictEqual(late.binary, false);
    });

    it('restore drops state belonging to rules that no longer exist', function() {
        const a = createBayes(cfgOf({ rules: [arrivalRule('old', 3), arrivalRule('arr', 3)] }));
        a.handleEvent(hit('old', 0), true, 0);
        a.handleEvent(hit('old', 0), false, MIN);
        a.handleEvent(hit('old', 1), true, 1.5 * MIN);
        a.handleEvent(hit('arr', 0), true, 2 * MIN);        // arm the surviving rule too
        const saved = a.serialize();

        // The node is redeployed with 'old' removed.
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 3)] }));
        b.restore(saved, 2 * MIN);
        const snap = b.serialize();
        assert.deepStrictEqual(Object.keys(snap.fsm), ['arr']);
        assert.ok(Object.keys(snap.lastMatch).every(k => k.startsWith('arr:')));
        assert.ok(Object.keys(snap.lastTrueEdge).every(k => k.startsWith('arr:')));
        assert.strictEqual(snap.terms.length, 0, "the removed rule's term is gone");

        // …but injected evidence survives, having no owning rule.
        const c = createBayes(cfgOf({ rules: [] }));
        c.inject(30, 10 * MIN, 0);
        const d = createBayes(cfgOf({ rules: [] }));
        d.restore(c.serialize(), 0);
        assert.strictEqual(d.serialize().terms.length, 1);
    });

    it('restore tolerates garbage and old shapes', function() {
        const b = createBayes(cfgOf({}));
        for (const junk of [null, undefined, 42, 'x', {}, { terms: 'no', fsm: 3, binary: 'yes' }]) {
            b.restore(junk);
            const r = b.evaluate(noState, 0);
            assert.strictEqual(r.binary, false);
            assert.strictEqual(fading(r).length, 0);
        }
    });

    it('inject adds a decaying term and rejects nonsense; reset returns to the prior', function() {
        const b = createBayes(cfgOf({}));
        assert.strictEqual(b.inject(30, 10 * MIN, 0), true);
        assert.ok(pOf(b, 0) > 0.8);
        assert.ok(pOf(b, 60 * MIN) < pOf(b, 0));
        assert.strictEqual(b.inject(0, null, 0), false);
        assert.strictEqual(b.inject(-3, null, 0), false);
        assert.strictEqual(b.inject(1, null, 0), false);
        b.reset();
        const r = b.evaluate(noState, 0);
        assert.strictEqual(fading(r).length, 0);
        assert.ok(Math.abs(r.p - 0.2) < 1e-12);
    });
});

describe('snapshot report', function() {
    // What output 2 carries. The estimate itself is tested above; this is about whether the
    // report explains it — every rule accounted for, with a status saying why.

    it('lists every configured rule exactly once, whatever its state', function() {
        // The guard that matters: a rule must not fall out of the report because no branch
        // claimed it. Four rules in four different states, four entries.
        const b = createBayes(cfgOf({ rules: [
            contRule('on',  10, { thing: 'a' }),
            contRule('off', 10, { thing: 'b' }),
            arrivalRule('seq', 3),
            { id: 'scaled', lr: 1, halfLifeMs: null, scale: { fromValue: 0, fromShare: 1, toValue: 10, toShare: 0 },
              steps: [step('is', { thing: 'c', operator: 'neq', value: '', valueType: 'str' })] }
        ]}));
        b.handleEvent(hit('seq', 0), true, 0);
        b.handleEvent(hit('seq', 0), false, MIN);          // cycle done → parked on step 2
        const r = b.evaluate(stateOf({ a: true, b: false, c: 'warm' }), MIN);

        assert.strictEqual(r.rules.length, 4);
        assert.deepStrictEqual(r.rules.map(x => x.id), ['on', 'off', 'seq', 'scaled']);
        assert.strictEqual(byId(r, 'on').status, 'contributing');
        assert.strictEqual(byId(r, 'off').status, 'condition-false');
        assert.strictEqual(byId(r, 'seq').status, 'waiting');
        assert.strictEqual(byId(r, 'scaled').status, 'no-value', 'condition holds but the reading is not a number');
    });

    it('reports what a rule reads, so a false condition can be seen rather than inferred', function() {
        const b = createBayes(cfgOf({ rules: [contRule('temp', 10, { thing: 'a', operator: 'gt', value: '25', valueType: 'num' })] }));
        const r = b.evaluate(stateOf({ a: 23.4 }), 0);
        assert.strictEqual(byId(r, 'temp').status, 'condition-false');
        assert.strictEqual(byId(r, 'temp').value, 23.4);
    });

    it('says no-value, without a value, when the source cannot be read at all', function() {
        const b = createBayes(cfgOf({ rules: [contRule('gone', 10, { thing: 'missing' })] }));
        const r = b.evaluate(stateOf({}), 0);
        assert.strictEqual(byId(r, 'gone').status, 'no-value');
        assert.ok(!('value' in byId(r, 'gone')), 'nothing read, so nothing reported');
    });

    it('shares agree with the estimate they explain', function() {
        // Log-odds are additive and a share is just a rescaling of one, so the contributing
        // shares have to sum to the total. If they ever drift the report is lying.
        const b = createBayes(cfgOf({ rules: [
            contRule('a', 10, { thing: 'a' }),
            contRule('b', 3,  { thing: 'b' })
        ]}));
        const r = b.evaluate(stateOf({ a: true, b: true }), 0);
        const sum = active(r).reduce((t, x) => t + x.share, 0);
        assert.ok(Math.abs(sum - r.share) < 0.2, sum + ' vs ' + r.share);
        // 'strong' is the 74 % of the editor's scale.
        assert.ok(Math.abs(byId(r, 'a').share - 73.8) < 0.5);
    });

    it('a rule at 100 % is exactly the one that reaches the threshold alone', function() {
        // The same boundary the editor's summary draws: at 100 % the estimate touches pOn.
        const lr = Math.exp(scale.requiredGain(0.2, 0.85));
        const b = createBayes(cfgOf({ rules: [contRule('alone', lr, { thing: 'a' })] }));
        const r = b.evaluate(stateOf({ a: true }), 0);
        assert.ok(Math.abs(byId(r, 'alone').share - 100) < 0.2);
        assert.ok(Math.abs(r.p - 0.85) < 1e-6);
        assert.strictEqual(r.binary, true);
    });

    it('a momentary rule reads as fading, with its age and half-life', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 10)] }));
        b.handleEvent(hit('arr', 0), true, 0);
        b.handleEvent(hit('arr', 0), false, MIN);
        b.handleEvent(hit('arr', 1), true, 1.5 * MIN);      // fires

        const at = b.evaluate(noState, 1.5 * MIN);
        assert.strictEqual(byId(at, 'arr').status, 'fading');
        assert.strictEqual(byId(at, 'arr').age, 0);
        assert.strictEqual(byId(at, 'arr').halfLife, 20 * 60, 'the node default, in seconds');

        // A half-life later the contribution has halved, and so has the share.
        const later = b.evaluate(noState, 21.5 * MIN);
        assert.strictEqual(byId(later, 'arr').age, 20 * 60);
        assert.ok(Math.abs(byId(later, 'arr').share - byId(at, 'arr').share / 2) < 0.5);
    });

    it('a waiting sequence says where it is and how long it has', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 10)] }));
        b.handleEvent(hit('arr', 0), true, 0);
        b.handleEvent(hit('arr', 0), false, MIN);          // step 1 done, window is 2 min

        const e = byId(b.evaluate(noState, 1.5 * MIN), 'arr');
        assert.strictEqual(e.status, 'waiting');
        assert.strictEqual(e.step, 2);
        assert.strictEqual(e.steps, 2);
        assert.strictEqual(e.deadline, 90, 'seconds left of the 2-minute window');

        // Before anything arms it, the same rule is idle rather than waiting.
        const fresh = createBayes(cfgOf({ rules: [arrivalRule('arr', 10)] }));
        assert.strictEqual(byId(fresh.evaluate(noState, 0), 'arr').status, 'armed');
    });

    it('injected evidence gets its own entry and leaves when it decays', function() {
        const b = createBayes(cfgOf({ rules: [contRule('a', 10, { thing: 'a' })] }));
        b.inject(30, 10 * MIN, 0);
        const r = b.evaluate(stateOf({ a: false }), 0);
        assert.strictEqual(r.rules.length, 2, 'the configured rule plus the injection');
        assert.strictEqual(byId(r, 'injected').status, 'injected');
        assert.ok(byId(r, 'injected').share > 0);

        // Once pruned it is gone from the report, not left at zero.
        b.tick(3 * HOUR, noState);
        const after = b.evaluate(stateOf({ a: false }), 3 * HOUR);
        assert.strictEqual(after.rules.length, 1);
        assert.strictEqual(byId(after, 'injected'), undefined);
    });

    it('carries the label the node attached, falling back to the id', function() {
        const b = createBayes(cfgOf({ rules: [
            Object.assign(contRule('a', 10, { thing: 'a' }), { label: 'While Kontor · Temperature is true' }),
            contRule('b', 10, { thing: 'b' })
        ]}));
        const r = b.evaluate(stateOf({ a: true, b: true }), 0);
        assert.strictEqual(byId(r, 'a').label, 'While Kontor · Temperature is true');
        assert.strictEqual(byId(r, 'b').label, 'b', 'unlabelled rules stay identifiable');
    });
});

describe('multi-condition rules', function() {
    // A rule made only of level checks is one weight with several conditions, not a sequence.
    // Before this it fell through to the sequence machinery and could never fire: a condition
    // is not an event, so nothing ever drove the first step forward.
    const twoConditions = () => ({ id: 'and', lr: 10, halfLifeMs: null, steps: [
        step('is', { thing: 'a', operator: 'gt', value: '100', valueType: 'num' }),
        step('is', { thing: 'b' })
    ]});

    it('holds its weight only while every condition holds at once', function() {
        const b = createBayes(cfgOf({ rules: [twoConditions()] }));
        const state = { a: 150, b: true };
        const R = stateOf(state);

        assert.strictEqual(active(b.evaluate(R, 0)).length, 1, 'both hold');
        state.b = false;
        assert.strictEqual(active(b.evaluate(R, MIN)).length, 0, 'second condition dropped');
        state.b = true; state.a = 50;
        assert.strictEqual(active(b.evaluate(R, 2 * MIN)).length, 0, 'first condition dropped');
        state.a = 150;
        assert.strictEqual(active(b.evaluate(R, 3 * MIN)).length, 1, 'both hold again');
    });

    it('names the condition that failed', function() {
        // With one condition "condition-false" is enough; with several, which one is the
        // whole question.
        const b = createBayes(cfgOf({ rules: [twoConditions()] }));
        const e = byId(b.evaluate(stateOf({ a: 150, b: false }), 0), 'and');
        assert.strictEqual(e.status, 'condition-false');
        assert.strictEqual(e.failedStep, 2);
        assert.strictEqual(byId(b.evaluate(stateOf({ a: 50, b: true }), 0), 'and').failedStep, 1);
    });

    it('reports the reading of the step that failed, not of the first one', function() {
        // The bug this replaces: `value` is always step 1's, and the status was read off it
        // too. A rule whose second step had nothing to read was reported as condition-false
        // with step 1's perfectly good value beside it — two fields describing two steps,
        // with nothing saying so.
        const b = createBayes(cfgOf({ rules: [twoConditions()] }));
        const e = byId(b.evaluate(stateOf({ a: 150, b: false }), 0), 'and');
        assert.strictEqual(e.failedStep, 2);
        assert.strictEqual(e.failedValue, false, 'step 2 read false');
        assert.strictEqual(e.value, 150, 'value still describes step 1');
    });

    it('separates nothing to read from read it and it was false', function() {
        // Both land on the failing step, so a source that is not reporting says so even when
        // it is the second condition. Reading the status off step 1 called this
        // condition-false, which is the one thing it was not.
        const b = createBayes(cfgOf({ rules: [twoConditions()] }));

        const missing = byId(b.evaluate(stateOf({ a: 150 }), 0), 'and');
        assert.strictEqual(missing.status, 'no-value', 'step 2 had nothing to read');
        assert.strictEqual(missing.failedStep, 2);
        assert.ok(!('failedValue' in missing), 'no reading to report');

        const read = byId(b.evaluate(stateOf({ a: 150, b: false }), 0), 'and');
        assert.strictEqual(read.status, 'condition-false', 'step 2 read false');

        // Step 1 unreadable still reports no-value, as it always has.
        const first = byId(b.evaluate(stateOf({ b: true }), 0), 'and');
        assert.strictEqual(first.status, 'no-value');
    });

    it('contributes nothing before it holds, and applies its full weight when it does', function() {
        const b = createBayes(cfgOf({ rules: [twoConditions()] }));
        assert.ok(Math.abs(b.evaluate(stateOf({ a: 50, b: true }), 0).p - 0.2) < 1e-12);
        const on = b.evaluate(stateOf({ a: 150, b: true }), 0);
        assert.ok(Math.abs(byId(on, 'and').share - 73.8) < 0.5, 'one strong weight, not two');
    });

    it('accepts isOrBecomes as a condition — it has nothing to wait for here', function() {
        // The live rule that prompted this: a time window plus a level, the second saved as
        // "now or soon" from when it was written as a sequence.
        const b = createBayes(cfgOf({ rules: [{ id: 'r', lr: 10, halfLifeMs: null, steps: [
            step('is', { thing: 'a' }),
            step('isOrBecomes', { thing: 'b' })
        ]}]}));
        assert.strictEqual(active(b.evaluate(stateOf({ a: true, b: true }), 0)).length, 1);
        assert.strictEqual(active(b.evaluate(stateOf({ a: true, b: false }), 0)).length, 0);
    });

    it('does not drive the sequence machinery', function() {
        // handleEvent must leave an all-condition rule alone; an FSM entry for it would be
        // state that nothing ever clears.
        const b = createBayes(cfgOf({ rules: [twoConditions()] }));
        b.handleEvent(hit('and', 0), true, 0);
        assert.deepStrictEqual(b.serialize().fsm, {});
    });

    it('reports a rule that opens with a condition but waits for an event as never-fires', function() {
        // Still unreachable, and now it says so instead of sitting at "armed" looking idle.
        const b = createBayes(cfgOf({ rules: [{ id: 'dead', lr: 10, halfLifeMs: null, steps: [
            step('is', { thing: 'a' }),
            step('becomes', { thing: 'b' })
        ]}]}));
        const e = byId(b.evaluate(stateOf({ a: true, b: true }), 0), 'dead');
        assert.strictEqual(e.status, 'never-fires');
        assert.strictEqual(e.share, 0);

        // A sequence that opens with an event is fine and stays armed.
        const ok = createBayes(cfgOf({ rules: [arrivalRule('arr', 10)] }));
        assert.strictEqual(byId(ok.evaluate(noState, 0), 'arr').status, 'armed');
    });
});

describe('unusable operator and value pairings', function() {
    // The editor now offers only 're' for a regex comparison, but a rule saved before that
    // can pair it with a plain string — and COMPARE.regex calls b.test, which a string does
    // not have. One bad rule must not take the whole evaluation down with it.
    it('a regex operator against a string value does not throw', function() {
        const b = createBayes(cfgOf({ rules: [
            { id: 'bad', lr: 3, halfLifeMs: null,
              steps: [step('is', { thing: 'a', operator: 'regex', value: '^on$', valueType: 'str' })] },
            { id: 'good', lr: 10, halfLifeMs: null, steps: [step('is', { thing: 'b' })] }
        ]}));
        const r = b.evaluate(stateOf({ a: 'on', b: true }), 0);
        assert.strictEqual(byId(r, 'bad').status, 'condition-false', 'unevaluable is not a match');
        assert.strictEqual(byId(r, 'good').status, 'contributing', 'and the other rules still run');
    });

    it('a regex operator against a real regex still matches', function() {
        const b = createBayes(cfgOf({ rules: [
            { id: 'r', lr: 10, halfLifeMs: null,
              steps: [step('is', { thing: 'a', operator: 'regex', value: '^on$', valueType: 're' })] }
        ]}));
        assert.strictEqual(byId(b.evaluate(stateOf({ a: 'on' }), 0), 'r').status, 'contributing');
        assert.strictEqual(byId(b.evaluate(stateOf({ a: 'off' }), 0), 'r').status, 'condition-false');
    });

    it('an unparseable value leaves the rule inactive rather than throwing', function() {
        const b = createBayes(cfgOf({ rules: [
            { id: 'j', lr: 3, halfLifeMs: null,
              steps: [step('is', { thing: 'a', operator: 'eq', value: '{not json', valueType: 'json' })] }
        ]}));
        assert.strictEqual(byId(b.evaluate(stateOf({ a: 'x' }), 0), 'j').status, 'condition-false');
    });
});

describe('a prior above the on-threshold', function() {
    // "Assume the house is quiet until something says otherwise": the node rests on and rules
    // push it off. The estimate always handled this; what did not was every report of it,
    // because requiredGain came out negative and two negatives divide positive — so a rule
    // pushing the output down was described as pushing it up.
    const P = { prior: 0.93, pOn: 0.80, pOff: 0.35, clamp: 6 };
    const veto = (id, strength) => ({ id, lr: 1 / scale.strengthLr(strength), halfLifeMs: null,
                                      steps: [step('is', { thing: id })] });
    const make = rules => createBayes(cfgOf(Object.assign({}, P, { rules })));

    it('measures the way to off, since that is the way it can move', function() {
        const gain = scale.requiredGain(P.prior, P.pOn, P.pOff);
        assert.ok(gain < 0, 'the reachable threshold is below the prior');
        assert.strictEqual(scale.restsOn(P.prior, P.pOn), true);

        // One decisive veto is just enough — which is what the estimate does too.
        const share = scale.shareOfWay(1 / scale.strengthLr('decisive'), P.prior, P.pOn, P.clamp, P.pOff);
        assert.ok(Math.abs(share - 1.06) < 0.02, share);
    });

    it('reports a rule that pushes the output down as a positive share', function() {
        // The bug as reported: decisive-false read as +283 % of the way to ON.
        const b = make([veto('motion', 'decisive')]);
        const r = b.evaluate(stateOf({ motion: true }), 0);
        assert.strictEqual(r.binary, false, 'the estimate was always right');
        assert.ok(Math.abs(byId(r, 'motion').share - 106) < 1, byId(r, 'motion').share);
    });

    it('keeps shares additive against the one denominator', function() {
        const b = make([veto('tv', 'slight'), veto('motion', 'decisive')]);
        const r = b.evaluate(stateOf({ tv: true, motion: true }), 0);
        const sum = active(r).reduce((t, x) => t + x.share, 0);
        assert.ok(Math.abs(sum - r.share) < 0.2, sum + ' vs ' + r.share);
    });

    it('rests on and is pushed off, not the other way round', function() {
        const b = make([veto('tv', 'slight'), veto('motion', 'decisive')]);
        assert.strictEqual(b.evaluate(stateOf({}), 0).binary, true, 'silence reads as on');
        assert.strictEqual(b.evaluate(stateOf({ tv: true }), MIN).binary, true, 'a slight veto is not enough');
        assert.strictEqual(b.evaluate(stateOf({ motion: true }), 2 * MIN).binary, false, 'a decisive one is');
        assert.strictEqual(b.evaluate(stateOf({}), 3 * MIN).binary, true, 'and it comes back');
    });

    it('leaves an ordinary configuration exactly as it was', function() {
        // The fix must not move the normal case: prior below the threshold still measures up.
        assert.strictEqual(scale.restsOn(0.2, 0.85), false);
        const withOff = scale.shareOfWay(10, 0.2, 0.85, 6, 0.30);
        const without = scale.shareOfWay(10, 0.2, 0.85, 6);
        assert.strictEqual(withOff, without);
        assert.ok(Math.abs(withOff - 0.7378) < 1e-3);
    });
});

describe('a condition that must have held', function() {
    // "Up for ten minutes" rather than "up right now" — what separates a bathroom trip from
    // getting up for the day. It is a property of time, not of the reading, so it cannot be
    // decided by the condition alone.
    const heldRule = (id, lr, holdMs) => ({ id, lr, halfLifeMs: null,
        steps: [step('held', { thing: id, holdMs: holdMs })] });
    const TEN = 10 * MIN;

    it('does not count until the condition has held long enough', function() {
        const b = createBayes(cfgOf({ rules: [heldRule('up', 10, TEN)] }));
        const R = stateOf({ up: true });

        assert.strictEqual(active(b.evaluate(R, 0)).length, 0, 'just became true');
        assert.strictEqual(active(b.evaluate(R, 5 * MIN)).length, 0, 'halfway');
        assert.strictEqual(active(b.evaluate(R, TEN)).length, 1, 'exactly at the limit');
        assert.strictEqual(active(b.evaluate(R, 30 * MIN)).length, 1, 'and stays');
    });

    it('starts over when the condition drops', function() {
        // The bathroom trip: up, back to bed, up again — the clock restarts each time, so a
        // string of short absences never adds up to a long one.
        const b = createBayes(cfgOf({ rules: [heldRule('up', 10, TEN)] }));
        const state = { up: true };
        const R = stateOf(state);
        b.evaluate(R, 0);
        b.handleEvent(hit('up', 0), true, 0);

        state.up = false;
        b.handleEvent(hit('up', 0), false, 8 * MIN);
        assert.strictEqual(active(b.evaluate(R, 8 * MIN)).length, 0);

        state.up = true;
        b.handleEvent(hit('up', 0), true, 9 * MIN);
        assert.strictEqual(active(b.evaluate(R, 17 * MIN)).length, 0,
            '8 minutes then 8 more is not 10 in a row');
        assert.strictEqual(active(b.evaluate(R, 19 * MIN)).length, 1, 'ten from the restart');
    });

    it('starts the clock when it first sees the condition true', function() {
        // True while the node was down, or true at the very first evaluation: a hold that has
        // not been observed has not been observed, so it counts from now rather than forever.
        const b = createBayes(cfgOf({ rules: [heldRule('up', 10, TEN)] }));
        const R = stateOf({ up: true });
        assert.strictEqual(active(b.evaluate(R, 1000 * MIN)).length, 0, 'not credited on sight');
        assert.strictEqual(active(b.evaluate(R, 1010 * MIN)).length, 1, 'ten minutes later');
    });

    it('is not satisfied by the edge when it follows an earlier step', function() {
        // The path every hold step in a sequence actually takes: the step is armed by the one
        // before it, and the condition turns true afterwards. driveFsm completed it on that
        // rising edge, the way it completes a 'becomes' — so the hold duration was ignored
        // exactly when it was the only thing being asked for, and a blip fired the rule.
        const b = createBayes(cfgOf({ rules: [{ id: 'r', lr: 400, halfLifeMs: null, steps: [
            step('becomes', { thing: 'door' }),
            step('held', { thing: 'phone', operator: 'false', holdMs: 2 * MIN, windowMs: 15 * MIN })
        ]}]}));
        const state = { door: false, phone: true };
        const R = stateOf(state);

        state.door = true;
        b.handleEvent([{ ruleId: 'r', stepIndex: 0 }], true, 0, R);

        state.phone = false;
        assert.deepStrictEqual(
            b.handleEvent([{ ruleId: 'r', stepIndex: 1 }], false, 10e3, R), [],
            'the edge alone does not fire it');

        b.tick(60e3, R);
        assert.strictEqual(fading(b.evaluate(R, 60e3)).length, 0, 'still short of the hold');

        b.tick(131e3, R);
        assert.strictEqual(fading(b.evaluate(R, 131e3)).length, 1, 'fires once 2 min have passed');
    });

    it('restarts its clock in a sequence when the condition drops', function() {
        // A blip is what the hold exists to reject, so a condition that goes true, falls back
        // and returns must serve the whole duration from the second edge.
        const b = createBayes(cfgOf({ rules: [{ id: 'r', lr: 400, halfLifeMs: null, steps: [
            step('becomes', { thing: 'door' }),
            step('held', { thing: 'phone', operator: 'false', holdMs: 2 * MIN, windowMs: 15 * MIN })
        ]}]}));
        const state = { door: false, phone: true };
        const R = stateOf(state);

        state.door = true;
        b.handleEvent([{ ruleId: 'r', stepIndex: 0 }], true, 0, R);

        state.phone = false;                                            // blip starts
        b.handleEvent([{ ruleId: 'r', stepIndex: 1 }], false, 10e3, R);
        state.phone = true;                                             // ... and ends
        b.handleEvent([{ ruleId: 'r', stepIndex: 1 }], true, 16e3, R);
        b.tick(140e3, R);
        assert.strictEqual(fading(b.evaluate(R, 140e3)).length, 0,
            'the blip does not count, even 2 min after it started');

        state.phone = false;                                            // the real one
        b.handleEvent([{ ruleId: 'r', stepIndex: 1 }], false, 150e3, R);
        b.tick(271e3, R);
        assert.strictEqual(fading(b.evaluate(R, 271e3)).length, 1, 'held from the second edge');
    });

    it('makes a rule of held steps continuous, not a sequence', function() {
        // Otherwise it would go to the sequence machinery and never fire — a condition is not
        // an event, whether or not it has to last.
        const b = createBayes(cfgOf({ rules: [{ id: 'r', lr: 10, halfLifeMs: null, steps: [
            step('held', { thing: 'a', holdMs: TEN }),
            step('is',   { thing: 'b' })
        ]}]}));
        const R = stateOf({ a: true, b: true });
        assert.strictEqual(byId(b.evaluate(R, 0), 'r').status, 'condition-false', 'a has not held yet');
        assert.strictEqual(byId(b.evaluate(R, TEN), 'r').status, 'contributing');
        assert.strictEqual(byId(b.evaluate(stateOf({ a: true, b: false }), TEN), 'r').status,
            'condition-false', 'still an AND');
    });

    it('a zero duration behaves exactly like an ordinary condition', function() {
        const b = createBayes(cfgOf({ rules: [heldRule('up', 10, 0)] }));
        assert.strictEqual(active(b.evaluate(stateOf({ up: true }), 0)).length, 1);
        assert.strictEqual(active(b.evaluate(stateOf({ up: false }), MIN)).length, 0);
    });

    it('survives a restart with the hold intact', function() {
        // The edge is persisted with the rest of the state, so a deploy does not reset a
        // condition that has genuinely been true for an hour.
        const a = createBayes(cfgOf({ rules: [heldRule('up', 10, TEN)] }));
        a.handleEvent(hit('up', 0), true, 0);
        const saved = a.serialize();

        const b = createBayes(cfgOf({ rules: [heldRule('up', 10, TEN)] }));
        b.restore(saved, 20 * MIN);
        assert.strictEqual(active(b.evaluate(stateOf({ up: true }), 20 * MIN)).length, 1,
            'twenty minutes of holding survived the restart');
    });
});

describe('comparing one source against another', function() {
    // Both sides read in the same pass, so they cannot disagree because one was stored
    // earlier — the staleness that a flow variable between them invites.
    const cmpRule = (id, lr, cmp) => ({ id, lr, halfLifeMs: null, steps: [
        step('is', { thing: 'a', operator: 'gt', valueType: 'state', value: '', cmp: cmp })
    ]});
    const OTHER = { src: 'thing', thing: 'b', item: 'b' };

    it('compares against the other source as it reads right now', function() {
        const b = createBayes(cfgOf({ rules: [cmpRule('r', 10, OTHER)] }));
        const state = { a: 25, b: 20 };
        const R = stateOf(state);

        assert.strictEqual(active(b.evaluate(R, 0)).length, 1, '25 > 20');
        state.b = 30;
        assert.strictEqual(active(b.evaluate(R, MIN)).length, 0, 'the other side moved past it');
        state.b = 10;
        assert.strictEqual(active(b.evaluate(R, 2 * MIN)).length, 1, 'and back');
    });

    it('follows a change on either side within the same evaluation', function() {
        // Nothing is stored between them, so there is no window where the two disagree.
        const b = createBayes(cfgOf({ rules: [cmpRule('r', 10, OTHER)] }));
        const state = { a: 25, b: 20 };
        const R = stateOf(state);
        assert.strictEqual(active(b.evaluate(R, 0)).length, 1);
        state.a = 15;
        assert.strictEqual(active(b.evaluate(R, MIN)).length, 0, 'left side moved');
    });

    it('does not match when the comparison source cannot be read', function() {
        const b = createBayes(cfgOf({ rules: [
            cmpRule('bad', 10, { src: 'thing', thing: 'gone', item: 'gone' }),
            contRule('good', 10, { thing: 'c' })
        ]}));
        const r = b.evaluate(stateOf({ a: 25, c: true }), 0);
        assert.strictEqual(byId(r, 'bad').status, 'condition-false', 'nothing to compare against');
        assert.strictEqual(byId(r, 'good').status, 'contributing', 'and the neighbours still run');
    });

    it('does not match — and does not throw — with no resolver available', function() {
        // completeStep advances a sequence on an edge alone and passes no resolver. A state
        // comparison cannot be evaluated there, and one unevaluable step must not take the
        // whole evaluation with it.
        const b = createBayes(cfgOf({ rules: [cmpRule('r', 10, OTHER)] }));
        assert.doesNotThrow(function() { b.evaluate(function() { return 25; }, 0); });
        const missingSpec = createBayes(cfgOf({ rules: [cmpRule('r', 10, null)] }));
        assert.strictEqual(active(missingSpec.evaluate(stateOf({ a: 25 }), 0)).length, 0);
    });

    it('leaves the ordinary value types alone', function() {
        const b = createBayes(cfgOf({ rules: [
            { id: 'num', lr: 10, halfLifeMs: null,
              steps: [step('is', { thing: 'a', operator: 'gt', value: '20', valueType: 'num' })] }
        ]}));
        assert.strictEqual(active(b.evaluate(stateOf({ a: 25 }), 0)).length, 1);
        assert.strictEqual(active(b.evaluate(stateOf({ a: 15 }), MIN)).length, 0);
    });
});

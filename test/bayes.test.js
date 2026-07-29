'use strict';
const assert = require('node:assert');
const { createBayes, logit, sigmoid } = require('../lib/bayes');
const scale = require('../resources/bayes-scale');

const MIN = 60e3;
const HOUR = 60 * MIN;

// ---- helpers ----------------------------------------------------------------

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
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.length, 1);
        // Exit (certain false) fires — the positive term is cleared, not fought.
        b.handleEvent(hit('exit', 0), true, 3 * MIN);
        b.handleEvent(hit('exit', 0), false, 4 * MIN);
        b.handleEvent(hit('exit', 1), true, 4.5 * MIN);
        const r = b.evaluate(noState, 5 * MIN);
        assert.deepStrictEqual(r.terms.map(t => t.ruleId), ['exit']);
        assert.ok(r.p < 0.05);
    });

    it('any opposing firing clears a stored certain term (return home is not blocked)', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 3), arrivalRule('exit', 1 / 400)] }));
        // Exit fired earlier — a certain false statement.
        b.handleEvent(hit('exit', 0), true, 0);
        b.handleEvent(hit('exit', 0), false, MIN);
        b.handleEvent(hit('exit', 1), true, 1.5 * MIN);
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.length, 1);
        // Coming back: a mere moderate arrival invalidates the certain statement.
        b.handleEvent(hit('arr', 0), true, 10 * MIN);
        b.handleEvent(hit('arr', 0), false, 11 * MIN);
        b.handleEvent(hit('arr', 1), true, 11.5 * MIN);
        const r = b.evaluate(noState, 12 * MIN);
        assert.deepStrictEqual(r.terms.map(t => t.ruleId), ['arr']);
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
        assert.strictEqual(b.evaluate(noState, 5 * MIN).terms.length, 2);
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
        assert.strictEqual(b.evaluate(noState, 40 * MIN).terms.length, 0);
    });
});

// ---- 6-10. step sequences ---------------------------------------------------

describe('step sequences', function() {
    it('valid cycle plus an edge inside the window fires; too slow a cycle does not', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        b.handleEvent(hit('arr', 0), true, 0);
        b.handleEvent(hit('arr', 0), false, MIN);            // cycle ok (≤ 3 min)
        b.handleEvent(hit('arr', 1), true, 2 * MIN);          // within 2 min window
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.length, 1);

        const slow = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        slow.handleEvent(hit('arr', 0), true, 0);
        slow.handleEvent(hit('arr', 0), false, 4 * MIN);      // > cycleMax
        slow.handleEvent(hit('arr', 1), true, 4.5 * MIN);
        assert.strictEqual(slow.evaluate(noState, 5 * MIN).terms.length, 0);
    });

    it('overlap: an edge during the previous step counts at its completion', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        b.handleEvent(hit('arr', 0), true, 0);                // door opens
        b.handleEvent(hit('arr', 1), true, 0.5 * MIN);        // motion while open
        b.handleEvent(hit('arr', 0), false, MIN);             // door closes — fires here
        assert.strictEqual(b.evaluate(noState, MIN).terms.length, 1);
    });

    it('an edge before arming never counts', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        b.handleEvent(hit('arr', 1), true, 0);                // motion before the door ever opens
        b.handleEvent(hit('arr', 0), true, 5 * MIN);
        b.handleEvent(hit('arr', 0), false, 6 * MIN);
        assert.strictEqual(b.evaluate(noState, 6 * MIN).terms.length, 0);
        // …but fresh motion within the window still confirms
        b.handleEvent(hit('arr', 1), false, 6.5 * MIN);
        b.handleEvent(hit('arr', 1), true, 7 * MIN);
        assert.strictEqual(b.evaluate(noState, 7 * MIN).terms.length, 1);
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
        assert.strictEqual(b.evaluate(noState, 3 * MIN).terms.length, 1);

        const wrong = createBayes(cfgOf({ rules: [rule] }));
        wrong.handleEvent(hit('r3', 1), true, 0);             // door first — ignored at step 0
        wrong.handleEvent(hit('r3', 1), false, MIN);
        wrong.handleEvent(hit('r3', 2), true, 1.5 * MIN);
        assert.strictEqual(wrong.evaluate(noState, 2 * MIN).terms.length, 0);
    });

    it('timeout between steps resets the sequence; tick also cleans up', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        b.handleEvent(hit('arr', 0), true, 0);
        b.handleEvent(hit('arr', 0), false, MIN);             // pending, window 2 min
        b.handleEvent(hit('arr', 1), true, 5 * MIN);          // too late
        assert.strictEqual(b.evaluate(noState, 5 * MIN).terms.length, 0);

        const t = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        t.handleEvent(hit('arr', 0), true, 0);                // door opens, never closes
        t.tick(10 * MIN);                                     // stale opening dropped
        t.handleEvent(hit('arr', 0), false, 10.5 * MIN);      // close without tracked open
        t.handleEvent(hit('arr', 1), true, 11 * MIN);
        assert.strictEqual(t.evaluate(noState, 11 * MIN).terms.length, 0);
    });

    it('no rising edge on step 0 means nothing ever arms (exit protection)', function() {
        const b = createBayes(cfgOf({ rules: [{ id: 'r', lr: 30, halfLifeMs: null, steps: [
            step('becomes', { thing: 'phone' }), step('becomes', { thing: 'motion' })
        ] }] }));
        // Phone goes true→false is a falling edge on "is true" — never arms.
        b.handleEvent(hit('r', 0), false, 0);
        b.handleEvent(hit('r', 1), true, MIN);
        assert.strictEqual(b.evaluate(noState, MIN).terms.length, 0);
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
        assert.strictEqual(b.evaluate(noState, 61 * MIN).terms.length, 1);
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
        assert.strictEqual(b.evaluate(noState, MIN).terms.length, 0);
        // …and the sequence is reset, so the next real cycle still works.
        state.phone = true;
        b.handleEvent(hit('arr', 0), true, 10 * MIN, stateOf(state));
        b.handleEvent(hit('arr', 0), false, 11 * MIN, stateOf(state));
        assert.strictEqual(b.evaluate(noState, 11 * MIN).terms.length, 1);
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
        assert.strictEqual(b.evaluate(noState, MIN).terms.length, 1);
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
        assert.strictEqual(b.evaluate(noState, MIN).terms.length, 0);   // pending, not aborted

        state.phone = true;
        b.handleEvent(hit('arr', 1), true, 2 * MIN, stateOf(state));    // arrives inside the window
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.length, 1);
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
        assert.strictEqual(b.evaluate(noState, 10 * MIN).terms.length, 0);
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
        assert.strictEqual(b.evaluate(noState, MIN).terms.length, 0);

        state.flowvar = true;                                         // changes with no event
        b.tick(3 * MIN, stateOf(state));
        assert.strictEqual(b.evaluate(noState, 3 * MIN).terms.length, 1);
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
        assert.strictEqual(b.evaluate(noState, 11 * MIN).terms.length, 0);
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
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.length, 1);
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
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.length, 0);
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
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.length, 1);
    });

    it('repeated identical reports count once (edge dedupe)', function() {
        const b = createBayes(cfgOf({ rules: [arrivalRule('arr', 30)] }));
        b.handleEvent(hit('arr', 0), true, 0);
        b.handleEvent(hit('arr', 0), true, 10);               // repeat — no new edge
        b.handleEvent(hit('arr', 0), false, MIN);
        b.handleEvent(hit('arr', 1), true, 1.5 * MIN);
        b.handleEvent(hit('arr', 1), true, 1.6 * MIN);        // repeat
        assert.strictEqual(b.evaluate(noState, 2 * MIN).terms.length, 1);
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
        assert.strictEqual(r.activeRules.length, 2);
        assert.ok(r.p > 0.9);                      // both contribute, not just one
        state.y = false;
        assert.strictEqual(b.evaluate(stateOf(state), 0).activeRules.length, 1);
    });

    it('restore tolerates garbage and old shapes', function() {
        const b = createBayes(cfgOf({}));
        for (const junk of [null, undefined, 42, 'x', {}, { terms: 'no', fsm: 3, binary: 'yes' }]) {
            b.restore(junk);
            const r = b.evaluate(noState, 0);
            assert.strictEqual(r.binary, false);
            assert.strictEqual(r.terms.length, 0);
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
        assert.strictEqual(r.terms.length, 0);
        assert.ok(Math.abs(r.p - 0.2) < 1e-12);
    });
});

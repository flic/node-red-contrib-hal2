'use strict';
// Pure Bayesian binary-state estimator for hal2Bayes. No Node-RED, no Date.now() —
// every method takes `now` (ms epoch) so tests control the clock.
//
// The model is a set of RULES. A rule with one step of pattern 'becomes' is
// CONTINUOUS: it contributes ln(LR) while its condition holds, recomputed at every
// evaluation and never stored. Any other rule (a single 'cycle' step, or two or
// more steps in time order) is MOMENTARY: completing its step sequence fires a
// one-shot term that then decays toward zero with a half-life.
//
//   L(now) = clamp±C( logit(prior)
//                   + Σ continuous rules whose condition holds:  ln(LR)
//                   + Σ live momentary terms:                    ln(LR) · 2^(−(now−ts)/halfLife) )
//   P = sigmoid(L), with hysteresis (on at ≥ pOn, off at ≤ pOff).
//
// Direction is encoded in the effective LR (LR < 1 pushes toward false). An LR
// whose |ln| saturates the clamp is a "certain" statement rather than accumulating
// evidence: when a certain rule fires it clears opposing stored terms, and a
// certain stored term is cleared by ANY opposing rule firing — statements do not
// linger against contradiction.
//
// Step sequences run as small per-rule state machines. 'becomes' completes on the
// condition's rising edge; 'cycle' needs the condition to go true then false
// within cycleMax (a door opening and closing). Each later step must complete
// within `window` of the previous one — but an edge that already occurred since
// the sequence armed also counts (the overlap rule: motion while the door stood
// open is accepted when the door closes).
//
// The latch: with cfg.latch set, silence cannot turn the output off — decay and
// dropped-out sensors leave it on (reported as held:true) until an actual
// false-direction rule is active, or maxHoldMs passes without positive evidence.

const { CONVERTERS, COMPARE } = require('./rules');
const { strengthLr } = require('../resources/bayes-scale');

const logit   = p => Math.log(p / (1 - p));
const sigmoid = x => 1 / (1 + Math.exp(-x));

const PRUNE_BELOW = 0.01;                        // drop momentary terms once |contribution| decays under this
const CERTAIN_LN  = Math.log(strengthLr('certain'));   // |ln LR| at or above this is a "statement"

function createBayes(cfg) {
    // cfg: fully normalized — times in ms, numbers as numbers.
    // { prior, pOn, pOff, clamp, halfLifeMs, latch, maxHoldMs (0 = never),
    //   rules: [{ id, lr (direction applied), halfLifeMs,
    //             steps: [{ operator, value, valueType, pattern: 'becomes'|'cycle',
    //                       cycleMaxMs, windowMs, thing, item }] }] }

    const priorLogit = logit(cfg.prior);
    const clampC     = cfg.clamp;
    const clampLn    = x => Math.max(-clampC, Math.min(clampC, x));
    // "Certain" = at or beyond the certain strength (LR 400), or the clamp if the
    // user lowered it below that.
    const certainLn  = Math.min(clampC, CERTAIN_LN) - 1e-9;
    const isCertain  = lr => Math.abs(Math.log(lr)) >= certainLn;

    const ruleById = new Map(cfg.rules.map(r => [r.id, r]));
    const isContinuous = r => r.steps.length === 1 && r.steps[0].pattern === 'becomes';

    const stepKey = (ruleId, i) => ruleId + ':' + i;

    // ---- mutable estimator state (everything serialize() persists) ----
    let S = freshState();

    function freshState() {
        return {
            terms: [],          // [{ ruleId, l0, ts, halfLifeMs }] — momentary/injected
            lastMatch: {},      // stepKey → last condition result (edge detection)
            lastTrueEdge: {},   // stepKey → ts of last rising edge (overlap rule)
            fsm: {},            // ruleId → { stepIndex, armedAt, deadline, openAt }
            binary: false,
            lastP: cfg.prior,
            lastPositiveAt: null
        };
    }

    function conditionMatches(step, raw) {
        const cmp = COMPARE[step.operator];
        if (!cmp) { return false; }
        if (step.operator === 'true' || step.operator === 'false') { return cmp(raw); }
        let b;
        try { b = CONVERTERS[step.valueType || 'str'](step.value); }
        catch (e) { return false; }
        return cmp(raw, b);
    }

    function fsmFor(ruleId) {
        if (!S.fsm[ruleId]) { S.fsm[ruleId] = { stepIndex: 0, armedAt: null, deadline: null, openAt: null }; }
        return S.fsm[ruleId];
    }

    function resetFsm(ruleId) {
        S.fsm[ruleId] = { stepIndex: 0, armedAt: null, deadline: null, openAt: null };
    }

    // Fire a momentary rule: add its term, applying the certainty rules.
    function fire(rule, now) {
        const l0 = clampLn(Math.log(rule.lr));
        if (l0 === 0) { return false; }
        const sign = Math.sign(l0);
        S.terms = S.terms.filter(t => {
            if (Math.sign(t.l0) === sign) { return true; }        // same direction — keep
            if (isCertain(rule.lr)) { return false; }             // certain overrides history
            return Math.abs(t.l0) < certainLn;                    // contradiction clears certain terms
        });
        S.terms.push({ ruleId: rule.id, l0, ts: now, halfLifeMs: rule.halfLifeMs || cfg.halfLifeMs });
        return true;
    }

    // Complete the FSM's current step at `doneAt`, advancing or firing, then cascade
    // through following 'becomes' steps already satisfied by an edge since arming.
    function completeStep(rule, f, doneAt, fired) {
        if (f.stepIndex >= rule.steps.length - 1) {
            if (fire(rule, doneAt)) { fired.push(rule.id); }
            resetFsm(rule.id);
            return;
        }
        f.stepIndex += 1;
        f.deadline = doneAt + (rule.steps[f.stepIndex].windowMs || 0);
        f.openAt = null;

        const next = rule.steps[f.stepIndex];
        if (next.pattern === 'becomes') {
            const edge = S.lastTrueEdge[stepKey(rule.id, f.stepIndex)];
            if (edge !== undefined && f.armedAt !== null && edge >= f.armedAt) {
                completeStep(rule, f, doneAt, fired);   // overlap: already satisfied
            }
        }
    }

    function driveFsm(rule, s, isRising, isFalling, now, fired) {
        const f = fsmFor(rule.id);

        // Time out an expired window before considering the event.
        if (f.stepIndex > 0 && f.deadline !== null && now > f.deadline) { resetFsm(rule.id); }

        if (s !== S.fsm[rule.id].stepIndex) { return; }   // not the step we are waiting for
        const fsm = S.fsm[rule.id];
        const step = rule.steps[s];

        if (step.pattern === 'cycle') {
            if (isRising) {
                fsm.openAt = now;
                if (s === 0) { fsm.armedAt = now; }
            } else if (isFalling && fsm.openAt !== null) {
                const ok = (now - fsm.openAt) <= (step.cycleMaxMs || Infinity);
                fsm.openAt = null;
                if (ok) { completeStep(rule, fsm, now, fired); }
                else if (s === 0) { fsm.armedAt = null; }
            }
        } else if (isRising) { // 'becomes'
            if (s === 0) { fsm.armedAt = now; }
            completeStep(rule, fsm, now, fired);
        }
    }

    return {
        // A sensor value arrived. hits: [{ ruleId, stepIndex }] — every step watching
        // this (thing, item). Returns the ids of rules that fired.
        handleEvent(hits, raw, now) {
            const fired = [];
            for (const hit of hits) {
                const rule = ruleById.get(hit.ruleId);
                if (!rule || !rule.steps[hit.stepIndex]) { continue; }
                const step = rule.steps[hit.stepIndex];
                const key = stepKey(rule.id, hit.stepIndex);

                const matched   = conditionMatches(step, raw);
                const prev      = S.lastMatch[key];
                const isRising  = matched && prev !== true;
                const isFalling = !matched && prev === true;
                S.lastMatch[key] = matched;
                if (!isRising && !isFalling) { continue; }    // repeated report — no edge

                if (isRising) { S.lastTrueEdge[key] = now; }
                if (!isContinuous(rule)) { driveFsm(rule, hit.stepIndex, isRising, isFalling, now, fired); }
            }
            return fired;
        },

        // Periodic housekeeping: prune decayed terms, time out step windows and
        // stale cycle openings.
        tick(now) {
            S.terms = S.terms.filter(t =>
                Math.abs(t.l0 * Math.pow(2, -(now - t.ts) / t.halfLifeMs)) >= PRUNE_BELOW);
            for (const rule of cfg.rules) {
                const f = S.fsm[rule.id];
                if (!f) { continue; }
                if (f.stepIndex > 0 && f.deadline !== null && now > f.deadline) { resetFsm(rule.id); }
                else if (f.openAt !== null) {
                    const step = rule.steps[f.stepIndex];
                    if (step && step.pattern === 'cycle' && step.cycleMaxMs &&
                        (now - f.openAt) > step.cycleMaxMs) {
                        f.openAt = null;
                        if (f.stepIndex === 0) { f.armedAt = null; }
                    }
                }
            }
        },

        // Full evaluation. resolveState(step) → current raw value for continuous rules.
        evaluate(resolveState, now) {
            let L = priorLogit;
            const active = [];
            let positiveActive = false;
            let negativeActive = false;

            for (const rule of cfg.rules) {
                if (!isContinuous(rule)) { continue; }
                if (conditionMatches(rule.steps[0], resolveState(rule.steps[0]))) {
                    const l0 = clampLn(Math.log(rule.lr));
                    L += l0;
                    active.push(rule.id);
                    if (l0 > 0) { positiveActive = true; }
                    if (l0 < 0) { negativeActive = true; }
                }
            }

            const terms = [];
            for (const t of S.terms) {
                const contrib = t.l0 * Math.pow(2, -(now - t.ts) / t.halfLifeMs);
                L += contrib;
                terms.push({ ruleId: t.ruleId, contribution: Number(contrib.toFixed(3)) });
                if (contrib > 0 && Math.abs(contrib) >= PRUNE_BELOW) { positiveActive = true; }
                if (contrib < 0 && Math.abs(contrib) >= PRUNE_BELOW) { negativeActive = true; }
            }

            L = clampLn(L);
            const p = sigmoid(L);

            if (positiveActive) { S.lastPositiveAt = now; }
            const maxHoldExpired = cfg.maxHoldMs > 0 &&
                S.lastPositiveAt !== null && (now - S.lastPositiveAt) >= cfg.maxHoldMs;

            let changed = false;
            let held = false;
            if (!S.binary && p >= cfg.pOn) {
                S.binary = true;
                S.lastPositiveAt = now;
                changed = true;
            } else if (S.binary && p <= cfg.pOff) {
                if (!cfg.latch || negativeActive || maxHoldExpired) {
                    S.binary = false;
                    changed = true;
                } else {
                    held = true;   // the latch is what is keeping the output on
                }
            }
            S.lastP = p;

            return { p, logOdds: L, binary: S.binary, changed, held,
                     activeRules: active, terms,
                     fsm: JSON.parse(JSON.stringify(S.fsm)) };
        },

        // msg-input escape hatches
        inject(lr, halfLifeMs, now) {
            const n = Number(lr);
            if (!(n > 0) || n === 1) { return false; }
            S.terms.push({ ruleId: 'injected', l0: clampLn(Math.log(n)), ts: now,
                           halfLifeMs: halfLifeMs || cfg.halfLifeMs });
            return true;
        },
        reset() { S = freshState(); },

        // contextStore persistence
        serialize() { return JSON.parse(JSON.stringify(S)); },
        restore(saved) {
            if (!saved || typeof saved !== 'object') { return; }
            const fresh = freshState();
            S = {
                terms:        Array.isArray(saved.terms)
                                  ? saved.terms.filter(t => t && typeof t.l0 === 'number' &&
                                        typeof t.ts === 'number' && typeof t.halfLifeMs === 'number' && t.halfLifeMs > 0)
                                  : fresh.terms,
                lastMatch:    (saved.lastMatch    && typeof saved.lastMatch    === 'object') ? saved.lastMatch    : fresh.lastMatch,
                lastTrueEdge: (saved.lastTrueEdge && typeof saved.lastTrueEdge === 'object') ? saved.lastTrueEdge : fresh.lastTrueEdge,
                fsm:          (saved.fsm          && typeof saved.fsm          === 'object') ? saved.fsm          : fresh.fsm,
                binary:       saved.binary === true,
                lastP:        (typeof saved.lastP === 'number') ? saved.lastP : fresh.lastP,
                lastPositiveAt: (typeof saved.lastPositiveAt === 'number') ? saved.lastPositiveAt : null
            };
        }
    };
}

module.exports = { createBayes, logit, sigmoid };

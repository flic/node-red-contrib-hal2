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
const { strengthLr, scaleShare, requiredGain, logit, sigmoid } = require('../resources/bayes-scale');

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
    const isCertain  = rule => !rule.scale && Math.abs(Math.log(rule.lr)) >= certainLn;

    // A rule's log-odds contribution. Constant for a word strength or raw LR; for a scaled
    // rule it follows the measured value, which is what makes the weight track the reading.
    // null means "contributes nothing this evaluation" — a non-numeric or missing reading.
    const gain = requiredGain(cfg.prior, cfg.pOn);
    function ruleLn(rule, value) {
        if (!rule.scale) { return clampLn(Math.log(rule.lr)); }
        const share = scaleShare(value, rule.scale);
        return share === null ? null : clampLn(share * gain);
    }

    // Reporting arithmetic. A share is the contribution as a percentage of the distance from
    // the prior to the on-threshold — the unit the editor's bars and summary already use, and
    // additive for the same reason log-odds are.
    const round3    = x => Number(x.toFixed(3));
    const sharePct  = ln => Number((100 * ln / gain).toFixed(1));

    const ruleById = new Map(cfg.rules.map(r => [r.id, r]));
    // A rule made only of level checks is the continuous case: its weight applies for as long
    // as every one of them holds at once. "While it is 09:00–10:00 and the terrace is above
    // 100 lux" is one weight with two conditions, not a sequence — a condition is not an event,
    // so nothing would ever drive it forward.
    const isCondition  = st => st.pattern === 'is' || st.pattern === 'isOrBecomes';
    const isContinuous = r => r.steps.every(isCondition);
    // …and a rule that opens with a condition but waits for an event later can never start:
    // the first step has no edge to complete it. The editor warns about this while you write
    // it; the snapshot reports it so an already-saved one does not just sit there looking idle.
    const neverFires = r => !isContinuous(r) && isCondition(r.steps[0]);

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
        // The comparison is guarded as well as the conversion. A saved rule can pair an
        // operator with a value type that cannot serve it — regex against a plain string,
        // where COMPARE.regex calls b.test — and one bad rule must not take the whole
        // evaluation down with it. A condition that cannot be evaluated has not matched.
        try {
            const b = CONVERTERS[step.valueType || 'str'](step.value);
            return cmp(raw, b);
        } catch (e) { return false; }
    }

    function fsmFor(ruleId) {
        if (!S.fsm[ruleId]) { S.fsm[ruleId] = { stepIndex: 0, armedAt: null, deadline: null, openAt: null }; }
        return S.fsm[ruleId];
    }

    function resetFsm(ruleId) {
        S.fsm[ruleId] = { stepIndex: 0, armedAt: null, deadline: null, openAt: null };
    }

    // Fire a momentary rule: add its term, applying the certainty rules.
    function fire(rule, now, value) {
        const l0 = ruleLn(rule, value);
        if (l0 === null || l0 === 0) { return false; }
        const sign = Math.sign(l0);
        S.terms = S.terms.filter(t => {
            if (Math.sign(t.l0) === sign) { return true; }        // same direction — keep
            if (isCertain(rule)) { return false; }                // certain overrides history
            return Math.abs(t.l0) < certainLn;                    // contradiction clears certain terms
        });
        S.terms.push({ ruleId: rule.id, l0, ts: now, halfLifeMs: rule.halfLifeMs || cfg.halfLifeMs });
        return true;
    }

    // Complete the FSM's current step at `doneAt`, advancing or firing, then cascade
    // through following 'becomes' steps already satisfied by an edge since arming.
    function completeStep(rule, f, doneAt, fired, resolveState) {
        if (f.stepIndex >= rule.steps.length - 1) {
            const scaledBy = resolveState ? resolveState(rule.steps[0]) : undefined;
            if (fire(rule, doneAt, scaledBy)) { fired.push(rule.id); }
            resetFsm(rule.id);
            return;
        }
        f.stepIndex += 1;
        f.deadline = doneAt + (rule.steps[f.stepIndex].windowMs || 0);
        f.openAt = null;

        const next = rule.steps[f.stepIndex];

        // A level check is answered on the spot. 'is' is strict — the condition holds
        // at the moment the previous step completed, or the sequence does not apply.
        // 'isOrBecomes' accepts the same, but falls back to waiting for the change,
        // for sensors that report late.
        if (next.pattern === 'is' || next.pattern === 'isOrBecomes') {
            const raw = resolveState ? resolveState(next) : undefined;
            if (conditionMatches(next, raw)) {
                completeStep(rule, f, doneAt, fired, resolveState);
                return;
            }
            if (next.pattern === 'is') { resetFsm(rule.id); return; }
        }

        if (next.pattern === 'becomes' || next.pattern === 'isOrBecomes') {
            const edge = S.lastTrueEdge[stepKey(rule.id, f.stepIndex)];
            if (edge !== undefined && f.armedAt !== null && edge >= f.armedAt) {
                completeStep(rule, f, doneAt, fired, resolveState);   // overlap: already satisfied
            }
        }
    }

    function driveFsm(rule, s, isRising, isFalling, now, fired, resolveState) {
        const f = fsmFor(rule.id);

        // Time out an expired window before considering the event.
        if (f.stepIndex > 0 && f.deadline !== null && now > f.deadline) { resetFsm(rule.id); }

        if (s !== S.fsm[rule.id].stepIndex) { return; }   // not the step we are waiting for
        const fsm = S.fsm[rule.id];
        const step = rule.steps[s];

        // 'is' steps are never driven by events — they are answered by completeStep
        // at the moment the preceding step finishes.
        if (step.pattern === 'is') { return; }

        if (step.pattern === 'cycle') {
            if (isRising) {
                fsm.openAt = now;
                if (s === 0) { fsm.armedAt = now; }
            } else if (isFalling && fsm.openAt !== null) {
                const ok = (now - fsm.openAt) <= (step.cycleMaxMs || Infinity);
                fsm.openAt = null;
                if (ok) { completeStep(rule, fsm, now, fired, resolveState); }
                else if (s === 0) { fsm.armedAt = null; }
            }
        } else if (isRising) { // 'becomes'
            if (s === 0) { fsm.armedAt = now; }
            completeStep(rule, fsm, now, fired, resolveState);
        }
    }

    return {
        // A sensor value arrived. hits: [{ ruleId, stepIndex }] — every step watching
        // this (thing, item). resolveState is needed so a following 'is' step can be
        // answered immediately. Returns the ids of rules that fired.
        handleEvent(hits, raw, now, resolveState) {
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
                if (!isContinuous(rule)) {
                    driveFsm(rule, hit.stepIndex, isRising, isFalling, now, fired, resolveState);
                }
            }
            return fired;
        },

        // Periodic housekeeping: prune decayed terms, time out step windows and
        // stale cycle openings.
        tick(now, resolveState) {
            S.terms = S.terms.filter(t =>
                Math.abs(t.l0 * Math.pow(2, -(now - t.ts) / t.halfLifeMs)) >= PRUNE_BELOW);
            const fired = [];
            for (const rule of cfg.rules) {
                const f = S.fsm[rule.id];
                if (!f) { continue; }
                if (f.stepIndex > 0 && f.deadline !== null && now > f.deadline) { resetFsm(rule.id); continue; }

                // A pending 'isOrBecomes' step waits for a rising edge, which never
                // arrives from a polled source (flow/global/env has no change event).
                // Re-check its level here so "now or soon" means that for them too.
                const step = rule.steps[f.stepIndex];
                if (step && f.stepIndex > 0 && step.pattern === 'isOrBecomes' && resolveState) {
                    if (conditionMatches(step, resolveState(step))) {
                        completeStep(rule, f, now, fired, resolveState);
                        continue;
                    }
                }

                if (f.openAt !== null) {
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
            let positiveActive = false;
            let negativeActive = false;
            // ruleId → report entry. Built as we go so the explanation is the same pass that
            // computes the estimate: a rule cannot be described as contributing unless its
            // weight really went into L.
            const report = new Map();
            const entry = rule => {
                const e = { id: rule.id, label: rule.label || rule.id, status: 'armed',
                            share: 0, logOdds: 0 };
                report.set(rule.id, e);
                return e;
            };

            for (const rule of cfg.rules) {
                const e = entry(rule);
                if (neverFires(rule)) { e.status = 'never-fires'; continue; }
                if (!isContinuous(rule)) { continue; }

                // Every step has to hold at once. The first one's reading is also what a
                // scaled weight follows, so it is read whatever the outcome.
                const raw = resolveState(rule.steps[0]);
                if (raw !== undefined) { e.value = raw; }
                let holds = true;
                for (let i = 0; i < rule.steps.length && holds; i++) {
                    const v = i === 0 ? raw : resolveState(rule.steps[i]);
                    holds = conditionMatches(rule.steps[i], v);
                    // Name the step that failed: with several conditions, "which one" is the
                    // whole question.
                    if (!holds && rule.steps.length > 1) { e.failedStep = i + 1; }
                }

                if (holds) {
                    const l0 = ruleLn(rule, raw);
                    if (l0 === null) {
                        // The conditions hold but the weight cannot be computed — a scaled
                        // rule handed something that is not a number.
                        e.status = 'no-value';
                        continue;
                    }
                    L += l0;
                    e.status = 'contributing';
                    e.logOdds = round3(l0);
                    e.share = sharePct(l0);
                    if (l0 > 0) { positiveActive = true; }
                    if (l0 < 0) { negativeActive = true; }
                } else {
                    e.status = raw === undefined ? 'no-value' : 'condition-false';
                }
            }

            for (const t of S.terms) {
                const contrib = t.l0 * Math.pow(2, -(now - t.ts) / t.halfLifeMs);
                L += contrib;
                // Injected evidence has no configured rule behind it, so it gets its own entry.
                const e = report.get(t.ruleId) ||
                          report.set(t.ruleId, { id: t.ruleId, label: t.ruleId, status: 'injected',
                                                 share: 0, logOdds: 0 }).get(t.ruleId);
                if (e.status !== 'injected') { e.status = 'fading'; }
                // A rule that fired twice holds two terms; they add, exactly as they do in L.
                e.logOdds = round3(e.logOdds + contrib);
                e.share = sharePct(e.logOdds);
                e.age = Math.max(0, Math.round((now - t.ts) / 1000));
                e.halfLife = Math.round(t.halfLifeMs / 1000);
                if (contrib > 0 && Math.abs(contrib) >= PRUNE_BELOW) { positiveActive = true; }
                if (contrib < 0 && Math.abs(contrib) >= PRUNE_BELOW) { negativeActive = true; }
            }

            // Sequences that are partway through: not contributing yet, but the reason a rule
            // looks idle is usually that it is parked on a step waiting for something.
            for (const rule of cfg.rules) {
                const f = S.fsm[rule.id];
                const e = report.get(rule.id);
                if (!f || !e || e.status !== 'armed' || f.stepIndex === 0) { continue; }
                e.status = 'waiting';
                e.step = f.stepIndex + 1;
                e.steps = rule.steps.length;
                if (f.deadline !== null) { e.deadline = Math.max(0, Math.round((f.deadline - now) / 1000)); }
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

            return { p, logOdds: L, share: sharePct(L - priorLogit),
                     binary: S.binary, changed, held,
                     rules: [...report.values()] };
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
        restore(saved, now) {
            if (!saved || typeof saved !== 'object') { return; }
            const fresh = freshState();
            // Keys are scoped to the current rule set: state for rules that no longer exist
            // would otherwise be re-serialized on every persist, forever.
            const keepKey = key => ruleById.has(key.slice(0, key.lastIndexOf(':')));
            const pruneKeys = obj => {
                const out = {};
                for (const k of Object.keys(obj)) { if (keepKey(k)) { out[k] = obj[k]; } }
                return out;
            };
            const binary = saved.binary === true;
            let lastPositiveAt = (typeof saved.lastPositiveAt === 'number') ? saved.lastPositiveAt : null;
            // The maxHold valve compares against lastPositiveAt; restoring a held-on state
            // without one would leave the valve dead. Start its clock at the restore.
            if (binary && lastPositiveAt === null && typeof now === 'number') { lastPositiveAt = now; }
            S = {
                terms:        Array.isArray(saved.terms)
                                  ? saved.terms.filter(t => t && typeof t.l0 === 'number' &&
                                        typeof t.ts === 'number' && typeof t.halfLifeMs === 'number' && t.halfLifeMs > 0 &&
                                        (t.ruleId === 'injected' || ruleById.has(t.ruleId)))
                                  : fresh.terms,
                lastMatch:    (saved.lastMatch    && typeof saved.lastMatch    === 'object') ? pruneKeys(saved.lastMatch)    : fresh.lastMatch,
                lastTrueEdge: (saved.lastTrueEdge && typeof saved.lastTrueEdge === 'object') ? pruneKeys(saved.lastTrueEdge) : fresh.lastTrueEdge,
                fsm:          (saved.fsm          && typeof saved.fsm          === 'object')
                                  ? Object.fromEntries(Object.entries(saved.fsm).filter(e => ruleById.has(e[0])))
                                  : fresh.fsm,
                binary,
                lastP:        (typeof saved.lastP === 'number') ? saved.lastP : fresh.lastP,
                lastPositiveAt
            };
        }
    };
}

module.exports = { createBayes, logit, sigmoid };

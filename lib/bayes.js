'use strict';
// Pure Bayesian binary-state estimator for hal2Bayes. No Node-RED, no Date.now() —
// every method takes `now` (ms epoch) so tests control the clock.
//
// Model: log-odds around logit(prior).
//   L(now) = clamp±C( logit(prior)
//                   + Σ state rows whose condition holds now:  ln(LR)
//                   + Σ live event terms:                      ln(LR) · 2^(−(now−ts)/halfLife) )
//   P = sigmoid(L), with hysteresis on the binary output (on at ≥ pOn, off at ≤ pOff).
//
// State evidence is recomputed from current values at every evaluate() and never stored —
// it is re-derivable, so it must not decay. Event evidence (condition edges, composite
// confirmations, injected) is stored as timestamped terms that decay independently toward
// zero, which handles restarts/downtime for free since decay is wall-clock based.
//
// Composite (sequence) rules are small per-composite state machines:
//   'edge'  : arm-row condition rising edge ⇒ pending confirm window opens.
//   'cycle' : arm condition true→false within cycleMax (e.g. door open→closed) ⇒ armed;
//             a confirm hit during the open phase counts at close (confirmDuringArm),
//             otherwise a pending window opens at close.
// Confirmation applies the composite's LR as an event term. Candidacy (for rows/composites
// flagged onlyAsCandidate) is: binary output currently false AND the candidate row's
// condition had a rising edge within candidateWindow — evaluated and FROZEN when the
// composite arms, so what matters is who was plausibly arriving at that moment.
// With no candidate row configured, candidacy degrades to just "not currently on"
// (exit protection).

const { CONVERTERS, COMPARE } = require('./rules');

const logit   = p => Math.log(p / (1 - p));
const sigmoid = x => 1 / (1 + Math.exp(-x));

const PRUNE_BELOW = 0.01; // drop event terms once |contribution| decays under this

function createBayes(cfg) {
    // cfg: fully normalized — times in ms, numbers as numbers.
    // { prior, pOn, pOff, clamp, halfLifeMs, observations: [row], composites: [comp],
    //   candidateRow, candidateWindowMs }
    // row:  { id, name, type: 'state'|'event', operator, value, valueType, lr,
    //         halfLifeMs (null → cfg default), onlyAsCandidate }
    // comp: { id, name, armRow, armPattern: 'edge'|'cycle', cycleMaxMs, confirmRow,
    //         confirmWindowMs, confirmDuringArm, lr, onlyAsCandidate }

    const priorLogit = logit(cfg.prior);
    const clampC     = cfg.clamp;
    const rowById    = new Map(cfg.observations.map(r => [r.id, r]));

    const clampLn = x => Math.max(-clampC, Math.min(clampC, x));

    // ---- mutable estimator state (everything serialize() persists) ----
    let S = freshState();

    function freshState() {
        return {
            terms: [],        // [{ src, l0, ts, halfLifeMs }] — src = row/composite id or 'injected'
            lastMatch: {},    // rowId → last seen condition result (edge detection)
            lastTrueEdge: {}, // rowId → ts of last rising edge (candidacy)
            fsm: {},          // compId → { phase: 'idle'|'arming'|'pending', armedAt, until, confirmSeen, candidateOk }
            binary: false,
            lastP: cfg.prior
        };
    }

    function conditionMatches(row, raw) {
        const cmp = COMPARE[row.operator];
        if (!cmp) { return false; }
        if (row.operator === 'true' || row.operator === 'false') { return cmp(raw); }
        let b;
        try { b = CONVERTERS[row.valueType || 'str'](row.value); }
        catch (e) { return false; }
        return cmp(raw, b);
    }

    function isCandidate(now) {
        if (S.binary) { return false; }               // exit protection: present can't be boosted
        if (!cfg.candidateRow) { return true; }       // no trigger configured → gate on absence only
        const edge = S.lastTrueEdge[cfg.candidateRow];
        return edge !== undefined && (now - edge) <= cfg.candidateWindowMs;
    }

    function addTerm(src, lr, halfLifeMs, now, gated, candidateOk) {
        if (!(lr > 0) || lr === 1) { return false; }
        if (gated && !candidateOk) { return false; }
        S.terms.push({ src, l0: clampLn(Math.log(lr)), ts: now, halfLifeMs: halfLifeMs || cfg.halfLifeMs });
        return true;
    }

    function fsmFor(compId) {
        if (!S.fsm[compId]) { S.fsm[compId] = { phase: 'idle' }; }
        return S.fsm[compId];
    }

    // Arm completed: freeze candidacy, then either fire (confirm already seen during arming)
    // or open the pending confirm window.
    function armComplete(comp, f, now) {
        f.candidateOk = isCandidate(now);
        if (f.confirmSeen && comp.confirmDuringArm) {
            fire(comp, f, now);
        } else {
            f.phase = 'pending';
            f.until = now + comp.confirmWindowMs;
        }
    }

    function fire(comp, f, now) {
        addTerm(comp.id, comp.lr, null, now, comp.onlyAsCandidate, f.candidateOk);
        S.fsm[comp.id] = { phase: 'idle' };
    }

    function driveComposites(rowId, matched, isRising, isFalling, now) {
        const fired = [];
        for (const comp of cfg.composites) {
            const f = fsmFor(comp.id);
            if (rowId === comp.armRow) {
                if (comp.armPattern === 'cycle') {
                    if (isRising) {
                        S.fsm[comp.id] = { phase: 'arming', armedAt: now, confirmSeen: false };
                    } else if (isFalling && f.phase === 'arming') {
                        if ((now - f.armedAt) <= comp.cycleMaxMs) { armComplete(comp, f, now); }
                        else { S.fsm[comp.id] = { phase: 'idle' }; }
                    }
                } else if (isRising) { // 'edge'
                    f.confirmSeen = false;
                    armComplete(comp, f, now);
                }
            }
            if (rowId === comp.confirmRow && isRising) {
                if (f.phase === 'arming') { f.confirmSeen = true; }
                else if (f.phase === 'pending' && now <= f.until) { fire(comp, f, now); fired.push(comp.id); }
            }
        }
        return fired;
    }

    return {
        // Sensor value arrived for rows (all mapped to the same thing+item by the caller).
        // Returns a list of effects for the debug output.
        handleEvent(rowIds, raw, now) {
            const effects = [];
            for (const rowId of rowIds) {
                const row = rowById.get(rowId);
                if (!row) { continue; }
                const matched   = conditionMatches(row, raw);
                const prev      = S.lastMatch[rowId];
                const isRising  = matched && prev !== true;
                const isFalling = !matched && prev === true;
                S.lastMatch[rowId] = matched;
                if (!isRising && !isFalling) { continue; } // repeated report — no edge, no effect

                if (isRising) {
                    S.lastTrueEdge[rowId] = now;
                    if (row.type === 'event') {
                        if (addTerm(rowId, row.lr, row.halfLifeMs, now, row.onlyAsCandidate, isCandidate(now))) {
                            effects.push({ type: 'event', row: rowId });
                        }
                    }
                }
                for (const compId of driveComposites(rowId, matched, isRising, isFalling, now)) {
                    effects.push({ type: 'composite', composite: compId });
                }
            }
            return effects;
        },

        // Periodic housekeeping: prune dead terms, expire pending/arming phases.
        tick(now) {
            S.terms = S.terms.filter(t =>
                Math.abs(t.l0 * Math.pow(2, -(now - t.ts) / t.halfLifeMs)) >= PRUNE_BELOW);
            for (const comp of cfg.composites) {
                const f = S.fsm[comp.id];
                if (!f) { continue; }
                if (f.phase === 'pending' && now > f.until) { S.fsm[comp.id] = { phase: 'idle' }; }
                // An arm phase older than cycleMax can never complete — a later close is too slow.
                if (f.phase === 'arming' && (now - f.armedAt) > comp.cycleMaxMs) { S.fsm[comp.id] = { phase: 'idle' }; }
            }
        },

        // Full evaluation. resolveState(row) → current raw value for state rows.
        evaluate(resolveState, now) {
            let L = priorLogit;
            const active = [];
            for (const row of cfg.observations) {
                if (row.type !== 'state') { continue; }
                if (conditionMatches(row, resolveState(row))) {
                    L += clampLn(Math.log(row.lr));
                    active.push(row.id);
                }
            }
            const terms = [];
            for (const t of S.terms) {
                const contrib = t.l0 * Math.pow(2, -(now - t.ts) / t.halfLifeMs);
                L += contrib;
                terms.push({ src: t.src, contribution: Number(contrib.toFixed(3)) });
            }
            L = Math.max(-clampC, Math.min(clampC, L));
            const p = sigmoid(L);

            let changed = false;
            if (!S.binary && p >= cfg.pOn)     { S.binary = true;  changed = true; }
            else if (S.binary && p <= cfg.pOff) { S.binary = false; changed = true; }
            S.lastP = p;

            return { p, logOdds: L, binary: S.binary, changed, activeStateRows: active, terms,
                     fsm: JSON.parse(JSON.stringify(S.fsm)) };
        },

        // msg-input escape hatches
        inject(lr, halfLifeMs, now) { return addTerm('injected', Number(lr), halfLifeMs, now, false, true); },
        reset()                     { S = freshState(); },
        force(binary)               { S.binary = !!binary; },

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
                lastP:        (typeof saved.lastP === 'number') ? saved.lastP : fresh.lastP
            };
        }
    };
}

module.exports = { createBayes, logit, sigmoid };

// Shared strength/fade tables and threshold arithmetic for hal2Bayes.
//
// Loaded two ways from one source, so the numbers shown in the editor can never
// drift from what the engine computes:
//   - editor: <script src="resources/node-red-contrib-hal2/bayes-scale.js"> → window.hal2BayesScale
//   - lib/tests: require('../resources/bayes-scale')
//
// The "share of the way" scale: 100 % = the log-odds gain needed to go from the
// prior to the on-threshold, logit(pOn) − logit(prior). Log-odds are additive, so
// shares add exactly — two rules at 74 % and 35 % together reach 109 % and turn
// the output on.

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
    else { root.hal2BayesScale = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Word strengths → likelihood ratios. `certain` saturates the default clamp
    // (ln 400 ≈ 5.99 ≈ 6), i.e. P ≈ 0.9975 — the deterministic end of the scale.
    var STRENGTHS = [
        { v: 'slight',   lr: 1.5 },
        { v: 'moderate', lr: 3 },
        { v: 'strong',   lr: 10 },
        { v: 'decisive', lr: 30 },
        { v: 'certain',  lr: 400 }
    ];

    // Word fade rates → half-life in seconds (momentary rules).
    var FADES = [
        { v: 'quick',  s: 300 },
        { v: 'normal', s: 1200 },
        { v: 'slow',   s: 3600 }
    ];

    function logit(p)   { return Math.log(p / (1 - p)); }
    function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

    function clampLn(x, clamp) { return Math.max(-clamp, Math.min(clamp, x)); }

    function strengthLr(strength) {
        for (var i = 0; i < STRENGTHS.length; i++) {
            if (STRENGTHS[i].v === strength) { return STRENGTHS[i].lr; }
        }
        return 3; // moderate
    }

    function fadeSeconds(fade) {
        for (var i = 0; i < FADES.length; i++) {
            if (FADES[i].v === fade) { return FADES[i].s; }
        }
        return 1200; // normal
    }

    // The log-odds gain a rule set must supply to take the estimate from the
    // prior to the on-threshold.
    function requiredGain(prior, pOn) { return logit(pOn) - logit(prior); }

    // Share of the way to "on" for an effective likelihood ratio (direction
    // already applied — lr < 1 yields a negative share). Returned as a fraction
    // (0.74 = 74 %).
    function shareOfWay(lr, prior, pOn, clamp) {
        return clampLn(Math.log(lr), clamp) / requiredGain(prior, pOn);
    }

    // Scenario estimate for the summary line: all continuous rules inactive, the
    // given momentary contributions at full strength — after how many ms does the
    // estimate fall to the off-threshold? terms: [{ l0, halfLifeMs }] (l0 = ln LR,
    // already clamped). Returns 0 when it is already at/below pOff, and null when
    // it never gets there (prior above the off-threshold).
    function offAfterMs(terms, prior, pOff, clamp) {
        var base = logit(prior);
        var target = logit(pOff);
        function at(t) {
            var L = base;
            for (var i = 0; i < terms.length; i++) {
                L += terms[i].l0 * Math.pow(2, -t / terms[i].halfLifeMs);
            }
            return clampLn(L, clamp);
        }
        if (base > target) { return null; }       // resting state stays above "off"
        if (at(0) <= target) { return 0; }
        var lo = 0, hi = 60e3;
        while (at(hi) > target) {
            hi *= 2;
            if (hi > 365 * 24 * 3600e3) { return null; }
        }
        for (var i = 0; i < 60; i++) {
            var mid = (lo + hi) / 2;
            if (at(mid) > target) { lo = mid; } else { hi = mid; }
        }
        return hi;
    }

    return {
        STRENGTHS: STRENGTHS,
        FADES: FADES,
        logit: logit,
        sigmoid: sigmoid,
        strengthLr: strengthLr,
        fadeSeconds: fadeSeconds,
        requiredGain: requiredGain,
        shareOfWay: shareOfWay,
        offAfterMs: offAfterMs
    };
}));

// How a hal2Bayes rule reads as a sentence, for the snapshot on output 2.
//
// Loaded the same two ways as the other bayes modules, so the editor can adopt this wording
// later without a second implementation of it:
//   - editor: <script src="resources/node-red-contrib-hal2/bayes-label.js"> → window.hal2BayesLabel
//   - runtime/tests: require('../resources/bayes-label')
//
// Pure: names arrive already resolved. Only core/bayes.js can reach RED.nodes to turn a thing
// id into "Kontor Sensor", so it does that and hands the result over — the same separation
// lib/bayes.js uses for resolveState.

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
    else { root.hal2BayesLabel = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Operator wording. The symbols are what the editor shows, so they are what a rule is
    // recognised by; only the two unary ones read better as words.
    var OPERATORS = {
        eq: '==', neq: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=',
        cont: 'contains', regex: 'matches',
        'true': 'is true', 'false': 'is false'
    };

    // Trailing qualifier for the patterns that are events rather than conditions. 'is' and
    // 'isOrBecomes' carry none: the lead word already said they are conditions.
    var PATTERNS = {
        becomes: 'on change',
        cycle: 'on a full cycle'
    };

    // The lead word, matching what the editor prints in .bs-lead (core/bayes.html). A rule
    // that is one level check reads "While …"; anything that waits for an event reads
    // "When …", and later steps read "and" or "then" depending on their own pattern.
    function lead(step, index, continuous) {
        if (index === 0) { return continuous ? 'While' : 'When'; }
        return (step.pattern === 'is' || step.pattern === 'isOrBecomes') ? 'and' : 'then';
    }

    // A rule is continuous when it is a single level check — the same test the estimator
    // uses to decide whether a rule holds a weight or fires one (lib/bayes.js).
    function isContinuous(rule) {
        return !!(rule && rule.steps && rule.steps.length === 1 && rule.steps[0].pattern === 'is');
    }

    // names: { source, window } — `source` is the resolved subject ("Kontor Sensor ·
    // Temperature", "flow.guestMode"), `window` the phrasing for a time step. Both optional;
    // an unresolvable source falls back to whatever the step carries so a label is never empty.
    function describeStep(step, names, index, continuous) {
        if (!step) { return ''; }
        names = names || {};
        var parts = [lead(step, index || 0, continuous)];

        if (step.src === 'time') {
            // The operator is inside/outside for a window, which the editor words that way too.
            parts.push(names.window || 'time window');
            parts.push(step.operator === 'false' ? 'is outside' : 'is inside');
            return parts.join(' ');
        }

        parts.push(names.source || step.thing || step.group || step.prop || step.src);

        var op = OPERATORS[step.operator] || step.operator || '';
        if (op) { parts.push(op); }
        // A unary operator has already said everything; a comparison needs its value.
        if (step.operator !== 'true' && step.operator !== 'false' &&
            step.value !== undefined && step.value !== '') {
            parts.push(String(step.value));
        }
        if (PATTERNS[step.pattern]) { parts.push(PATTERNS[step.pattern]); }
        return parts.join(' ');
    }

    // The whole rule, its steps read in order. names is a parallel array, one per step.
    function describeRule(rule, names) {
        if (!rule || !rule.steps || !rule.steps.length) { return ''; }
        var continuous = isContinuous(rule);
        var out = [];
        for (var i = 0; i < rule.steps.length; i++) {
            out.push(describeStep(rule.steps[i], (names || [])[i], i, continuous));
        }
        return out.join(' ');
    }

    return {
        OPERATORS: OPERATORS,
        PATTERNS: PATTERNS,
        isContinuous: isContinuous,
        describeStep: describeStep,
        describeRule: describeRule
    };
}));

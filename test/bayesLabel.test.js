'use strict';
const assert = require('node:assert');
const bl = require('../resources/bayes-label');

// Steps as core/bayes.js normalises them, with the names it resolves alongside.
const step = (o) => Object.assign({ src: 'thing', pattern: 'is', operator: 'true' }, o);
const named = (source) => ({ source });

describe('bayes-label describeStep', function () {
    it('reads a level check on a thing item', function () {
        assert.strictEqual(
            bl.describeStep(step({ operator: 'gt', value: '25', valueType: 'num' }),
                            named('Kontor Sensor · Temperature'), 0, true),
            'While Kontor Sensor · Temperature > 25');
    });

    it('drops the comparison value for the unary operators', function () {
        // "is true 25" would be nonsense; the operator has already said everything.
        assert.strictEqual(
            bl.describeStep(step({ operator: 'true', value: '25' }), named('Hall Rörelse · Motion'), 0, true),
            'While Hall Rörelse · Motion is true');
        assert.strictEqual(
            bl.describeStep(step({ operator: 'false' }), named('Hall Rörelse · Motion'), 0, true),
            'While Hall Rörelse · Motion is false');
    });

    it('names the pattern when the step is an event rather than a condition', function () {
        assert.strictEqual(
            bl.describeStep(step({ pattern: 'becomes' }), named('Ytterdörr · Contact'), 0, false),
            'When Ytterdörr · Contact is true on change');
        assert.strictEqual(
            bl.describeStep(step({ pattern: 'cycle' }), named('Ytterdörr · Contact'), 0, false),
            'When Ytterdörr · Contact is true on a full cycle');
    });

    it('words a time window as inside or outside', function () {
        const w = step({ src: 'time', operator: 'true' });
        assert.strictEqual(bl.describeStep(w, { window: '22:00–06:00, Mo–Fr' }, 0, true),
            'While 22:00–06:00, Mo–Fr is inside');
        assert.strictEqual(bl.describeStep(step({ src: 'time', operator: 'false' }),
            { window: '22:00–06:00, Mo–Fr' }, 0, true),
            'While 22:00–06:00, Mo–Fr is outside');
    });

    it('falls back to whatever the step carries when a name cannot be resolved', function () {
        // A label is never empty: a deleted thing still has to be recognisable in the snapshot.
        assert.strictEqual(bl.describeStep(step({ thing: 'abc123' }), null, 0, true),
            'While abc123 is true');
        assert.strictEqual(bl.describeStep(step({ src: 'flow', prop: 'guestMode' }), null, 0, true),
            'While guestMode is true');
        assert.strictEqual(bl.describeStep(step({ src: 'group', group: 'g1' }), null, 0, true),
            'While g1 is true');
    });

    it('picks the lead word from position and pattern', function () {
        const s = step({});
        assert.strictEqual(bl.describeStep(s, named('X'), 0, true).split(' ')[0], 'While');
        assert.strictEqual(bl.describeStep(s, named('X'), 0, false).split(' ')[0], 'When');
        assert.strictEqual(bl.describeStep(s, named('X'), 1, false).split(' ')[0], 'and');
        assert.strictEqual(
            bl.describeStep(step({ pattern: 'isOrBecomes' }), named('X'), 1, false).split(' ')[0], 'and');
        assert.strictEqual(
            bl.describeStep(step({ pattern: 'becomes' }), named('X'), 1, false).split(' ')[0], 'then');
        assert.strictEqual(
            bl.describeStep(step({ pattern: 'cycle' }), named('X'), 1, false).split(' ')[0], 'then');
    });

    it('returns an empty string rather than throwing on a missing step', function () {
        assert.strictEqual(bl.describeStep(undefined, named('X'), 0, true), '');
    });
});

describe('bayes-label describeRule', function () {
    it('reads a single level check as one clause', function () {
        const rule = { steps: [step({ operator: 'gt', value: '25' })] };
        assert.strictEqual(bl.describeRule(rule, [named('Kontor Sensor · Temperature')]),
            'While Kontor Sensor · Temperature > 25');
    });

    it('reads a sequence end to end', function () {
        const rule = { steps: [
            step({ pattern: 'cycle' }),
            step({ pattern: 'is', operator: 'true' })
        ]};
        assert.strictEqual(
            bl.describeRule(rule, [named('Ytterdörr · Contact'), named('Hall Rörelse · Motion')]),
            'When Ytterdörr · Contact is true on a full cycle and Hall Rörelse · Motion is true');
    });

    it('calls only a lone level check continuous', function () {
        // The same test the estimator uses to decide whether a rule holds a weight or fires
        // one, so "While" in a label means exactly "this rule holds a weight".
        assert.strictEqual(bl.isContinuous({ steps: [step({ pattern: 'is' })] }), true);
        assert.strictEqual(bl.isContinuous({ steps: [step({ pattern: 'becomes' })] }), false);
        assert.strictEqual(bl.isContinuous({ steps: [step({}), step({})] }), false);
        assert.strictEqual(bl.isContinuous(null), false);
    });

    it('is empty for a rule with no steps', function () {
        assert.strictEqual(bl.describeRule({ steps: [] }, []), '');
        assert.strictEqual(bl.describeRule(null, null), '');
    });
});

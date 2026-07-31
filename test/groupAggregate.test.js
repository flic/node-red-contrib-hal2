'use strict';
const assert = require('node:assert');
const ga = require('../resources/group-aggregate');

// Samples as the engine hands them over: already filtered to state-capable items on live
// things. `at` only matters to `latest`.
const s = (state, updatedAt) => ({ state, updatedAt: updatedAt || 0 });

const TEMPS = [s(21.5, 100), s(22.3, 200), s(19.1, 150)];
const BOOLS = [s(true), s(false), s(true)];

describe('group-aggregate numeric functions', function () {
    it('computes the obvious ones', function () {
        assert.strictEqual(ga.aggregate('min', TEMPS), 19.1);
        assert.strictEqual(ga.aggregate('max', TEMPS), 22.3);
        assert.strictEqual(ga.aggregate('sum', TEMPS), 62.9);
        assert.strictEqual(ga.aggregate('range', TEMPS), 3.2);
    });

    it('rounds away binary floating-point noise', function () {
        // The reason rounding exists at all: this is 21.900000000000002 unrounded, which is
        // what a status badge and a Gate comparison would otherwise see.
        assert.strictEqual(ga.aggregate('average', [s(21.5), s(22.3)]), 21.9);
        assert.strictEqual(ga.aggregate('sum', [s(0.1), s(0.2)]), 0.3);
    });

    it('takes the middle value for an odd count and the mean of the middle two for an even one', function () {
        assert.strictEqual(ga.aggregate('median', TEMPS), 21.5);
        assert.strictEqual(ga.aggregate('median', [s(1), s(2), s(3), s(10)]), 2.5);
        assert.strictEqual(ga.aggregate('median', [s(5)]), 5);
    });

    it('accepts numeric strings, the way sensors send them', function () {
        assert.strictEqual(ga.aggregate('average', [s('21.5'), s('22.5')]), 22);
        assert.strictEqual(ga.aggregate('max', [s('7'), s(3)]), 7);
    });

    it('skips members that are not numbers at all', function () {
        assert.strictEqual(ga.aggregate('average', [s(20), s('warm'), s(null), s(undefined), s(30)]), 25);
        assert.strictEqual(ga.aggregate('min', [s(''), s('   '), s(4)]), 4);
    });

    it('does not let a boolean member count as 1 or 0', function () {
        // Number(true) is 1. A light that is on must not drag a temperature average down.
        assert.strictEqual(ga.aggregate('average', [s(true), s(20), s(30)]), 25);
        assert.strictEqual(ga.aggregate('min', [s(false), s(4)]), 4);
    });

    it('is undefined when no member is numeric', function () {
        for (const fn of ['min', 'max', 'average', 'median', 'sum', 'range']) {
            assert.strictEqual(ga.aggregate(fn, [s('warm'), s(true), s(undefined)]), undefined, fn);
        }
    });

    it('range over a single member is 0', function () {
        assert.strictEqual(ga.aggregate('range', [s(21.5)]), 0);
    });
});

describe('group-aggregate boolean functions', function () {
    it('computes the obvious ones', function () {
        assert.strictEqual(ga.aggregate('anyTrue', BOOLS), true);
        assert.strictEqual(ga.aggregate('allTrue', BOOLS), false);
        assert.strictEqual(ga.aggregate('anyFalse', BOOLS), true);
        assert.strictEqual(ga.aggregate('allFalse', BOOLS), false);
        assert.strictEqual(ga.aggregate('countTrue', BOOLS), 2);
        assert.strictEqual(ga.aggregate('countFalse', BOOLS), 1);
    });

    it('agrees with itself at the edges', function () {
        const allOn = [s(true), s(true)];
        const allOff = [s(false), s(false)];
        assert.strictEqual(ga.aggregate('allTrue', allOn), true);
        assert.strictEqual(ga.aggregate('anyFalse', allOn), false);
        assert.strictEqual(ga.aggregate('allFalse', allOff), true);
        assert.strictEqual(ga.aggregate('anyTrue', allOff), false);
    });

    it('is strict about what counts as true', function () {
        // hal2 normalises in the ThingType's ingress function; by the time a state reaches a
        // group it is a real boolean. 'ON' and 1 are values, not truths.
        const loose = [s('ON'), s(1), s('true'), s('yes')];
        assert.strictEqual(ga.aggregate('anyTrue', loose), undefined);
        assert.strictEqual(ga.aggregate('countTrue', loose), undefined);
        assert.strictEqual(ga.aggregate('countTrue', [s('ON'), s(true)]), 1);
    });

    it('computes percent true as a share of the boolean members', function () {
        assert.strictEqual(ga.aggregate('percentTrue', BOOLS), 66.6667);
        assert.strictEqual(ga.aggregate('percentTrue', [s(true), s(false), s(false)]), 33.3333);
        assert.strictEqual(ga.aggregate('percentTrue', [s(true), s(true)]), 100);
        assert.strictEqual(ga.aggregate('percentTrue', [s(false)]), 0);
        // Non-booleans do not dilute the share.
        assert.strictEqual(ga.aggregate('percentTrue', [s(true), s(false), s('n/a')]), 50);
    });

    it('is undefined when no member is boolean', function () {
        for (const fn of ['anyTrue', 'allTrue', 'anyFalse', 'allFalse', 'countTrue', 'countFalse', 'percentTrue']) {
            assert.strictEqual(ga.aggregate(fn, [s(21), s('warm'), s(undefined)]), undefined, fn);
        }
    });
});

describe('group-aggregate latest', function () {
    it('picks by update time, not by position in the list', function () {
        assert.strictEqual(ga.aggregate('latest', TEMPS), 22.3);
        assert.strictEqual(ga.aggregate('latest', [s('b', 5), s('a', 9), s('c', 1)]), 'a');
    });

    it('takes any type, including booleans and strings', function () {
        assert.strictEqual(ga.aggregate('latest', [s(false, 1), s(true, 2)]), true);
        assert.strictEqual(ga.aggregate('latest', [s('heat', 2), s('off', 1)]), 'heat');
    });

    it('ignores members that have never reported', function () {
        // A member with the newest timestamp but no state must not win with undefined.
        assert.strictEqual(ga.aggregate('latest', [s(21, 1), s(undefined, 99)]), 21);
        assert.strictEqual(ga.aggregate('latest', [s(undefined, 99)]), undefined);
    });
});

describe('group-aggregate empty and unknown', function () {
    // The case this whole contract exists for: a group whose members are all offline arrives
    // here as an empty list, and must not read as a real 0 / false in a Gate or an Event.
    it('every function is undefined for an empty group', function () {
        for (const f of ga.FUNCTIONS) {
            assert.strictEqual(ga.aggregate(f.v, []), undefined, f.v);
            assert.strictEqual(ga.aggregate(f.v, undefined), undefined, f.v);
        }
    });

    it('every function is undefined when no member has ever reported', function () {
        const silent = [s(undefined), s(undefined)];
        for (const f of ga.FUNCTIONS) {
            assert.strictEqual(ga.aggregate(f.v, silent), undefined, f.v);
        }
    });

    it('all true / all false are never vacuously true', function () {
        assert.strictEqual(ga.aggregate('allTrue', []), undefined);
        assert.strictEqual(ga.aggregate('allFalse', []), undefined);
        assert.strictEqual(ga.aggregate('allTrue', [s(undefined)]), undefined);
    });

    it('an unknown function name yields undefined rather than throwing', function () {
        assert.strictEqual(ga.aggregate('mode', BOOLS), undefined);
        assert.strictEqual(ga.aggregate('', BOOLS), undefined);
        assert.strictEqual(ga.aggregate(undefined, BOOLS), undefined);
    });
});

describe('group-aggregate metadata', function () {
    it('classifies every function it offers', function () {
        for (const f of ga.FUNCTIONS) {
            assert.ok(['number', 'boolean', 'any'].includes(f.kind), f.v + ' has a kind');
            assert.strictEqual(ga.kindOf(f.v), f.kind);
            assert.strictEqual(ga.isFunction(f.v), true);
            assert.ok(f.t && f.t.length, f.v + ' has a label');
        }
        assert.strictEqual(ga.isFunction('nope'), false);
        assert.strictEqual(ga.kindOf('nope'), null);
    });

    it('suggests a function that matches the HAType', function () {
        assert.strictEqual(ga.suggestFor('temperature'), 'average');
        assert.strictEqual(ga.suggestFor('humidity'), 'average');
        assert.strictEqual(ga.suggestFor('light'), 'anyTrue');
        assert.strictEqual(ga.suggestFor('contact'), 'anyTrue');
        // Anything with no natural flavour — modes, colors, mixed groups — falls back.
        assert.strictEqual(ga.suggestFor('other'), 'latest');
        assert.strictEqual(ga.suggestFor('ac mode'), 'latest');
        assert.strictEqual(ga.suggestFor(undefined), 'latest');
        // Whatever it suggests must be a function that actually exists.
        for (const ht of ['temperature', 'light', 'other', 'dimmer', 'scene']) {
            assert.strictEqual(ga.isFunction(ga.suggestFor(ht)), true, ht);
        }
    });
});

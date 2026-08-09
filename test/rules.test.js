'use strict';

const assert = require('node:assert');
const { COMPARE, CONVERTERS, rangeBounds } = require('../lib/rules');

describe('lib/rules CONVERTERS', function () {
    it('num / str / bool coerce as expected', function () {
        assert.strictEqual(CONVERTERS.num('42'), 42);
        assert.strictEqual(CONVERTERS.str(42), '42');
        assert.strictEqual(CONVERTERS.bool('true'), true);
        assert.strictEqual(CONVERTERS.bool('false'), false);
        assert.strictEqual(CONVERTERS.bool('anything else'), false);
    });
    it('json parses and re builds a RegExp', function () {
        assert.deepStrictEqual(CONVERTERS.json('{"a":1}'), { a: 1 });
        assert.ok(CONVERTERS.re('^ab') instanceof RegExp);
        assert.ok(CONVERTERS.re('^ab').test('abc'));
    });
});

describe('lib/rules COMPARE range', function () {
    it('is inclusive at both ends', function () {
        assert.strictEqual(COMPARE.range(20, [20, 24]), true);
        assert.strictEqual(COMPARE.range(24, [20, 24]), true);
        assert.strictEqual(COMPARE.range(22, [20, 24]), true);
        assert.strictEqual(COMPARE.range(19.9, [20, 24]), false);
        assert.strictEqual(COMPARE.range(24.1, [20, 24]), false);
    });

    it('does not care which bound was typed first', function () {
        assert.strictEqual(COMPARE.range(22, [24, 20]), true);
        assert.strictEqual(COMPARE.range(19, [24, 20]), false);
    });

    it('stays quiet on a half-filled or non-numeric rule', function () {
        assert.strictEqual(COMPARE.range(22, [20, NaN]), false);
        assert.strictEqual(COMPARE.range(22, [NaN, NaN]), false);
        assert.strictEqual(COMPARE.range('22', [20, 24]), false, 'a string reading is not a number');
        assert.strictEqual(COMPARE.range(22, 20), false, 'a single bound is not a range');
        assert.strictEqual(COMPARE.range(22, undefined), false);
    });
});

describe('lib/rules rangeBounds', function () {
    it('turns a blank bound into NaN rather than zero', function () {
        // Number('') is 0, so reading the fields with Number() alone gave an empty box a real
        // value: "in range 20 to <blank>" quietly became the band 0–20, which matches things
        // and matches them wrongly.
        assert.ok(Number.isNaN(rangeBounds('20', '')[1]));
        assert.ok(Number.isNaN(rangeBounds('20', '   ')[1]));
        assert.ok(Number.isNaN(rangeBounds('20', null)[1]));
        assert.ok(Number.isNaN(rangeBounds('20', undefined)[1]));
        assert.deepStrictEqual(rangeBounds('20', '24'), [20, 24]);
        assert.deepStrictEqual(rangeBounds(20, 24), [20, 24]);
    });

    it('leaves a real zero alone', function () {
        assert.deepStrictEqual(rangeBounds('0', '10'), [0, 10]);
    });

    it('makes both range operators false, which is the point', function () {
        const half = rangeBounds('20', '');
        assert.strictEqual(COMPARE.range(10, half), false);
        assert.strictEqual(COMPARE.outrange(10, half), false);
        assert.strictEqual(COMPARE.range(100, half), false);
        assert.strictEqual(COMPARE.outrange(100, half), false);
    });
});

describe('lib/rules COMPARE outrange', function () {
    it('is the outside of the same band, exclusive of the ends', function () {
        assert.strictEqual(COMPARE.outrange(19.9, [20, 24]), true);
        assert.strictEqual(COMPARE.outrange(24.1, [20, 24]), true);
        assert.strictEqual(COMPARE.outrange(20, [20, 24]), false, 'the end belongs to the band');
        assert.strictEqual(COMPARE.outrange(24, [20, 24]), false);
        assert.strictEqual(COMPARE.outrange(22, [20, 24]), false);
    });

    it('fails closed like its opposite, rather than open', function () {
        // The reason it is written out instead of as !range: a non-numeric reading is outside
        // nothing, and a half-filled rule must not start matching everything.
        assert.strictEqual(COMPARE.outrange('22', [20, 24]), false);
        assert.strictEqual(COMPARE.outrange(22, [20, NaN]), false);
        assert.strictEqual(COMPARE.outrange(22, undefined), false);
    });
});

describe('lib/rules COMPARE', function () {
    it('equality operators', function () {
        assert.strictEqual(COMPARE.eq(3, 3), true);
        assert.strictEqual(COMPARE.eq(3, '3'), false);
        assert.strictEqual(COMPARE.neq(3, 4), true);
    });
    it('numeric operators only fire for numbers', function () {
        assert.strictEqual(COMPARE.lt(2, 3), true);
        assert.strictEqual(COMPARE.gte(3, 3), true);
        assert.strictEqual(COMPARE.gt('5', 3), false); // string a → no match, guards non-numbers
    });
    it('cont uses substring, regex expects a compiled RegExp', function () {
        assert.strictEqual(COMPARE.cont('hello world', 'world'), true);
        assert.strictEqual(COMPARE.cont('hello', 'x'), false);
        assert.strictEqual(COMPARE.regex('abc', /^ab/), true);
        assert.strictEqual(COMPARE.regex('xyz', /^ab/), false);
    });
    it('true / false test booleans strictly', function () {
        assert.strictEqual(COMPARE['true'](true), true);
        assert.strictEqual(COMPARE['true'](1), false);
        assert.strictEqual(COMPARE['false'](false), true);
    });
});

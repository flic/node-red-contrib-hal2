'use strict';

const assert = require('node:assert');
const { COMPARE, CONVERTERS } = require('../lib/rules');

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

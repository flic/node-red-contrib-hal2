'use strict';
// resources/hal.js is a browser file loaded by the node editors, so it is run here in a
// sandbox with a window rather than required. Only the pure decision helpers are exercised —
// the DOM-walking ones need RED and an editor to mean anything.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = { console };
sandbox.self = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'resources', 'hal.js'), 'utf8'), sandbox);
const { halNumericOperator, halShouldDefaultNumeric } = sandbox;

describe('hal.js halNumericOperator', function () {
    it('claims the comparisons that can only mean a number', function () {
        for (const op of ['lt', 'lte', 'gt', 'gte']) {
            assert.strictEqual(halNumericOperator(op), true, op);
        }
    });

    it('leaves the ambiguous ones alone', function () {
        // eq/neq are as at home with a string as with a number, and the unary ones take no
        // value at all — guessing for those would be guessing wrong half the time.
        for (const op of ['eq', 'neq', 'cont', 'regex', 'true', 'false', undefined, '']) {
            assert.strictEqual(halNumericOperator(op), false, String(op));
        }
    });
});

describe('hal.js halShouldDefaultNumeric', function () {
    it('switches an empty field on a numeric comparison', function () {
        assert.strictEqual(halShouldDefaultNumeric('gt', 'str', ''), true);
        assert.strictEqual(halShouldDefaultNumeric('lte', 'str', undefined), true);
    });

    it('switches a field that already holds a number', function () {
        assert.strictEqual(halShouldDefaultNumeric('gt', 'str', '100'), true);
        assert.strictEqual(halShouldDefaultNumeric('gt', 'str', ' 21.5 '), true);
        assert.strictEqual(halShouldDefaultNumeric('gt', 'str', '-3'), true);
    });

    it('leaves text alone — it was typed on purpose', function () {
        assert.strictEqual(halShouldDefaultNumeric('gt', 'str', 'warm'), false);
        assert.strictEqual(halShouldDefaultNumeric('gt', 'str', '10 lux'), false);
    });

    it('never overrides a type the user chose', function () {
        // A flow/msg reference or an explicit type is a decision; only the default string
        // type is treated as "not yet decided".
        for (const t of ['num', 'flow', 'global', 'msg', 'env', 're', 'bool', 'json']) {
            assert.strictEqual(halShouldDefaultNumeric('gt', t, ''), false, t);
        }
    });

    it('does nothing for operators that do not imply a number', function () {
        assert.strictEqual(halShouldDefaultNumeric('eq', 'str', '100'), false);
        assert.strictEqual(halShouldDefaultNumeric('cont', 'str', '100'), false);
        assert.strictEqual(halShouldDefaultNumeric('true', 'str', ''), false);
    });

    it('does not mistake blank-ish or infinite input for a number', function () {
        assert.strictEqual(halShouldDefaultNumeric('gt', 'str', '   '), true, 'still empty');
        assert.strictEqual(halShouldDefaultNumeric('gt', 'str', 'Infinity'), false);
        assert.strictEqual(halShouldDefaultNumeric('gt', 'str', 'NaN'), false);
    });
});

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
const { halNumericOperator } = sandbox;

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

describe('hal.js halParseTags', function () {
    // Copied into this realm before comparing: an array built inside the vm sandbox carries
    // that context's Array.prototype, and deepStrictEqual compares prototypes.
    const tags = v => [...sandbox.halParseTags(v)];

    it('splits a comma-separated field and trims', function () {
        assert.deepStrictEqual(tags('inne, klimat ,  varm'), ['inne', 'klimat', 'varm']);
        assert.deepStrictEqual(tags('one'), ['one']);
    });

    it('yields an empty array for an empty field', function () {
        // Not ['']: an empty tag would match a tag filter for the empty string, so every
        // untagged group would answer a query nobody meant to make.
        assert.deepStrictEqual(tags(''), []);
        assert.deepStrictEqual(tags('   '), []);
        assert.deepStrictEqual(tags(undefined), []);
        assert.deepStrictEqual(tags(',,'), []);
    });

    it('keeps tags containing spaces intact', function () {
        assert.deepStrictEqual(tags('power users, ute'), ['power users', 'ute']);
    });

    it('accepts an array back unchanged, so a stored value round-trips', function () {
        assert.deepStrictEqual(tags(['a', ' b ', '']), ['a', 'b']);
    });
});

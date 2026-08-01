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

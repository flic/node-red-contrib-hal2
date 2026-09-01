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
const { halNumericOperator, halGroupAccepts, halHaTypeFamily } = sandbox;

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

describe('hal.js halGroupAccepts', function () {
    // A group's type is its command contract: a light group is commanded with a boolean, a
    // dimmer group with 0–100. The rule decides what the editor offers, and it is the only
    // place that decides it — the runtime fans a command out to whatever is stored.
    it('takes a member of the same family', function () {
        assert.ok(halGroupAccepts('light', 'light'));
        assert.ok(halGroupAccepts('light', 'switch'), 'switch and light are one On/Off family');
        assert.ok(halGroupAccepts('dimmer', 'dimmer'));
        assert.ok(halGroupAccepts('motion', 'motion'));
    });

    it('refuses a dimmer in an On/Off group', function () {
        // Allowed once, so a dimmable lamp could reach "all lights" through its brightness
        // item. With device_class the lamp's On item carries that instead, and the group goes
        // back to taking one kind of value.
        assert.ok(!halGroupAccepts('light', 'dimmer'));
    });

    it('still refuses an On/Off item in a dimmer group', function () {
        assert.ok(!halGroupAccepts('dimmer', 'light'), 'an On/Off device cannot honour a level');
    });

    it('lets an untyped item into a mixed group only', function () {
        assert.ok(halGroupAccepts('other', ''));
        assert.ok(halGroupAccepts('', ''), 'a group with no type of its own is the mixed one');
        assert.ok(!halGroupAccepts('light', ''), 'an untyped item is not a wildcard any more');
    });

    it('matches a declared class rather than the ha_type it hides behind', function () {
        // The case this was added for: a switch driving a socket looks identical to one driving a
        // lamp from the protocol side, so it sat in "all lights" and was cut whenever the lights
        // went out. Once declared, the class is what the group's contract is matched against.
        assert.ok(!halGroupAccepts('light', 'switch', 'outlet'), 'a socket is not a light');
        assert.ok(!halGroupAccepts('light', 'switch', 'appliance'));
        assert.ok(!halGroupAccepts('light', 'switch', 'fan'));
        assert.ok(halGroupAccepts('light', 'switch', 'light'), 'a declared lamp still fits');
        assert.ok(halGroupAccepts('light', 'switch'), 'an undeclared switch is unchanged');
        assert.ok(halGroupAccepts('other', 'switch', 'outlet'), 'a mixed group still takes it');
    });

    it('refuses unrelated families', function () {
        assert.ok(!halGroupAccepts('light', 'motion'));
        assert.ok(!halGroupAccepts('temperature', 'presence'));
    });

    it('folds switch and light into one family and leaves the rest alone', function () {
        assert.strictEqual(halHaTypeFamily('switch'), 'onoff');
        assert.strictEqual(halHaTypeFamily('light'), 'onoff');
        assert.strictEqual(halHaTypeFamily('dimmer'), 'dimmer');
    });
});

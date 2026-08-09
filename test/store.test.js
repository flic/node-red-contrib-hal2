'use strict';

const assert = require('node:assert');
const { createStore } = require('../lib/store');

describe('lib/store createStore', function () {
    it('reads back what was written', function () {
        const { api } = createStore({}, () => {});
        api.set('rooms', { kontor: -62 });
        assert.deepStrictEqual(api.get('rooms'), { kontor: -62 });
    });

    it('starts from the bag it was handed, so a restart resumes where it left off', function () {
        const { api } = createStore({ rooms: { hall: -80 } }, () => {});
        assert.deepStrictEqual(api.get('rooms'), { hall: -80 });
        assert.deepStrictEqual(api.keys(), ['rooms']);
    });

    it('deletes on null or undefined rather than storing an empty value', function () {
        // Same rule as the metadata channel: an empty value removes the key. Without it a
        // function would have to reach past the API to get rid of something.
        const { api } = createStore({ a: 1, b: 2 }, () => {});
        api.set('a', null);
        api.set('b', undefined);
        assert.deepStrictEqual(api.keys(), []);
        assert.strictEqual(api.get('a'), undefined);
    });

    it('keeps falsy values that are not empty', function () {
        const { api } = createStore({}, () => {});
        api.set('zero', 0);
        api.set('blank', '');
        api.set('no', false);
        assert.deepStrictEqual(api.keys().sort(), ['blank', 'no', 'zero']);
        assert.strictEqual(api.get('zero'), 0);
    });

    it('ignores a set with no key instead of writing an "undefined" key', function () {
        const { api } = createStore({}, () => {});
        api.set();
        assert.deepStrictEqual(api.keys(), []);
    });

    it('persists after every mutation, and only after a mutation', function () {
        let writes = 0;
        const { api } = createStore({}, () => { writes++; });
        api.get('nothing');
        assert.strictEqual(writes, 0);
        api.set('a', 1);
        api.set('a', null);
        api.clear();
        assert.strictEqual(writes, 3);
    });

    it('hands the persist callback the bag it should write', function () {
        let last = null;
        const { api } = createStore({}, bag => { last = bag; });
        api.set('a', 1);
        assert.deepStrictEqual(last, { a: 1 });
    });

    it('clear empties the store and reports the new bag through value()', function () {
        // clear() swaps in a fresh object, so a caller holding the original would go stale —
        // value() is how hal2Thing stays pointed at the live one.
        const handle = createStore({ a: 1 }, () => {});
        handle.api.clear();
        assert.deepStrictEqual(handle.api.keys(), []);
        assert.deepStrictEqual(handle.value(), {});
        handle.api.set('b', 2);
        assert.deepStrictEqual(handle.value(), { b: 2 });
    });

    it('survives being created with no bag and no persist callback', function () {
        const { api } = createStore();
        assert.doesNotThrow(() => api.set('a', 1));
        assert.strictEqual(api.get('a'), 1);
    });
});

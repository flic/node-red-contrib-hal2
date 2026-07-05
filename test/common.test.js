'use strict';

const assert = require('node:assert');
const common = require('../lib/common');

describe('lib/common queueSend', function () {
    function makeNode() {
        return {
            ratelimit: 0,
            statusCalls: [],
            sent: [],
            eventHandler: {
                publishCommand(thing, item, payload) {
                    this._sent = this._sent || [];
                }
            },
            status(s) { this.statusCalls.push(s); }
        };
    }

    it('drains the whole queue in order (rate limited across ticks)', function (done) {
        const published = [];
        const node = makeNode();
        node.ratelimit = 1;   // small delay so the queue drains over several ticks
        node.eventHandler.publishCommand = (thing, item, payload) =>
            published.push(payload);

        const queue = [
            { thing: 't1', item: 'i1', payload: 'a' },
            { thing: 't2', item: 'i2', payload: 'b' },
            { thing: 't3', item: 'i3', payload: 'c' }
        ];

        common.queueSend(node, queue, 0, function () {
            assert.deepStrictEqual(published, ['a', 'b', 'c']);
            assert.strictEqual(queue.length, 0);
            done();
        });
    });

    it('calls onFinish once the queue empties', function (done) {
        const node = makeNode();
        node.eventHandler.publishCommand = () => {};
        common.queueSend(node, [{ thing: 't', item: 'i', payload: 1 }], 0, () => done());
    });

    it('does not throw when onFinish is omitted (group-style call)', function () {
        const node = { ratelimit: 0, eventHandler: { publishCommand() {} }, status() {} };
        assert.doesNotThrow(() => common.queueSend(node, [{ thing: 't', item: 'i', payload: 1 }]));
    });

    it('treats a null/undefined qLast as "send now"', function () {
        const published = [];
        const node = makeNode();
        node.eventHandler.publishCommand = (t, i, p) => published.push(p);
        common.queueSend(node, [{ thing: 't', item: 'i', payload: 'x' }], null);
        assert.deepStrictEqual(published, ['x']);
    });
});

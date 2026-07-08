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

describe('lib/common createThrottledQueue', function () {
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    it('sends the first item immediately and paces the rest', async function () {
        const sent = [];
        const q = common.createThrottledQueue(30, m => sent.push([m, Date.now()]));
        q.push(['a', 'b', 'c']);
        assert.strictEqual(sent.length, 1);           // first goes out at once
        await sleep(100);
        assert.deepStrictEqual(sent.map(s => s[0]), ['a', 'b', 'c']);
        assert.ok(sent[1][1] - sent[0][1] >= 25, 'second send must respect the rate limit');
        assert.ok(sent[2][1] - sent[1][1] >= 25, 'third send must respect the rate limit');
    });

    it('holds the pace across bursts (persistent last-send timestamp)', async function () {
        const sent = [];
        const q = common.createThrottledQueue(50, m => sent.push(Date.now()));
        q.push(['a']);                                // burst 1 — sent immediately
        await sleep(10);
        q.push(['b']);                                // burst 2 — must wait for the window
        assert.strictEqual(sent.length, 1, 'burst 2 must not send inside the window');
        await sleep(80);
        assert.strictEqual(sent.length, 2);
        assert.ok(sent[1] - sent[0] >= 45, 'rate limit must hold across bursts');
    });

    it('drains everything without delay when ratelimit is 0', async function () {
        const sent = [];
        const q = common.createThrottledQueue(0, m => sent.push(m));
        q.push(['a', 'b', 'c']);
        await sleep(20);
        assert.deepStrictEqual(sent, ['a', 'b', 'c']);
    });

    it('clear() drops queued items and cancels the timer', async function () {
        const sent = [];
        const q = common.createThrottledQueue(30, m => sent.push(m));
        q.push(['a', 'b', 'c']);
        q.clear();
        assert.strictEqual(q.size(), 0);
        await sleep(80);
        assert.deepStrictEqual(sent, ['a'], 'only the immediate send happens');
    });
});

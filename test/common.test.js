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

describe('lib/common item capability predicates', function () {
    // These mirror halStatusItem / halCommandItem in resources/hal.js. The editor decides with
    // those which items may join a group; the engine decides with these which members count.
    // A disagreement would show as a member you could add but that never contributed.
    const item = (type, id) => ({ type, id: id || 'x' });

    it('agrees on the item types that carry state', function () {
        assert.strictEqual(common.statusCapableItem(item('status')), true);
        assert.strictEqual(common.statusCapableItem(item('both')), true);
        assert.strictEqual(common.statusCapableItem(item('loopback_both')), true);
        assert.strictEqual(common.statusCapableItem(item('command')), false);
        assert.strictEqual(common.statusCapableItem(item('loopback_command')), false);
    });

    it('treats the reserved heartbeat item as stateful whatever its type', function () {
        assert.strictEqual(common.statusCapableItem(item('command', '1')), true);
        assert.strictEqual(common.statusCapableItem(item(undefined, '1')), true);
    });

    it('agrees on the item types that accept commands', function () {
        assert.strictEqual(common.commandCapableItem(item('command')), true);
        assert.strictEqual(common.commandCapableItem(item('both')), true);
        assert.strictEqual(common.commandCapableItem(item('loopback_both')), true);
        assert.strictEqual(common.commandCapableItem(item('loopback_command')), true);
        assert.strictEqual(common.commandCapableItem(item('status')), false);
        // The heartbeat item is readable, never commandable.
        assert.strictEqual(common.commandCapableItem(item('status', '1')), false);
    });

    it('says no rather than throwing on a missing item', function () {
        assert.strictEqual(common.statusCapableItem(undefined), false);
        assert.strictEqual(common.commandCapableItem(null), false);
    });
});

describe('lib/common isThingAlive', function () {
    const thing = (hbCheck, aliveState) => ({
        thingType: { hbCheck },
        state: aliveState === undefined ? {} : { '1': aliveState }
    });

    it('is alive when the ThingType does not check heartbeats', function () {
        // Even with a stale false left over from before the check was switched off.
        assert.strictEqual(common.isThingAlive(thing(false, false)), true);
        assert.strictEqual(common.isThingAlive(thing(false, undefined)), true);
    });

    it('is alive until a heartbeat explicitly says otherwise', function () {
        assert.strictEqual(common.isThingAlive(thing(true, undefined)), true, 'never reported yet');
        assert.strictEqual(common.isThingAlive(thing(true, true)), true);
        assert.strictEqual(common.isThingAlive(thing(true, false)), false);
    });

    it('is not alive for a thing that cannot be resolved', function () {
        assert.strictEqual(common.isThingAlive(undefined), false);
        assert.strictEqual(common.isThingAlive({}), false, 'no thingType — not a usable thing');
    });
});

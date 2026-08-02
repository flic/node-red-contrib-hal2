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

describe('lib/common checkHeartbeats', function () {
    // A mock thing that mimics core/thing.js updateState's side effects — it writes the
    // state AND refreshes the heartbeat timestamp. That side effect is the whole reason
    // the sweep must only act on the transition to offline: a rewrite would keep the
    // timestamp fresh forever and re-emit an update per sweep.
    function mockThing(now, lastSeenMsAgo, state1) {
        const thing = {
            id: 't1', name: 'Sensor',
            thingType: { hbTTL: 60 },                     // seconds
            state: state1 === undefined ? {} : { '1': state1 },
            heartbeat: lastSeenMsAgo === null ? {} : { t1: now - lastSeenMsAgo },
            writes: [],
            updateState(msg, itemId, state, logtype) {
                this.writes.push({ itemId, state, logtype });
                this.state[itemId] = state;
                this.heartbeat[this.id] = now;            // the side effect under test
            }
        };
        return thing;
    }
    const sweep = (thing, now) => common.checkHeartbeats([{ id: 't1' }], () => thing, now);

    it('marks a thing offline when its TTL has expired', function () {
        const now = 1000000;
        const thing = mockThing(now, 61000, true);        // TTL 60s, silent for 61s
        sweep(thing, now);
        assert.deepStrictEqual(thing.writes, [{ itemId: '1', state: false, logtype: 'heartbeat' }]);
    });

    it('writes offline only once — repeated sweeps do not flip-flop', function () {
        const now = 1000000;
        const thing = mockThing(now, 61000, true);
        sweep(thing, now);
        // The offline write refreshed thing.heartbeat, so `online` now computes true —
        // the regression was that this re-triggered a write every sweep, forever.
        sweep(thing, now + 5000);
        sweep(thing, now + 10000);
        assert.strictEqual(thing.writes.length, 1);
    });

    it('leaves a thing inside its TTL alone', function () {
        const now = 1000000;
        const thing = mockThing(now, 30000, true);        // seen 30s ago, TTL 60s
        sweep(thing, now);
        assert.deepStrictEqual(thing.writes, []);
    });

    it('does not resurrect an offline thing — coming back is the ingress path\'s job', function () {
        const now = 1000000;
        const thing = mockThing(now, 1000, false);        // fresh heartbeat, still marked offline
        sweep(thing, now);
        assert.deepStrictEqual(thing.writes, []);
    });

    it('marks a thing that has never reported as offline, once', function () {
        const now = 1000000;
        const thing = mockThing(now, null, undefined);    // no heartbeat, no state
        sweep(thing, now);
        sweep(thing, now + 5000);
        assert.strictEqual(thing.writes.length, 1);
        assert.strictEqual(thing.writes[0].state, false);
    });

    it('skips unresolvable and half-built things without throwing', function () {
        assert.doesNotThrow(() => common.checkHeartbeats([{ id: 'gone' }], () => undefined, 0));
        assert.doesNotThrow(() => common.checkHeartbeats([{ id: 'x' }], () => ({ id: 'x' }), 0));
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

'use strict';
// core/event.js needs a Node-RED runtime, so it is loaded against a stub RED rather than required
// for its exports — the same approach test/thingRuntime.test.js takes. The node's whole job is to
// decide *whether* to send and *what*, so the assertions are about the message stream: drive
// node.listener with synthetic events and read back what node.send was called with.

const assert = require('node:assert');
const path = require('node:path');

const EVENT = path.join(__dirname, '..', 'core', 'event.js');

// Builds an Event node, returning it with the messages it sends and the context it persists into.
// `ctxStore` is shared with the caller so a test can rebuild a node from a previous one's state
// and check what would survive a restart.
function makeEvent(config, ctxStore) {
    ctxStore = ctxStore || {};
    const nodeContext = { get: k => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } };
    const sent = [];

    const eventHandler = {
        contextStore: 'memory',
        subscribe: () => {}, unsubscribe: () => {},
        readGroup: () => undefined, getGroupState: () => null
    };

    let registered = null;
    const RED = {
        nodes: {
            createNode(node, cfg) {
                node.id = cfg.id || 'ev1';
                node.context = () => nodeContext;
                node.on = () => {};
                node.status = s => { node._status = s; };
                node.debug = () => {}; node.warn = () => {}; node.error = () => {};
                node.send = m => { sent.push(m); };
            },
            getNode: () => eventHandler,
            registerType: (name, fn) => { registered = fn; }
        },
        util: {
            cloneMessage: m => JSON.parse(JSON.stringify(m)),
            generateId: () => 'id',
            evaluateNodeProperty: (v, t) => {
                if (t === 'num')  { return Number(v); }
                if (t === 'bool') { return v === true || v === 'true'; }
                return v;
            }
        }
    };

    delete require.cache[require.resolve(EVENT)];
    require(EVENT)(RED);

    const node = {};
    registered.call(node, Object.assign({
        id: 'ev1', eventHandler: 'eh1', thing: 't1', item: 'i1', typeSel: 'hal2Thing',
        operator: 'gt', compareValue: '25', compareType: 'num', change: '0',
        outputType: 'trigger', outputValue: '',
        ratelimit: false, ratetype: 'all', rate: '1', rateUnits: 'hour',
        delay: false, delayExtend: false, delayReset: false, delayValue: 5
    }, config));

    // One state report. `laststate` is what the Thing held before, as the engine supplies it.
    const update = (state, laststate) =>
        node.listener('tt1', 't1', 'i1', { state, laststate, payload: state });

    return { node, sent, ctxStore, update, payloads: () => sent.map(m => m.payload) };
}

// showState re-arms itself for the length of the rate-limit window, so any test that lets the
// rate limiter run would leave a real timer of that length pending and node would never exit.
function withFakeTimers(fn) {
    const realSet = global.setTimeout, realClear = global.clearTimeout;
    const timers = new Map();
    let seq = 0;
    global.setTimeout = (cb, ms, ...args) => { timers.set(++seq, () => cb(...args)); return seq; };
    global.clearTimeout = id => { timers.delete(id); };
    const fire = () => { const due = [...timers.values()]; timers.clear(); due.forEach(f => f()); };
    try { return fn(fire, () => timers.size); }
    finally { global.setTimeout = realSet; global.clearTimeout = realClear; }
}

describe('core/event.js — trigger true/false', function () {
    it('reports the rising and the falling edge, and nothing in between', function () {
        const { update, payloads } = makeEvent({});

        update(20, undefined);          // below — first answer
        update(30, 20);                 // crosses up
        update(31, 30);                 // still above
        update(40, 31);                 // still above
        update(24, 40);                 // crosses down
        update(23, 24);                 // still below

        assert.deepStrictEqual(payloads(), [false, true, false]);
    });

    it('says nothing when the reading moves without changing the answer', function () {
        // The property that separates a level from an evaluation: six updates, one message.
        const { update, payloads } = makeEvent({});

        update(24.7, undefined);
        update(24.8, 24.7);
        update(24.6, 24.8);
        update(24.9, 24.6);
        update(24.5, 24.9);

        assert.deepStrictEqual(payloads(), [false], 'one answer, not five');
    });

    it('remembers its level across a restart rather than restating it', function () {
        const shared = {};
        const first = makeEvent({}, shared);
        first.update(30, undefined);
        assert.deepStrictEqual(first.payloads(), [true]);
        assert.strictEqual(shared.lastResult, true, 'persisted for the next incarnation');

        // Same node rebuilt from the stored context, as after a deploy.
        const second = makeEvent({}, shared);
        second.update(31, 30);
        second.update(35, 31);
        assert.deepStrictEqual(second.payloads(), [], 'the level did not move, so there is nothing to say');

        second.update(10, 35);
        assert.deepStrictEqual(second.payloads(), [false], 'and it still reports a real change');
    });

    it('ignores a rate limit, which would otherwise strand the receiver on true', function () {
        const { update, payloads } = makeEvent({ ratelimit: true, rate: '1', rateUnits: 'hour' });

        update(30, undefined);
        update(10, 30);                 // inside the window — must not be dropped

        assert.deepStrictEqual(payloads(), [true, false]);
    });

    it('shows the level in the node status', function () {
        const { node, update } = makeEvent({});
        update(30, undefined);
        assert.strictEqual(node._status.text, 'true');
        assert.strictEqual(node._status.fill, 'green');
        update(10, 30);
        assert.strictEqual(node._status.text, 'false');
    });
});

describe('core/event.js — trigger true/false with a delay', function () {
    const CLOCK = 20;              // the delay, in whatever the fake clock pretends seconds are

    it('delays the rising edge and reports the falling one at once', function () {
        withFakeTimers((fire) => {
            const { update, payloads } = makeEvent({ delay: true, delayValue: CLOCK,
                                                     delayOnFalse: false });

            update(30, undefined);
            assert.deepStrictEqual(payloads(), [], 'true is waiting out the delay');
            fire();
            assert.deepStrictEqual(payloads(), [true]);

            update(10, 30);
            assert.deepStrictEqual(payloads(), [true, false], 'false is not delayed');
        });
    });

    it('drops a pending true when the answer falls back to what was already said', function () {
        // The case the first version of this got wrong. With lastResult already false, a rule
        // that goes true, starts its delay and then falls back looked like "nothing changed" and
        // returned early — leaving the queued true to land as a statement about a condition that
        // had stopped holding. It only escaped notice because lastResult starts undefined.
        withFakeTimers((fire, pending) => {
            const { update, payloads } = makeEvent({ delay: true, delayValue: CLOCK,
                                                     delayOnFalse: false });

            update(10, undefined);              // establishes false
            assert.deepStrictEqual(payloads(), [false]);

            update(30, 10);                     // goes true — queued behind the delay
            assert.strictEqual(pending(), 1);
            update(20, 30);                     // and falls back before the timer runs
            assert.strictEqual(pending(), 0, 'the queued true was dropped');

            fire();
            assert.deepStrictEqual(payloads(), [false], 'and nothing else was ever said');
        });
    });

    it('drops a pending true when the rule stops holding first', function () {
        // delayReset is deliberately off: in level mode it is implied, because announcing a
        // condition that has already stopped holding is not a late report but a false one.
        withFakeTimers((fire, pending) => {
            const { update, payloads } = makeEvent({ delay: true, delayValue: CLOCK,
                                                     delayOnFalse: false, delayReset: false });

            update(30, undefined);
            assert.strictEqual(pending(), 1);
            update(10, 30);                     // rule stops holding while the timer runs
            assert.strictEqual(pending(), 0, 'the pending true was cancelled');
            fire();
            assert.deepStrictEqual(payloads(), [false], 'only the falling edge was ever sent');
        });
    });
});

describe('core/event.js — which edge the delay applies to', function () {
    const CLOCK = 20;

    it('delays only false when asked to', function () {
        withFakeTimers((fire) => {
            const { update, payloads } = makeEvent({ delay: true, delayValue: CLOCK,
                                                     delayOnTrue: false, delayOnFalse: true });
            update(30, undefined);
            assert.deepStrictEqual(payloads(), [true], 'true is not delayed');

            update(10, 30);
            assert.deepStrictEqual(payloads(), [true], 'false is waiting');
            fire();
            assert.deepStrictEqual(payloads(), [true, false]);
        });
    });

    it('delays both edges when asked to', function () {
        withFakeTimers((fire) => {
            const { update, payloads } = makeEvent({ delay: true, delayValue: CLOCK,
                                                     delayOnTrue: true, delayOnFalse: true });
            update(30, undefined);
            assert.deepStrictEqual(payloads(), []);
            fire();
            assert.deepStrictEqual(payloads(), [true]);

            update(10, 30);
            assert.deepStrictEqual(payloads(), [true]);
            fire();
            assert.deepStrictEqual(payloads(), [true, false]);
        });
    });

    it('drops a queued false when the rule comes back before it lands', function () {
        // The mirror of the true case, and the reason a pending edge has to remember its
        // direction rather than merely existing.
        withFakeTimers((fire, pending) => {
            const { update, payloads } = makeEvent({ delay: true, delayValue: CLOCK,
                                                     delayOnTrue: false, delayOnFalse: true });
            update(30, undefined);
            assert.deepStrictEqual(payloads(), [true]);

            update(10, 30);                     // queued false
            assert.strictEqual(pending(), 1);
            update(31, 10);                     // back above before it lands
            assert.strictEqual(pending(), 0);

            fire();
            assert.deepStrictEqual(payloads(), [true], 'still true, and it never said otherwise');
        });
    });

    it('delays both edges when neither box says otherwise', function () {
        // The default, so a ticked "Delay event" always does something. Reaching the do-nothing
        // configuration takes two deliberate clicks rather than one oversight.
        withFakeTimers((fire) => {
            const { update, payloads } = makeEvent({ delay: true, delayValue: CLOCK });
            update(30, undefined);
            assert.deepStrictEqual(payloads(), [], 'true waits');
            fire();
            update(10, 30);
            assert.deepStrictEqual(payloads(), [true], 'and so does false');
            fire();
            assert.deepStrictEqual(payloads(), [true, false]);
        });
    });
});

describe('core/event.js — always is not a level', function () {
    // always cannot stop holding, so there is no edge to report. It keeps the node's ordinary
    // firing discipline instead: one true per event the change setting lets through.
    const drive = (cfg) => {
        const h = makeEvent(cfg);
        h.update(1, undefined);
        h.update(2, 1);
        h.update(3, 2);
        return h.payloads();
    };

    it('sends true on every event, and never a false', function () {
        assert.deepStrictEqual(drive({ operator: 'always', outputType: 'trigger' }),
            [true, true, true]);
    });

    it('produces exactly what the boolean output type produces', function () {
        assert.deepStrictEqual(
            drive({ operator: 'always', outputType: 'trigger' }),
            drive({ operator: 'always', outputType: 'bool', outputValue: 'true' }));
    });

    it('keeps its rate limit, being an ordinary trigger', function () {
        withFakeTimers(() => {
            const h = makeEvent({ operator: 'always', outputType: 'trigger',
                                  ratelimit: true, rate: '1', rateUnits: 'hour' });
            h.update(1, undefined);
            h.update(2, 1);
            assert.deepStrictEqual(h.payloads(), [true], 'the second is inside the window');
        });
    });
});

describe('core/event.js — the change setting', function () {
    it('"on change (ignore initial value)" skips the initial value AND unchanged updates', function () {
        // It used to skip only the initial value and then fire on every update, which is neither
        // what it is called nor what the option beside it does.
        const { update, payloads } = makeEvent({ change: '2', operator: 'always', outputType: 'bool',
                                                 outputValue: 'true' });

        update(20, undefined);          // initial — skipped
        update(20, 20);                 // unchanged — skipped
        update(21, 20);                 // changed
        update(21, 21);                 // unchanged — skipped

        assert.deepStrictEqual(payloads(), [true]);
    });

    it('"on change" is unaffected', function () {
        const { update, payloads } = makeEvent({ change: '1', operator: 'always', outputType: 'bool',
                                                 outputValue: 'true' });
        update(20, undefined);
        update(20, 20);
        update(21, 20);
        assert.deepStrictEqual(payloads(), [true, true], 'the initial value still counts');
    });
});

describe('core/event.js — the range trigger', function () {
    const band = (extra) => makeEvent(Object.assign({
        operator: 'range', compareValue: '20', compareHigh: '24', compareType: 'num'
    }, extra));

    it('is a level: in the band and out of it', function () {
        const { update, payloads } = band({});
        update(18, undefined);
        update(22, 18);                 // enters the band
        update(23, 22);                 // still inside
        update(30, 23);                 // leaves it the other way
        assert.deepStrictEqual(payloads(), [false, true, false]);
    });

    it('includes both ends', function () {
        const { update, payloads } = band({});
        update(20, undefined);
        assert.deepStrictEqual(payloads(), [true], '20 is in 20–24');
        update(24, 20);
        assert.deepStrictEqual(payloads(), [true], 'and so is 24, unchanged');
        update(24.1, 24);
        assert.deepStrictEqual(payloads(), [true, false]);
    });

    it('does not mind which bound was typed first', function () {
        const { update, payloads } = band({ compareValue: '24', compareHigh: '20' });
        update(22, undefined);
        assert.deepStrictEqual(payloads(), [true]);
    });

    it('stays quiet when the upper bound is missing', function () {
        // A half-filled rule must not read as "everything above 20".
        const { update, payloads } = band({ compareHigh: '' });
        update(22, undefined);
        update(100, 22);
        assert.deepStrictEqual(payloads(), [false]);
    });

    it('works as an edge trigger too, for the older output types', function () {
        const { update, payloads } = band({ outputType: 'str', outputValue: 'comfy' });
        update(22, undefined);          // in
        update(23, 22);                 // still in — an edge output fires on every match
        update(30, 23);                 // out — nothing
        assert.deepStrictEqual(payloads(), ['comfy', 'comfy']);
    });
});

describe('core/event.js — the other output types are untouched', function () {
    it('event msg still forwards the event, on every match', function () {
        const { update, sent } = makeEvent({ outputType: 'state' });
        update(30, undefined);
        update(31, 30);
        assert.strictEqual(sent.length, 2);
        assert.strictEqual(sent[0].state, 30);
        assert.strictEqual(sent[1].state, 31);
    });

    it('a string output still fires once per match', function () {
        const { update, payloads } = makeEvent({ outputType: 'str', outputValue: 'hot' });
        update(30, undefined);
        update(10, 30);                 // no match — nothing
        update(31, 10);
        assert.deepStrictEqual(payloads(), ['hot', 'hot']);
    });
});

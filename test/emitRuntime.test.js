'use strict';
// core/emit.js needs a Node-RED runtime, so it is loaded against a stub RED rather than required
// for its exports — the same approach test/eventRuntime.test.js and test/thingRuntime.test.js take.
// The node's whole job is (a) which channels it subscribes to, given its filter rows, and (b) what
// envelope it sends for a given raw update — so the assertions are about those two things: the
// `subscribe` calls the stub EventHandler records, and what `node.send` was called with when
// `node.listener` is driven with a synthetic update.

const assert = require('node:assert');
const path = require('node:path');

const EMIT = path.join(__dirname, '..', 'core', 'emit.js');

// Builds an Emit node against a small fake registry. `nodesById` resolves RED.nodes.getNode;
// `configNodes` is what RED.nodes.eachNode walks (the raw hal2Thing config objects the "All
// things"/"HA type" rows enumerate to find every ThingType in play).
function makeEmit(config, registry) {
    registry = registry || {};
    const sent = [];
    const subs = [];
    const unsubs = [];

    const eventHandler = Object.assign({
        id: 'eh1',
        locationName: '',
        groups: []
    }, registry.eventHandler);
    eventHandler.subscribe   = (event, id) => subs.push(event + '_' + id);
    eventHandler.unsubscribe = (event, id) => unsubs.push(event + '_' + id);

    const nodesById = Object.assign({ eh1: eventHandler }, registry.nodesById);
    const configNodes = registry.configNodes || [];

    let registered = null;
    let onClose = () => {};
    const RED = {
        nodes: {
            createNode(node, cfg) {
                node.id = cfg.id || 'emit1';
                node.on = (event, fn) => { if (event === 'close') { onClose = fn; } };
                node.send = m => { sent.push(m); };
            },
            getNode: id => nodesById[id],
            eachNode: cb => configNodes.forEach(cb),
            registerType: (name, fn) => { registered = fn; }
        }
    };

    delete require.cache[require.resolve(EMIT)];
    require(EMIT)(RED);

    const node = {};
    registered.call(node, Object.assign({ id: 'emit1', eventHandler: 'eh1', filters: [] }, config));

    return { node, sent, subs, unsubs, eventHandler, close: () => onClose() };
}

// One ThingType ('tt1') with two items, one Thing ('t1') of that type belonging to 'eh1'.
function lampRegistry(overrides) {
    const thingType = { id: 'tt1', items: [
        { id: '1', name: 'Heartbeat', haType: 'binary_sensor' },
        { id: '2', name: 'Brightness', haType: 'dimmer' }
    ] };
    const eventHandlerRef = { id: 'eh1' };
    const thing = { id: 't1', thingType, eventHandler: eventHandlerRef };
    return Object.assign({
        nodesById: { t1: thing },
        configNodes: [ { id: 't1', type: 'hal2Thing' } ]
    }, overrides);
}

function thingEvent(overrides) {
    return Object.assign({
        _msgid: 'm1',
        state: 10, laststate: 5,
        thing: { name: 'Lamp', id: 't1', room: 'Kitchen' },
        item:  { name: 'Brightness', id: '2', last_change: 1700000000000 },
        logtype: 'ingress'
    }, overrides);
}

function groupEvent(overrides) {
    return Object.assign({
        _msgid: 'g1',
        state: true, laststate: false,
        group: { id: 'grp1', name: 'Lights', last_change: 1700000000000 }
    }, overrides);
}

describe('core/emit.js — envelope shape', function () {
    it('builds a Thing/Item envelope with v, type, boot, seq, ts, thing, item, new/old, last_change, origin', function () {
        const { node, sent } = makeEmit(
            { filters: [{ scope: 'all', target: '', item: '', mode: 'update' }] },
            lampRegistry()
        );

        node.listener('tt1', 't1', '2', thingEvent());

        assert.strictEqual(sent.length, 1);
        const env = sent[0].payload;
        assert.strictEqual(env.v, 1);
        assert.strictEqual(env.type, 'event');
        assert.strictEqual(env.boot, node.boot);
        assert.strictEqual(typeof env.boot, 'number');
        assert.strictEqual(env.seq, 1);
        assert.strictEqual(typeof env.ts, 'number');
        assert.deepStrictEqual(env.thing, { id: 't1', name: 'Lamp', room: 'Kitchen' });
        assert.deepStrictEqual(env.item,  { id: '2', name: 'Brightness', ha_type: 'dimmer' });
        assert.strictEqual(env.new, 10);
        assert.strictEqual(env.old, 5);
        assert.strictEqual(env.last_change, 1700000000000);
        assert.strictEqual(env.origin, 'ingress');
        assert.strictEqual(env.group, undefined);
        assert.strictEqual(env.site, undefined);
    });

    it('omits room when the thing has none, and increments seq across sends', function () {
        const { node, sent } = makeEmit(
            { filters: [{ scope: 'all', target: '', item: '', mode: 'update' }] },
            lampRegistry()
        );

        node.listener('tt1', 't1', '2', thingEvent({ thing: { name: 'Lamp', id: 't1' }, _msgid: 'a' }));
        node.listener('tt1', 't1', '2', thingEvent({ _msgid: 'b', state: 20, laststate: 10 }));

        assert.strictEqual(sent.length, 2);
        assert.ok(!('room' in sent[0].payload.thing));
        assert.strictEqual(sent[0].payload.seq, 1);
        assert.strictEqual(sent[1].payload.seq, 2);
    });

    it('includes site only when the Event handler has a Location set', function () {
        const withSite = makeEmit(
            { filters: [{ scope: 'all', target: '', item: '', mode: 'update' }] },
            lampRegistry({ eventHandler: { locationName: 'Hemma' } })
        );
        withSite.node.listener('tt1', 't1', '2', thingEvent());
        assert.strictEqual(withSite.sent[0].payload.site, 'Hemma');

        const noSite = makeEmit(
            { filters: [{ scope: 'all', target: '', item: '', mode: 'update' }] },
            lampRegistry()
        );
        noSite.node.listener('tt1', 't1', '2', thingEvent());
        assert.ok(!('site' in noSite.sent[0].payload));
    });

    it('builds a group envelope with group.ha_type instead of thing/item', function () {
        const { node, sent } = makeEmit(
            { filters: [{ scope: 'group', target: 'grp1', item: '', mode: 'update' }] },
            { eventHandler: { groups: [{ id: 'grp1', name: 'Lights', haType: 'light', aggregate: 'any' }] } }
        );

        node.listener(null, 'grp1', 'grp1', groupEvent());

        assert.strictEqual(sent.length, 1);
        const env = sent[0].payload;
        assert.deepStrictEqual(env.group, { id: 'grp1', name: 'Lights', ha_type: 'light' });
        assert.strictEqual(env.thing, undefined);
        assert.strictEqual(env.item, undefined);
        assert.strictEqual(env.origin, undefined);
    });
});

describe('core/emit.js — filter matching', function () {
    it('"on change" drops an update whose value did not move', function () {
        const { node, sent } = makeEmit(
            { filters: [{ scope: 'all', target: '', item: '', mode: 'change' }] },
            lampRegistry()
        );

        node.listener('tt1', 't1', '2', thingEvent({ state: 10, laststate: 10, _msgid: 'same' }));
        node.listener('tt1', 't1', '2', thingEvent({ state: 11, laststate: 10, _msgid: 'diff' }));

        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].payload.new, 11);
    });

    it('a "thing" row narrowed to one item ignores the other item on the same thing', function () {
        const { node, sent } = makeEmit(
            { filters: [{ scope: 'thing', target: 't1', item: '2', mode: 'update' }] },
            lampRegistry()
        );

        node.listener('tt1', 't1', '1', thingEvent({ item: { name: 'Heartbeat', id: '1' }, _msgid: 'hb' }));
        node.listener('tt1', 't1', '2', thingEvent({ _msgid: 'br' }));

        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].payload.item.id, '2');
    });

    it('a "hatype" row matches an item by resolved ha_type regardless of which thing it is on', function () {
        const { node, sent } = makeEmit(
            { filters: [{ scope: 'hatype', target: 'dimmer', item: '', mode: 'update' }] },
            lampRegistry()
        );

        node.listener('tt1', 't1', '1', thingEvent({ item: { name: 'Heartbeat', id: '1' }, _msgid: 'hb' }));
        node.listener('tt1', 't1', '2', thingEvent({ _msgid: 'br' }));

        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].payload.item.ha_type, 'dimmer');
    });

    it('never sends the same underlying update twice, even when two rows both match it', function () {
        const { node, sent } = makeEmit(
            { filters: [
                { scope: 'all',   target: '',   item: '', mode: 'update' },
                { scope: 'thing', target: 't1', item: '', mode: 'update' }
            ] },
            lampRegistry()
        );

        // publishUpdate emits the thingtype channel and the thing channel synchronously for the
        // same eventmsg — both rows above would match, so this call stands in for the second,
        // same-_msgid invocation that channel would also trigger.
        const ev = thingEvent();
        node.listener('tt1', 't1', '2', ev);
        node.listener('tt1', 't1', '2', ev);

        assert.strictEqual(sent.length, 1);
    });
});

describe('core/emit.js — channel resolution', function () {
    it('"all" subscribes to every ThingType channel this Event handler\'s Things use', function () {
        const { subs } = makeEmit(
            { filters: [{ scope: 'all', target: '', item: '', mode: 'update' }] },
            lampRegistry()
        );
        assert.deepStrictEqual(subs, ['update_tt1']);
    });

    it('"hatype" resolves to the same ThingType channels as "all", not a dedicated one', function () {
        const { subs } = makeEmit(
            { filters: [{ scope: 'hatype', target: 'dimmer', item: '', mode: 'update' }] },
            lampRegistry()
        );
        assert.deepStrictEqual(subs, ['update_tt1']);
    });

    it('"thing" and "thingtype" subscribe to the id on the row', function () {
        const a = makeEmit({ filters: [{ scope: 'thing', target: 't1', item: '', mode: 'update' }] }, lampRegistry());
        assert.deepStrictEqual(a.subs, ['update_t1']);

        const b = makeEmit({ filters: [{ scope: 'thingtype', target: 'tt1', item: '', mode: 'update' }] }, lampRegistry());
        assert.deepStrictEqual(b.subs, ['update_tt1']);
    });

    it('"group" subscribes to the one group picked, not any other', function () {
        const registry = { eventHandler: { groups: [
            { id: 'grp1', name: 'Lights', haType: 'light', aggregate: 'any' },
            { id: 'grp2', name: 'Scene',  haType: 'other', aggregate: '' }
        ] } };

        const one = makeEmit({ filters: [{ scope: 'group', target: 'grp2', item: '', mode: 'update' }] }, registry);
        assert.deepStrictEqual(one.subs, ['update_grp2']);
    });

    it('unsubscribes every channel it subscribed to, on close', function () {
        const { subs, unsubs, close } = makeEmit(
            { filters: [
                { scope: 'thing', target: 't1', item: '', mode: 'update' },
                { scope: 'thingtype', target: 'tt1', item: '', mode: 'update' }
            ] },
            lampRegistry()
        );
        assert.deepStrictEqual(subs.sort(), ['update_t1', 'update_tt1']);
        close();
        assert.deepStrictEqual(unsubs.sort(), ['update_t1', 'update_tt1']);
    });
});

describe('core/emit.js — msg.topic', function () {
    it('fills the default template from site/room/thing/item', function () {
        const { node, sent } = makeEmit(
            { filters: [{ scope: 'all', target: '', item: '', mode: 'update' }] },
            lampRegistry({ eventHandler: { locationName: 'Hemma' } })
        );
        node.listener('tt1', 't1', '2', thingEvent());
        assert.strictEqual(sent[0].topic, 'hal2/hemma/event/kitchen/lamp/brightness');
    });

    it('placeholders a missing segment with "_" instead of collapsing it, keeping topic depth constant', function () {
        const { node, sent } = makeEmit(
            { filters: [{ scope: 'all', target: '', item: '', mode: 'update' }] },
            lampRegistry() // no locationName -> site is unset; thing below has no room
        );
        node.listener('tt1', 't1', '2', thingEvent({ thing: { name: 'Lamp', id: 't1' } }));
        assert.strictEqual(sent[0].topic, 'hal2/_/event/_/lamp/brightness');
    });

    it('strips /, + and # and collapses whitespace runs, so a name cannot fork the topic or smuggle a wildcard', function () {
        const { node, sent } = makeEmit(
            { filters: [{ scope: 'all', target: '', item: '', mode: 'update' }] },
            lampRegistry()
        );
        node.listener('tt1', 't1', '2', thingEvent({
            thing: { name: 'A/V  receiver #2 + extra', id: 't1', room: 'Vardags  rum' }
        }));
        assert.strictEqual(sent[0].topic, 'hal2/_/event/vardags_rum/a_v_receiver_2_extra/brightness');
    });

    it('uses the group name and ha_type for <thing>/<item> on a group event', function () {
        const { node, sent } = makeEmit(
            { filters: [{ scope: 'group', target: 'grp1', item: '', mode: 'update' }] },
            { eventHandler: { locationName: 'Hemma', groups: [{ id: 'grp1', name: 'Lights', haType: 'light', aggregate: 'any' }] } }
        );
        node.listener(null, 'grp1', 'grp1', groupEvent());
        assert.strictEqual(sent[0].topic, 'hal2/hemma/event/_/lights/light');
    });

    it('honours a custom topic template, tokens in any order or repeated', function () {
        const { node, sent } = makeEmit(
            {
                topic: '<thing>-<item>/<thing>',
                filters: [{ scope: 'all', target: '', item: '', mode: 'update' }]
            },
            lampRegistry()
        );
        node.listener('tt1', 't1', '2', thingEvent());
        assert.strictEqual(sent[0].topic, 'lamp-brightness/lamp');
    });

    it('lowercases the whole topic, including the static parts of a custom template', function () {
        const { node, sent } = makeEmit(
            {
                topic: 'HAL2/EVENT/<thing>',
                filters: [{ scope: 'all', target: '', item: '', mode: 'update' }]
            },
            lampRegistry()
        );
        node.listener('tt1', 't1', '2', thingEvent({ thing: { name: 'KÖKSLAMPA', id: 't1' } }));
        assert.strictEqual(sent[0].topic, 'hal2/event/kökslampa');
    });

    it('sets no msg.topic at all when the field was cleared to empty, rather than falling back to the default', function () {
        // The editor prefills new nodes with the default template, so an empty string only
        // happens when the user deliberately cleared it — that has to mean "no topic", not
        // "same as never having set one".
        const { node, sent } = makeEmit(
            { topic: '', filters: [{ scope: 'all', target: '', item: '', mode: 'update' }] },
            lampRegistry()
        );
        node.listener('tt1', 't1', '2', thingEvent());
        assert.strictEqual(sent.length, 1);
        assert.ok(!('topic' in sent[0]));
        assert.ok(sent[0].payload);
    });

    it('falls back to the default template when the field was never set at all (predates this config)', function () {
        const { node, sent } = makeEmit(
            { filters: [{ scope: 'all', target: '', item: '', mode: 'update' }] }, // no `topic` key
            lampRegistry()
        );
        node.listener('tt1', 't1', '2', thingEvent());
        assert.strictEqual(sent[0].topic, 'hal2/_/event/kitchen/lamp/brightness');
    });
});

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
const { halNumericOperator, halGroupAccepts, halHaTypeFamily,
        halGroupPolicy, halGroupCapabilityRefusal, halDuplicateNames } = sandbox;

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

describe('hal.js halThingLabel', function () {
    const { halThingLabel, halGetRooms } = sandbox;
    const RED = {
        nodes: {
            node: id => (id === 'eh1' ? { rooms: [{ id: 'r2', name: 'Sovrum' }, { id: 'r1', name: 'Kontor' }] } : null),
            eachConfig: () => {}, filterNodes: () => []
        }
    };

    it('writes [Room] Name, so the string reads as assembled rather than typed', function () {
        assert.strictEqual(
            halThingLabel(RED, { name: 'Taklampa', room: 'r1', eventHandler: 'eh1' }),
            '[Kontor] Taklampa');
    });

    it('leaves a thing with no room exactly as it was', function () {
        // A scene is nowhere, and nothing about it should look unfinished.
        assert.strictEqual(halThingLabel(RED, { name: 'Scen Natt', eventHandler: 'eh1' }), 'Scen Natt');
    });

    it('falls back to the bare name when the room id no longer resolves', function () {
        assert.strictEqual(halThingLabel(RED, { name: 'X', room: 'deleted', eventHandler: 'eh1' }), 'X');
    });

    it('does not write the label onto the node it was given', function () {
        // halGetThings hands out live editor nodes; composing into .name would rename the device.
        const thing = { name: 'Taklampa', room: 'r1', eventHandler: 'eh1' };
        halThingLabel(RED, thing);
        assert.deepStrictEqual(thing, { name: 'Taklampa', room: 'r1', eventHandler: 'eh1' });
    });

    it('keeps the registry order, because the list is sortable in the editor', function () {
        // Sorting here would discard the arrangement every time it was read, which is the one
        // thing a sortable list must not do.
        assert.deepStrictEqual(halGetRooms(RED, 'eh1').map(r => r.name), ['Sovrum', 'Kontor']);
    });
});

describe('hal.js halGroupPolicy', function () {
    // The no-migration guarantee, and the only thing standing between this feature and every
    // group in an existing flow quietly starting to refuse members. `undefined` must read the
    // same as `true`, so a group saved before the field existed keeps accepting what it did.
    const p = g => ({ ...halGroupPolicy(g) });

    it('reads an absent flag as ticked, so an older group accepts what it always did', function () {
        assert.deepStrictEqual(p({ id: 'g1', name: 'Alla lampor' }), { state: true, command: true });
    });

    it('is indistinguishable from an explicit true', function () {
        assert.deepStrictEqual(p({ acceptsState: true, acceptsCommand: true }),
                               p({}));
    });

    it('takes something away only for an explicit false', function () {
        assert.deepStrictEqual(p({ acceptsState: false, acceptsCommand: true }), { state: false, command: true });
        assert.deepStrictEqual(p({ acceptsState: true, acceptsCommand: false }), { state: true, command: false });
        assert.deepStrictEqual(p({ acceptsState: false, acceptsCommand: false }), { state: false, command: false });
    });

    it('treats a missing group as permissive rather than throwing', function () {
        // The picker reaches here with whatever the registry holds, including nothing.
        assert.deepStrictEqual(p(undefined), { state: true, command: true });
        assert.deepStrictEqual(p(null), { state: true, command: true });
    });
});

describe('hal.js halGroupCapabilityRefusal', function () {
    // The full cross-product, because the interesting cases are the asymmetric ones and there is
    // no reading of the table that makes them obvious. Each item.type the ThingType editor can
    // produce, against each of the four policies.
    const ITEM = {
        both:             { id: 'i', type: 'both' },
        status:           { id: 'i', type: 'status' },
        command:          { id: 'i', type: 'command' },
        loopback_both:    { id: 'i', type: 'loopback_both' },
        loopback_command: { id: 'i', type: 'loopback_command' },
        heartbeat:        { id: '1', type: 'status' }
    };
    const POLICY = {
        open:       {},                                                   // both ticked: today
        stateOnly:  { acceptsCommand: false },
        commandOnly:{ acceptsState: false },
        closed:     { acceptsState: false, acceptsCommand: false }
    };
    const admits = (pol, item) => halGroupCapabilityRefusal(POLICY[pol], ITEM[item]) === '';

    it('admits everything while both flags are ticked — the default is today', function () {
        for (const item of Object.keys(ITEM)) {
            assert.ok(admits('open', item), item + ' should be admitted by an open group');
        }
    });

    it('lets a state-only group take reporters and refuse a pure command item', function () {
        assert.ok(admits('stateOnly', 'status'));
        assert.ok(admits('stateOnly', 'both'));
        assert.ok(!admits('stateOnly', 'command'));
        assert.ok(!admits('stateOnly', 'loopback_command'));
    });

    it('lets a command-only group refuse the item that caused all this', function () {
        // A Color Light's On item reports and takes no commands. A group declared for commands
        // is exactly where it must not silently land.
        assert.ok(!admits('commandOnly', 'status'));
        assert.ok(admits('commandOnly', 'command'));
        assert.ok(admits('commandOnly', 'loopback_command'));
    });

    it('admits an item that does both under either flag alone', function () {
        // It can serve as the group's reading or as its target, so a group wanting one of those
        // still has a use for it. Refusing it would make a command group unable to hold an
        // ordinary switch.
        for (const pol of ['stateOnly', 'commandOnly']) {
            assert.ok(admits(pol, 'both'), 'both under ' + pol);
            assert.ok(admits(pol, 'loopback_both'), 'loopback_both under ' + pol);
        }
    });

    it('counts a loopback command as a command', function () {
        assert.ok(admits('commandOnly', 'loopback_command'));
        assert.strictEqual(halGroupCapabilityRefusal(POLICY.stateOnly, ITEM.loopback_command),
                           'command only');
    });

    it('counts the heartbeat item as reporting whatever its type says', function () {
        // Item '1' carries state by definition. It cannot be added from the editor any more, but
        // memberships predating that rule are still out there and must not be misreported.
        assert.ok(admits('stateOnly', 'heartbeat'));
        assert.ok(!admits('commandOnly', 'heartbeat'));
    });

    it('refuses everything when neither flag is ticked, and says that is the group', function () {
        for (const item of Object.keys(ITEM)) {
            assert.strictEqual(halGroupCapabilityRefusal(POLICY.closed, ITEM[item]),
                               'group accepts nothing', item);
        }
    });

    it('names the item, not the group, when the group still accepts something', function () {
        // The reason is shown on the Thing's row, where the actionable half is why this item
        // does not fit — the group's own flags are visible in its own row.
        assert.strictEqual(halGroupCapabilityRefusal(POLICY.commandOnly, ITEM.status), 'state only');
        assert.strictEqual(halGroupCapabilityRefusal(POLICY.stateOnly, ITEM.command), 'command only');
    });

    it('does not throw on a missing item, which is what the old predicates did', function () {
        // halStatusItem dereferences item.type without a guard; the picker can reach here with a
        // membership whose ThingType item has been deleted.
        assert.strictEqual(halGroupCapabilityRefusal(POLICY.open, undefined), 'neither state nor command');
    });

    it('admits an unrecognised type nowhere but an open group', function () {
        const odd = { id: 'i', type: 'something-new' };
        assert.strictEqual(halGroupCapabilityRefusal(POLICY.open, odd), 'neither state nor command');
    });
});

describe('hal.js halDuplicateNames', function () {
    // Rooms are matched by name, and that match is a plain equality with no ambiguity refusal —
    // unlike group names, where several matches come back as "Several groups match". So a
    // duplicate room name is not a nuisance, it is a silent merge: get_all_states(room:"Kontor")
    // would answer with both rooms' devices and nothing would say so.
    const dup = r => [...halDuplicateNames(r)].sort();
    const rooms = (...names) => names.map((name, i) => ({ id: 'r' + i, name }));

    it('finds nothing wrong with a registry of distinct names', function () {
        assert.deepStrictEqual(dup(rooms('Kontor', 'Kök', 'Hall', 'Sovrum')), []);
    });

    it('names the one that repeats', function () {
        assert.deepStrictEqual(dup(rooms('Kontor', 'Kök', 'Kontor')), ['kontor']);
    });

    it('compares the way the tools do — case-insensitively', function () {
        // get_all_states lowercases both sides before comparing, so these two rooms are one room
        // as far as every answer is concerned.
        assert.deepStrictEqual(dup(rooms('Kontor', 'kontor')), ['kontor']);
        assert.deepStrictEqual(dup(rooms('KONTOR', 'Kontor')), ['kontor']);
    });

    it('ignores surrounding whitespace, which the save trims away anyway', function () {
        assert.deepStrictEqual(dup(rooms('Kontor', ' Kontor ')), ['kontor']);
    });

    it('does not count unnamed rows against each other', function () {
        // Two blank rows in the editor are not two rooms with the same name; the save drops them.
        assert.deepStrictEqual(dup(rooms('', '', 'Kontor')), []);
        assert.deepStrictEqual(dup(rooms('  ', 'Kontor')), []);
    });

    it('reports each colliding name once, however many rows share it', function () {
        assert.deepStrictEqual(dup(rooms('Kontor', 'Kontor', 'Kontor')), ['kontor']);
    });

    it('reports every distinct collision', function () {
        assert.deepStrictEqual(dup(rooms('Kontor', 'Kök', 'Kontor', 'kök')), ['kontor', 'kök']);
    });

    it('survives an empty list, a missing one, and a row with no name at all', function () {
        assert.deepStrictEqual(dup([]), []);
        assert.deepStrictEqual(dup(undefined), []);
        assert.deepStrictEqual(dup([{ id: 'r1' }, { id: 'r2' }, null]), []);
    });
});

describe('hal.js halGetThings ordering', function () {
    const { halGetThings } = sandbox;

    // Two rooms, and names chosen so that ordering by the bare name and ordering by the label
    // disagree: by name it is Alfa, Bravo, Charlie; by label it is [Attic] Bravo, [Attic] Charlie,
    // [Zone] Alfa. Deliberately ASCII — localeCompare follows the runtime locale, so asserting
    // where å sorts would test the test runner's ICU data rather than this function.
    const THINGS = [
        { id: 't1', name: 'Alfa',    room: 'r2', thingType: 'tt', eventHandler: 'eh' },
        { id: 't2', name: 'Charlie', room: 'r1', thingType: 'tt', eventHandler: 'eh' },
        { id: 't3', name: 'Bravo',   room: 'r1', thingType: 'tt', eventHandler: 'eh' }
    ];
    const ROOMS = [{ id: 'r1', name: 'Attic' }, { id: 'r2', name: 'Zone' }];

    const redFor = things => ({
        nodes: {
            filterNodes: () => things,
            node: id => (id === 'eh' ? { rooms: ROOMS } : { thingCommand: true, thingStatus: true }),
            eachConfig: () => {}
        }
    });
    // Spread out of the sandbox realm before comparing: an array built in there carries that
    // context's Array.prototype, and deepStrictEqual compares prototypes.
    const order = things => [...halGetThings(redFor(things))].map(t => t.name);

    it('orders by the label the dropdown shows, so rooms come out together', function () {
        // The bug this guards: the list was sorted on the bare name while displaying the label,
        // which put the rooms in an order with no visible logic.
        assert.deepStrictEqual(order(THINGS), ['Bravo', 'Charlie', 'Alfa']);
    });

    it('is not merely the old name order', function () {
        // Fails if someone reverts to sorting on .name — that would give Alfa, Bravo, Charlie.
        assert.notDeepStrictEqual(order(THINGS), ['Alfa', 'Bravo', 'Charlie']);
    });

    it('still ignores case, as the uppercase comparison it replaced did', function () {
        const mixed = [
            { id: 'a', name: 'beta',  thingType: 'tt', eventHandler: 'eh' },
            { id: 'b', name: 'Alpha', thingType: 'tt', eventHandler: 'eh' }
        ];
        assert.deepStrictEqual(order(mixed), ['Alpha', 'beta']);
    });

    it('sorts a thing with no room by its bare name, without dropping it', function () {
        // A scene has no room and still has to appear in the list.
        const mixed = THINGS.concat([
            { id: 't4', name: 'Scene Night', thingType: 'tt', eventHandler: 'eh' }
        ]);
        assert.strictEqual(order(mixed).length, 4);
        assert.ok(order(mixed).includes('Scene Night'));
    });

    it('keeps a thing whose room id no longer resolves', function () {
        // Deleting a room must not delete the Thing from every dropdown in the flow.
        const stale = [{ id: 't9', name: 'Orphan', room: 'gone', thingType: 'tt', eventHandler: 'eh' }];
        assert.deepStrictEqual(order(stale), ['Orphan']);
    });

    it('survives an empty registry', function () {
        assert.deepStrictEqual(order([]), []);
    });
});

'use strict';

const assert = require('node:assert');
const {
    MCP_TOOLS, MCP_TOOLS_ADMIN, MCP_ADMIN_TOOL_NAMES,
    MCP_READ_TOOL_NAMES, MCP_WRITE_TOOL_NAMES, toolClass, expandHaTypeFilter
} = require('../core/mcp-tools');

describe('core/mcp-tools catalog', function () {
    it('every tool has a name, description and object inputSchema', function () {
        for (const t of [...MCP_TOOLS, ...MCP_TOOLS_ADMIN]) {
            assert.ok(t.name && typeof t.name === 'string', 'missing name');
            assert.ok(t.description && typeof t.description === 'string', t.name + ' missing description');
            assert.ok(t.inputSchema && t.inputSchema.type === 'object', t.name + ' bad inputSchema');
        }
    });

    it('has no duplicate tool names', function () {
        const names = [...MCP_TOOLS, ...MCP_TOOLS_ADMIN].map(t => t.name);
        assert.strictEqual(names.length, new Set(names).size, 'duplicate tool name');
    });

    it('admin tool names set matches the admin tool list', function () {
        assert.strictEqual(MCP_ADMIN_TOOL_NAMES.size, MCP_TOOLS_ADMIN.length);
        for (const t of MCP_TOOLS_ADMIN) {
            assert.ok(MCP_ADMIN_TOOL_NAMES.has(t.name), t.name + ' not in admin set');
        }
    });

    it('admin tools are not also listed as regular tools', function () {
        const regular = new Set(MCP_TOOLS.map(t => t.name));
        for (const t of MCP_TOOLS_ADMIN) {
            assert.ok(!regular.has(t.name), t.name + ' is both admin and regular');
        }
    });

    it('every catalog tool is classified as read or write', function () {
        // The guard that matters: adding a tool to MCP_TOOLS without classifying it fails
        // here rather than silently landing on whichever gate happens to catch it.
        const missing = MCP_TOOLS.map(t => t.name)
            .filter(n => !MCP_READ_TOOL_NAMES.has(n) && !MCP_WRITE_TOOL_NAMES.has(n));
        assert.deepStrictEqual(missing, [], 'unclassified: ' + missing.join(', '));
    });

    it('the three classes are disjoint', function () {
        for (const n of MCP_READ_TOOL_NAMES) {
            assert.ok(!MCP_WRITE_TOOL_NAMES.has(n), n + ' is both read and write');
            assert.ok(!MCP_ADMIN_TOOL_NAMES.has(n), n + ' is both read and admin');
        }
        for (const n of MCP_WRITE_TOOL_NAMES) {
            assert.ok(!MCP_ADMIN_TOOL_NAMES.has(n), n + ' is both write and admin');
        }
    });

    it('classifies control_light as a write, though it is not in the catalog', function () {
        // An undocumented alias of set_light that the dispatcher accepts. Omitting it would
        // let a read-only token switch lights.
        assert.ok(!MCP_TOOLS.some(t => t.name === 'control_light'));
        assert.strictEqual(toolClass('control_light'), 'write');
        assert.strictEqual(toolClass('set_light'), 'write');
    });

    it('toolClass fails closed for anything it does not know', function () {
        assert.strictEqual(toolClass('some_future_tool'), 'write');
        assert.strictEqual(toolClass(''), 'write');
        assert.strictEqual(toolClass('get_state'), 'read');
        assert.strictEqual(toolClass('deploy_flow'), 'admin');
    });

    it('expandHaTypeFilter returns a Set that always contains the input key', function () {
        const out = expandHaTypeFilter('light');
        assert.ok(out instanceof Set);
        assert.ok(out.has('light'));
    });
});

describe('device_class — what an item drives', function () {
    const {
        deviceClassFromHaType, effectiveDeviceClass, deriveCategories,
        itemMatchesHaTypeFilter, lightTargets, DEVICE_CLASSES
    } = require('../core/mcp-tools');

    it('derives a class only where the ha_type settles the question', function () {
        assert.strictEqual(deviceClassFromHaType('dimmer'), 'light');
        assert.strictEqual(deviceClassFromHaType('cover'), 'cover');
        // The whole reason the feature exists: a switch could be driving anything.
        assert.strictEqual(deviceClassFromHaType('switch'), '');
        assert.strictEqual(deviceClassFromHaType(undefined), '');
    });

    it('lets a declaration win over the ha_type', function () {
        assert.strictEqual(effectiveDeviceClass({ ha_type: 'switch', device_class: 'light' }), 'light');
        assert.strictEqual(effectiveDeviceClass({ ha_type: 'dimmer' }), 'light');
        assert.strictEqual(effectiveDeviceClass({ ha_type: 'switch' }), '');
    });

    it('offers appliance and outlet so a plug can say what it is instead of staying silent', function () {
        assert.ok(DEVICE_CLASSES.includes('appliance'));
        assert.ok(DEVICE_CLASSES.includes('outlet'));
        // Both are categories in their own right, with no ha_type implying them, so that the set
        // is findable — "turn off all the outlets" needs more than each member being classified.
        assert.deepStrictEqual(
            deriveCategories([{ ha_type: 'switch', device_class: 'appliance' }]), ['appliance']);
        assert.deepStrictEqual(
            deriveCategories([{ ha_type: 'switch', device_class: 'outlet' }]), ['outlet']);
    });

    it('keeps a declared appliance or outlet out of the lights', function () {
        const { writesOnOff } = require('../core/mcp-tools');
        for (const c of ['appliance', 'outlet']) {
            const item = { ha_type: 'switch', device_class: c };
            assert.ok(!writesOnOff(item), `set_light must not switch a declared ${c}`);
            assert.ok(!deriveCategories([item]).includes('light'));
        }
    });

    describe('categories', function () {
        it('gives a relay-driven lamp the light category', function () {
            assert.deepStrictEqual(
                deriveCategories([{ ha_type: 'switch', device_class: 'light' }]), ['light']);
        });

        it('leaves the coffee machine out of the lights', function () {
            assert.deepStrictEqual(deriveCategories([{ ha_type: 'switch' }]), []);
        });

        it('still derives from ha_type with nothing declared', function () {
            assert.deepStrictEqual(deriveCategories([{ ha_type: 'dimmer' }]), ['light']);
        });

        it('keeps the vocabulary order regardless of item order', function () {
            const a = deriveCategories([{ ha_type: 'cover' }, { ha_type: 'light' }]);
            const b = deriveCategories([{ ha_type: 'light' }, { ha_type: 'cover' }]);
            assert.deepStrictEqual(a, b, 'order must not depend on item order');
            assert.deepStrictEqual(a, ['light', 'cover']);
        });
    });

    describe('the ha_type filter', function () {
        const wanted = expandHaTypeFilter('light');

        it('matches a declared light behind a switch', function () {
            assert.ok(itemMatchesHaTypeFilter({ ha_type: 'switch', device_class: 'light' }, wanted));
        });

        it('does not match an undeclared switch', function () {
            assert.ok(!itemMatchesHaTypeFilter({ ha_type: 'switch' }, wanted));
        });

        it('still matches on ha_type alone', function () {
            assert.ok(itemMatchesHaTypeFilter({ ha_type: 'dimmer' }, wanted));
        });
    });

    describe('what set_light switches on and off', function () {
        const { writesOnOff } = require('../core/mcp-tools');
        // What the tool actually does: drop anything declared to be something else, then
        // command whatever is left that counts as a light.
        const onOffTargets = items => lightTargets(items).filter(writesOnOff).map(i => i.item_id);

        // The dual relay this feature was reported against: On1 drives a socket, On2 the
        // ceiling lamp, and both are plain switches on the same Thing.
        const relay = [
            { item_id: 'on1', ha_type: 'switch' },
            { item_id: 'on2', ha_type: 'switch', device_class: 'light' }
        ];

        it('switches the declared lamp and leaves the socket alone', function () {
            assert.deepStrictEqual(onOffTargets(relay), ['on2'],
                'turning the light off must not cut the socket');
        });

        it('will not switch an undeclared switch — it could be driving anything', function () {
            // A plug on the coffee machine, named directly. Before device_class there was no way
            // to tell it from a lamp, and set_light wrote to it.
            assert.deepStrictEqual(onOffTargets([{ item_id: 'plug', ha_type: 'switch' }]), []);
        });

        it('will not switch one declared as something else', function () {
            assert.deepStrictEqual(
                onOffTargets([{ item_id: 'plug', ha_type: 'switch', device_class: 'appliance' }]), []);
        });

        it('still switches an ha_type light with nothing declared', function () {
            assert.deepStrictEqual(onOffTargets([{ item_id: 'on', ha_type: 'light' }]), ['on'],
                'a light needs nobody to say it is one');
        });

        it('leaves brightness and colour to their own branches', function () {
            const bulb = [
                { item_id: 'on', ha_type: 'light' },
                { item_id: 'bri', ha_type: 'dimmer' },
                { item_id: 'ct', ha_type: 'color temperature' }
            ];
            assert.deepStrictEqual(onOffTargets(bulb), ['on']);
            // …but they stay available for the brightness and colour commands.
            assert.deepStrictEqual(lightTargets(bulb).map(i => i.item_id), ['on', 'bri', 'ct']);
        });

        it('keeps an undeclared dimmer reachable on a Thing that has declarations', function () {
            const bulb = [
                { item_id: 'on', ha_type: 'switch', device_class: 'light' },
                { item_id: 'bri', ha_type: 'dimmer' }
            ];
            assert.deepStrictEqual(lightTargets(bulb).map(i => i.item_id), ['on', 'bri']);
        });
    });
});

describe('presenceIdentity — telling a phone from its owner', function () {
    const { presenceIdentity } = require('../core/mcp-tools');

    // The live shapes this was reported against.
    const PHONE = { notes: 'This is a device, not a person.  ', tags: ['device'] };
    const PHONE_ITEM = { notes: 'True while any node still hears the phone.', tags: [] };
    const PERSON = { notes: '', tags: ['person'] };
    const PERSON_ITEM = { notes: '', tags: [] };

    it('carries the thing tags that distinguish the two', function () {
        assert.deepStrictEqual(presenceIdentity(PHONE, PHONE_ITEM).tags, ['device']);
        assert.deepStrictEqual(presenceIdentity(PERSON, PERSON_ITEM).tags, ['person']);
    });

    it('carries the thing notes, which say what the entry is', function () {
        assert.strictEqual(presenceIdentity(PHONE, PHONE_ITEM).notes,
            'This is a device, not a person.');
    });

    it('keeps the item note apart, since it describes the item and not the entity', function () {
        // It comes from the shared ThingType, so it is identical for every phone and says nothing
        // about which entity this is. Forwarding it as the entry's notes — as this did — gave an
        // assistant a sentence about signal handling and nothing about it being a phone.
        const out = presenceIdentity(PHONE, PHONE_ITEM);
        assert.strictEqual(out.presence_item_notes, 'True while any node still hears the phone.');
        assert.notStrictEqual(out.notes, out.presence_item_notes);
    });

    it('unions the tags, since both label the same entry', function () {
        const out = presenceIdentity({ tags: ['person'] }, { tags: ['tracked', 'person'] });
        assert.deepStrictEqual(out.tags, ['person', 'tracked'], 'thing first, no duplicates');
    });

    it('omits what is empty rather than reporting blanks', function () {
        assert.deepStrictEqual(presenceIdentity({ notes: '   ', tags: [] }, { notes: '', tags: [] }), {});
        assert.deepStrictEqual(presenceIdentity(undefined, undefined), {});
    });
});

describe('TOOL_HARDWARE_REQUIREMENTS shape', function () {
    const { TOOL_HARDWARE_REQUIREMENTS: REQ, HA_TYPE_GROUPS } = require('../core/mcp-tools');

    // scripts/gen-api-docs.js reads these to write the "Requires hardware" line, and it is not
    // run by `npm test` — so when this table changed from an array of ha_types to
    // { haTypes, classes }, the generator crashed and nothing said so until someone tried to
    // rebuild the docs. This pins the shape the generator depends on.
    it('gives every tool a haTypes array and a classes array', function () {
        for (const [tool, req] of Object.entries(REQ)) {
            assert.ok(Array.isArray(req.haTypes), `${tool}.haTypes must be an array`);
            assert.ok(Array.isArray(req.classes), `${tool}.classes must be an array`);
            assert.ok(req.haTypes.length, `${tool} requires no ha_type at all`);
        }
    });

    it('requires only ha_types that some category actually uses', function () {
        const known = new Set(Object.values(HA_TYPE_GROUPS).flat().map(t => t.toLowerCase()));
        for (const [tool, req] of Object.entries(REQ)) {
            for (const t of req.haTypes) {
                assert.ok(known.has(t.toLowerCase()),
                    `${tool} requires "${t}", which belongs to no category`);
            }
        }
    });
});

describe('resolving a thing by name', function () {
    const { resolveByName, ambiguousThing } = require('../core/mcp-tools');

    // Two ceiling lamps that only their room tells apart — the case that makes a short name
    // possible at all, and the one the old resolvers answered by commanding both.
    const DEVICES = [
        { id: 'a', name: 'Taklampa', room: 'Kontor' },
        { id: 'b', name: 'Taklampa', room: 'Sovrum' },
        { id: 'c', name: 'Golvspot', room: 'Kontor' },
        { id: 'd', name: 'Scen Natt' }                     // no room, which is complete
    ];

    it('takes an id over anything else', function () {
        assert.deepStrictEqual(resolveByName(DEVICES, { id: 'b', name: 'Golvspot' }).devices.map(d => d.id), ['b']);
    });

    it('resolves a name that only one thing answers to', function () {
        assert.deepStrictEqual(resolveByName(DEVICES, { name: 'golvspot' }).devices.map(d => d.id), ['c']);
    });

    it('refuses a name several things answer to, rather than commanding them all', function () {
        const out = resolveByName(DEVICES, { name: 'taklampa' });
        assert.strictEqual(out.devices, undefined);
        assert.strictEqual(out.error.error, 'ambiguous_name');
        assert.deepStrictEqual(out.error.matches.map(m => m.room), ['Kontor', 'Sovrum'],
            'the refusal must say which rooms, or the caller cannot pick');
    });

    it('lets the room settle it', function () {
        assert.deepStrictEqual(resolveByName(DEVICES, { name: 'taklampa', room: 'Sovrum' }).devices.map(d => d.id), ['b']);
        assert.deepStrictEqual(resolveByName(DEVICES, { name: 'taklampa', room: 'sovrum' }).devices.map(d => d.id), ['b'],
            'room matching is case-insensitive');
    });

    it('matches a room exactly, unlike the name', function () {
        // The name is a substring because "taklampa" has to find "Kök Taklampa"; the room comes
        // from a list the caller can read, so there is nothing to guess at.
        assert.deepStrictEqual(resolveByName(DEVICES, { name: 'taklampa', room: 'Kont' }).devices, []);
    });

    it('finds nothing rather than throwing when nothing matches', function () {
        assert.deepStrictEqual(resolveByName(DEVICES, { name: 'finns inte' }).devices, []);
        assert.deepStrictEqual(resolveByName([], { name: 'x' }).devices, []);
        assert.deepStrictEqual(resolveByName(undefined, { id: 'a' }).devices, []);
    });

    it('reports a thing with no room as having none, not as a blank room', function () {
        const out = ambiguousThing([DEVICES[0], DEVICES[3]], 'x');
        assert.strictEqual(out.matches[1].room, null);
    });
});

describe('a name spanning room and thing', function () {
    const { resolveByName } = require('../core/mcp-tools');
    // What the editor shows is "[Tvättstuga] Golvspot", so that is what a person reads as the
    // thing's name — and an assistant that read `name` and `room` separately may put them back
    // together. Before this, both answered with nothing at all, which is worse than a refusal.
    const DEVICES = [
        { id: 'a', name: 'Golvspot', room: 'Tvättstuga' },
        { id: 'b', name: 'Golvspot', room: 'Kontor' },
        { id: 'c', name: 'Scen Natt' }
    ];

    it('resolves "Room Name" written as one string', function () {
        assert.deepStrictEqual(resolveByName(DEVICES, { name: 'Tvättstuga Golvspot' }).devices.map(d => d.id), ['a']);
    });

    it('accepts the bracketed form the editor displays', function () {
        assert.deepStrictEqual(resolveByName(DEVICES, { name: '[Kontor] Golvspot' }).devices.map(d => d.id), ['b']);
    });

    it('still refuses the bare ambiguous name rather than widening it', function () {
        // The fallback runs only when the bare name found nothing, so it can never turn a
        // refusal into a guess.
        assert.strictEqual(resolveByName(DEVICES, { name: 'Golvspot' }).error.error, 'ambiguous_name');
    });

    it('leaves a thing without a room reachable by its own name', function () {
        assert.deepStrictEqual(resolveByName(DEVICES, { name: 'Scen Natt' }).devices.map(d => d.id), ['c']);
    });

    it('still finds nothing when nothing matches either way', function () {
        assert.deepStrictEqual(resolveByName(DEVICES, { name: 'Vardagsrum Golvspot' }).devices, []);
    });
});

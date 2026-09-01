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

    it('offers appliance so a plug can say it is explicitly not a light', function () {
        assert.ok(DEVICE_CLASSES.includes('appliance'));
        assert.deepStrictEqual(deriveCategories([{ ha_type: 'switch', device_class: 'appliance' }]), []);
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

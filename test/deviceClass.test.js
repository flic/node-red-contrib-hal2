'use strict';
// resources/device-class.js is loaded twice from one source — required here and by
// core/mcp-tools.js, and fetched over HTTP by the Thing editor. These tests pin the shape both
// sides depend on, and that the UMD wrapper really does define the browser global; a mistake
// there leaves the editor dropdown empty with nothing failing on the runtime side.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'resources', 'device-class.js');
const dc = require('../resources/device-class');

describe('resources/device-class', function () {
    it('defines the same vocabulary as a browser global', function () {
        const sandbox = { self: {} };
        vm.createContext(sandbox);
        vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox);
        const browser = sandbox.self.hal2DeviceClass;
        assert.ok(browser, 'UMD wrapper did not define the global the editor loads');
        // Spread out of the sandbox realm first: an array built inside the vm has a different
        // Array prototype, which deepStrictEqual rejects however equal the contents are.
        assert.deepStrictEqual([...browser.DEVICE_CLASSES], dc.DEVICE_CLASSES);
        assert.strictEqual(browser.deviceClassFromHaType('dimmer'), 'light');
    });

    it('is the single source core/mcp-tools resolves against', function () {
        const tools = require('../core/mcp-tools');
        assert.deepStrictEqual(tools.HA_TYPE_GROUPS, dc.HA_TYPE_GROUPS,
            'the editor and the tools must not drift apart');
        assert.deepStrictEqual(tools.DEVICE_CLASSES, dc.DEVICE_CLASSES);
    });

    it('offers only classes something can act on once declared', function () {
        // climate, spa, cover and scene are deliberately absent: their tools dispatch on setpoint,
        // mode, position and scene ha_types, none of which a switch has, so declaring one would
        // advertise a capability nothing could honour.
        assert.deepStrictEqual(dc.DEVICE_CLASSES, ['light', 'fan', 'outlet', 'appliance']);
    });

    it('makes a declared class findable as a category', function () {
        // "Turn off all the outlets" needs the set to be findable, not just each member
        // classified — so outlet and appliance are categories with no ha_type of their own.
        const { deriveCategories } = require('../core/mcp-tools');
        for (const c of dc.DEVICE_CLASSES) {
            assert.deepStrictEqual(deriveCategories([{ ha_type: 'switch', device_class: c }]), [c],
                `a switch declared ${c} must report it as a category`);
        }
    });

    it('asks the question only where the ha_type leaves it open', function () {
        assert.ok(dc.needsDeviceClass('switch'), 'a switch could be driving anything');
        for (const t of ['light', 'dimmer', 'fan', 'cover', 'color', 'scene']) {
            assert.ok(!dc.needsDeviceClass(t), `${t} already says what it is`);
        }
    });

    describe('countsAs() — what the editor row states', function () {
        it('counts a dimmer toward light, which is what HA_TYPE_GROUPS says', function () {
            assert.strictEqual(dc.countsAs('', 'dimmer'), 'light');
        });

        it('counts nothing for a bare switch — the gap the declaration fills', function () {
            assert.strictEqual(dc.countsAs('', 'switch'), '');
        });

        it('counts nothing for colour or colour temperature', function () {
            // Capabilities of a light, not evidence that something is one; the categories
            // rule agrees, and the row must not claim otherwise.
            assert.strictEqual(dc.countsAs('', 'color'), '');
            assert.strictEqual(dc.countsAs('', 'color temperature'), '');
        });

        it('takes the declaration once there is one', function () {
            assert.strictEqual(dc.countsAs('light', 'switch'), 'light');
        });

        it('agrees with the categories the tools derive', function () {
            const { deriveCategories } = require('../core/mcp-tools');
            for (const [declared, haType] of [['', 'dimmer'], ['light', 'switch'], ['', 'color']]) {
                const viaRow = dc.countsAs(declared, haType);
                const viaTools = deriveCategories([{ ha_type: haType, device_class: declared }]);
                assert.deepStrictEqual(viaTools, viaRow ? [viaRow] : [],
                    `the row and the tools disagree for ${haType}/${declared || 'none'}`);
            }
        });
    });
});

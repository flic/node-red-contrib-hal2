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

    describe('describe() — what the editor row shows', function () {
        it('names the class the ha_type already implies, so the ThingType need not be opened', function () {
            assert.strictEqual(dc.describe('', 'dimmer'), '— derived: light —');
        });

        it('says none where the ha_type settles nothing', function () {
            assert.strictEqual(dc.describe('', 'switch'), '— none —');
        });

        it('shows the declaration once there is one', function () {
            assert.strictEqual(dc.describe('light', 'switch'), 'light');
        });
    });
});

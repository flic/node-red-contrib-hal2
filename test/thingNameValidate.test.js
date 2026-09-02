'use strict';
// core/thing.html's name validator decides whether a Thing can be deployed, and it is browser
// code, so it runs here in a sandbox with a stub RED and jQuery — the approach
// test/gateEditor.test.js established. Only the validator is exercised: it is the piece that
// decides whether a flow deploys, and it got the answer backwards for the exact rename that
// rooms were introduced to make possible.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'core', 'thing.html'), 'utf8');
const source = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];

// The stub answers only what validate asks: which node the open dialog belongs to, and what room
// is selected in it. `dom` is null when no dialog is open — deploy-time validation.
let dom = null;
let things = [];
const $ = function (selector) {
    if (selector === '#node-input-room') {
        return {
            length: dom ? 1 : 0,
            attr: () => (dom ? dom.nodeId : undefined),
            val: () => (dom ? dom.room : undefined)
        };
    }
    return { length: 0, attr: () => undefined, val: () => undefined, append() { return this; },
             empty() { return this; }, change() { return this; }, each() {}, find() { return this; } };
};

const RED = { nodes: { registerType(name, def) { RED._def = def; },
                       filterNodes: () => things, node: () => null }, _def: null };
const sandbox = { RED, $, jQuery: $, console,
                  halThingLabel: () => '', halGetRooms: () => [],
                  hal2DeviceClass: require('../resources/device-class'), halGroupAccepts: () => true };
for (const m of fs.readFileSync(path.join(__dirname, '..', 'resources', 'hal.js'), 'utf8')
        .matchAll(/^function (hal\w+)/gm)) { if (!sandbox[m[1]]) { sandbox[m[1]] = () => []; } }
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const validate = RED._def.defaults.name.validate;

describe('core/thing.html — the name validator', function () {
    beforeEach(function () { dom = null; things = []; });

    it('allows the same name in two different rooms', function () {
        // The rename rooms exist to make possible: drop "Tvättstuga" from the name, having just
        // picked Tvättstuga in the dropdown. Checking the name alone refused it.
        things = [{ id: 'a', name: 'Golvspot', room: 'kontor' }, { id: 'b', name: '', room: '' }];
        dom = { nodeId: 'b', room: 'tvattstuga' };
        assert.strictEqual(validate.call({ id: 'b' }, 'Golvspot'), true);
    });

    it('refuses the same name twice in one room', function () {
        things = [{ id: 'a', name: 'Golvspot', room: 'kontor' }, { id: 'b', name: '', room: '' }];
        dom = { nodeId: 'b', room: 'kontor' };
        assert.strictEqual(validate.call({ id: 'b' }, 'Golvspot'), false);
    });

    it('refuses two roomless things with one name, where the name is all there is', function () {
        things = [{ id: 'a', name: 'Golvspot', room: '' }, { id: 'b', name: '', room: '' }];
        dom = { nodeId: 'b', room: '' };
        assert.strictEqual(validate.call({ id: 'b' }, 'Golvspot'), false);
    });

    it('reads the room being chosen, not the one already saved', function () {
        // The room is picked and the name shortened in the same sitting. Judging the new name
        // against the saved room is what made the rename look like a collision.
        things = [{ id: 'a', name: 'Golvspot', room: 'kontor' }, { id: 'b', name: 'x', room: 'kontor' }];
        dom = { nodeId: 'b', room: 'tvattstuga' };
        assert.strictEqual(validate.call({ id: 'b', room: 'kontor' }, 'Golvspot'), true);
    });

    it('does not let another Thing\'s open dialog decide this one', function () {
        // Every Thing shares one template, so an element id alone is not enough — deploy
        // validation runs over every node while one dialog happens to be open.
        things = [{ id: 'a', name: 'Golvspot', room: 'kontor' }];
        dom = { nodeId: 'other', room: 'tvattstuga' };
        assert.strictEqual(validate.call({ id: 'b', room: 'kontor' }, 'Golvspot'), false,
            'with no dialog of ours open, the saved room is what counts');
    });

    it('never collides a Thing with itself', function () {
        things = [{ id: 'a', name: 'Golvspot', room: 'kontor' }];
        dom = { nodeId: 'a', room: 'kontor' };
        assert.strictEqual(validate.call({ id: 'a' }, 'Golvspot'), true);
    });
});

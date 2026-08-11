'use strict';
// core/gate.html's editor block is browser code, so it is run here in a sandbox with a stub
// RED and a stub jQuery, and the definition it registers is pulled back out. Only the
// eventHandler validate is exercised: it is the one piece of editor logic that decides
// whether a flow can deploy, and its two branches (open dialog vs. canvas) are easy to get
// backwards and impossible to notice by reading.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'core', 'gate.html'), 'utf8');
const source = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];

// The stub answers only what the validate asks of the DOM: how many rule rows are marked as
// group rules, and which node the open dialog belongs to. `dom` is null when no dialog is open.
let dom = null;
const $ = function (selector) {
    if (selector === '#node-input-checkall') {
        return { length: dom ? 1 : 0, attr: () => (dom ? dom.nodeId : undefined) };
    }
    if (selector === '#node-input-rule-container .hal2-group-rule') {
        return { length: dom ? dom.groupRows : 0 };
    }
    return { length: 0 };
};

const sandbox = { console, $, jQuery: $ };
sandbox.window = sandbox;
let def = null;
sandbox.RED = { nodes: { registerType: (name, d) => { if (name === 'hal2Gate') { def = d; } } } };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const validate = (node, value) => def.defaults.eventHandler.validate.call(node, value);
const groupRule = { category: 'hal2Group' };
const thingRule = { category: undefined };

describe('gate.html eventHandler validate', function () {
    afterEach(function () { dom = null; });

    it('is not declared required:false, which would skip it on an empty value', function () {
        // Node-RED returns valid for an empty value on a required:false property *before*
        // calling validate. That is exactly the "no handler at all" case this must judge, so
        // the flag has to stay off however optional the field reads.
        assert.ok(!('required' in def.defaults.eventHandler));
    });

    describe('with no dialog open (deploy-time canvas validation)', function () {
        it('accepts a missing handler when no saved rule reads a group', function () {
            assert.strictEqual(validate({ id: 'g1', rules: [thingRule, thingRule] }, ''), true);
        });

        it('rejects a missing handler once a saved rule reads a group', function () {
            assert.strictEqual(validate({ id: 'g1', rules: [thingRule, groupRule] }, ''), false);
        });

        it('accepts a group rule when a handler is set', function () {
            assert.strictEqual(validate({ id: 'g1', rules: [groupRule] }, 'eh1'), true);
        });

        it('treats a node with no rules at all as valid', function () {
            assert.strictEqual(validate({ id: 'g1' }, ''), true);
        });
    });

    describe('with this node\'s dialog open', function () {
        it('rejects a group rule picked in the dialog before it has ever been saved', function () {
            // The saved ruleset still says there is no group; the live rows are what the
            // user is looking at, and they are what must decide.
            dom = { nodeId: 'g1', groupRows: 1 };
            assert.strictEqual(validate({ id: 'g1', rules: [thingRule] }, '_ADD_'), false);
        });

        it('accepts once a handler is chosen for that group rule', function () {
            dom = { nodeId: 'g1', groupRows: 1 };
            assert.strictEqual(validate({ id: 'g1', rules: [thingRule] }, 'eh1'), true);
        });

        it('accepts again when the group rule is changed back to a thing', function () {
            // The saved ruleset still carries the group; clearing the row has to clear the
            // error, or the field stays red with nothing on screen explaining why.
            dom = { nodeId: 'g1', groupRows: 0 };
            assert.strictEqual(validate({ id: 'g1', rules: [groupRule] }, '_ADD_'), true);
        });
    });

    it('judges another Gate by its own saved rules while this one is open', function () {
        // Two Gate nodes share one template, so an id-only check would let the open dialog's
        // rows decide the validity of every other Gate on the canvas during deploy.
        dom = { nodeId: 'g1', groupRows: 1 };
        assert.strictEqual(validate({ id: 'g2', rules: [thingRule] }, ''), true);
        assert.strictEqual(validate({ id: 'g2', rules: [groupRule] }, ''), false);
    });
});

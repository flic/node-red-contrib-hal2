'use strict';
// The read/write gate as the Event handler builds it. buildGate() itself lives inside the
// node constructor and needs a running Node-RED, so the composition is reproduced here from
// the same two primitives it uses — claim-gate and toolClass. What is being pinned is the
// policy: which tool classes clear which value list, and what the empty defaults mean.

const assert = require('node:assert');
const { createToolGate } = require('../lib/claim-gate');
const { toolClass, MCP_TOOLS } = require('../core/mcp-tools');

// Mirrors buildGate() in core/eventhandler.js.
function buildGate(claims, { claimName = 'groups', readValue = '', writeValue = '' } = {}) {
    const gate = createToolGate({ claims, claimName, serverValue: readValue });
    return {
        allows(toolName) {
            if (!gate.serverGranted) { return false; }
            return toolClass(toolName) === 'write' ? gate.allows(writeValue) : true;
        },
        allowsValue: list => gate.allows(list)
    };
}

const READER  = { groups: ['family'] };
const WRITER  = { groups: ['family', 'ops'] };
const OUTSIDE = { groups: ['guest'] };

describe('read/write tool gate', function () {
    const opts = { readValue: 'family', writeValue: 'ops' };

    it('lets a read-only token read but not write', function () {
        const g = buildGate(READER, opts);
        assert.strictEqual(g.allows('get_state'), true);
        assert.strictEqual(g.allows('get_all_states'), true);
        assert.strictEqual(g.allows('set_light'), false);
        assert.strictEqual(g.allows('activate_scene'), false);
    });

    it('lets a token holding both lists do everything', function () {
        const g = buildGate(WRITER, opts);
        assert.strictEqual(g.allows('get_state'), true);
        assert.strictEqual(g.allows('set_light'), true);
    });

    it('refuses everything to a token that clears neither', function () {
        const g = buildGate(OUTSIDE, opts);
        assert.strictEqual(g.allows('get_state'), false);
        assert.strictEqual(g.allows('set_light'), false);
    });

    it('closes the write gate against the control_light alias', function () {
        // The alias the dispatcher accepts but the catalog does not list. If the gate let it
        // through, a read-only token could switch lights by asking for it by the other name.
        const g = buildGate(READER, opts);
        assert.strictEqual(g.allows('control_light'), false);
        assert.strictEqual(buildGate(WRITER, opts).allows('control_light'), true);
    });

    it('treats an unknown tool as a write', function () {
        assert.strictEqual(buildGate(READER, opts).allows('some_future_tool'), false);
        assert.strictEqual(buildGate(WRITER, opts).allows('some_future_tool'), true);
    });

    it('keeps read tools that live in the control dispatcher on the read side', function () {
        // get_scenes and get_alerts are handled by dispatchControlTools but only observe.
        const g = buildGate(READER, opts);
        assert.strictEqual(g.allows('get_scenes'), true);
        assert.strictEqual(g.allows('get_alerts'), true);
    });

    it('empty defaults leave every catalog tool reachable', function () {
        // The upgrade path: an existing install has neither field set and must behave
        // exactly as it did before the gates existed.
        const g = buildGate(READER);
        for (const t of MCP_TOOLS) {
            assert.strictEqual(g.allows(t.name), true, t.name + ' should be reachable');
        }
        // …and so should a caller with no claims at all.
        assert.strictEqual(buildGate(null).allows('set_light'), true);
    });

    it('a write list alone still gates writes while reads stay open', function () {
        const g = buildGate(READER, { writeValue: 'ops' });
        assert.strictEqual(g.allows('get_state'), true);
        assert.strictEqual(g.allows('set_light'), false);
        assert.strictEqual(buildGate(WRITER, { writeValue: 'ops' }).allows('set_light'), true);
    });

    it('accepts comma-separated any-of lists', function () {
        const g = buildGate({ groups: ['ops'] }, { readValue: 'family,ops', writeValue: 'ops,admin' });
        assert.strictEqual(g.allows('get_state'), true);
        assert.strictEqual(g.allows('set_light'), true);
        // A single configured value keeps behaving as it did before lists existed.
        assert.strictEqual(buildGate({ groups: ['ops'] }, { readValue: 'ops' }).allows('get_state'), true);
        assert.strictEqual(buildGate({ groups: ['x'] }, { readValue: 'ops' }).allows('get_state'), false);
    });

    it('gates dynamic tools on their own value, on top of the read list', function () {
        const g = buildGate(READER, opts);
        assert.strictEqual(g.allowsValue(''), true);          // no constraint of its own
        assert.strictEqual(g.allowsValue('family'), true);
        assert.strictEqual(g.allowsValue('ops'), false);      // reader lacks it
        assert.strictEqual(buildGate(WRITER, opts).allowsValue('ops'), true);
        // The server list still applies even when the tool asks for nothing.
        assert.strictEqual(buildGate(OUTSIDE, opts).allowsValue(''), false);
    });
});

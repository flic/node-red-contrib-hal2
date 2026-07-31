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

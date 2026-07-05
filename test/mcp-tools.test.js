'use strict';

const assert = require('node:assert');
const {
    MCP_TOOLS, MCP_TOOLS_ADMIN, MCP_ADMIN_TOOL_NAMES, expandHaTypeFilter
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

    it('expandHaTypeFilter returns a Set that always contains the input key', function () {
        const out = expandHaTypeFilter('light');
        assert.ok(out instanceof Set);
        assert.ok(out.has('light'));
    });
});

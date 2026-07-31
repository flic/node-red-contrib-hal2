'use strict';

const assert = require('node:assert');
const { handleRpc } = require('../lib/mcp-rpc');
// hal2 keeps its admin catalog in core/mcp-tools.js rather than a lib/admin-tools module,
// so the dispatcher is exercised against the real get_flow/deploy_flow set.
const { MCP_TOOLS_ADMIN: TOOLS, MCP_ADMIN_TOOL_NAMES: TOOL_NAMES } = require('../core/mcp-tools');

// Deliberately a plain object (not null-prototype): handleRpc must not resolve
// caller-supplied names through the prototype chain regardless of registry flavour.
function registry() {
    return {
        open  : { description: 'open tool',  schema: { type: 'object', properties: {} }, timeoutMs: 5000, requiredValue: '' },
        gated : { description: 'gated tool', schema: { type: 'object', properties: {} }, timeoutMs: 5000, requiredValue: 'media' }
    };
}

function deps(overrides = {}) {
    return Object.assign({
        serverName        : 'test-server',
        serverVersion     : '9.9.9',
        instructions      : '',
        requiredClaim     : 'groups',
        requiredValue     : '',
        adminToolsEnabled : false,
        adminRequiredValue: 'admin',
        adminTools        : { TOOLS, TOOL_NAMES, callTool: async () => 'admin ok' },
        tools             : registry(),
        callTool          : async () => 'tool ok'
    }, overrides);
}

const claims = groups => ({ sub: 'u', groups });

const call = (name, d) => handleRpc({ id: 1, method: 'tools/call', params: { name } }, d.claims, d.deps);

describe('lib/mcp-rpc initialize', function () {
    it('lists visible tool names, server info and no-store caching', async function () {
        const out = await handleRpc({ id: 1, method: 'initialize' }, claims(['media']), deps());
        assert.strictEqual(out.status, 200);
        assert.deepStrictEqual(out.headers, { 'Cache-Control': 'no-store' });
        assert.strictEqual(out.body.result.serverInfo.version, '9.9.9');
        assert.strictEqual(out.body.result.instructions, 'Available tools: open, gated.');
    });

    it('prefixes configured instructions and hides gated tools from unqualified callers', async function () {
        const out = await handleRpc({ id: 1, method: 'initialize' }, claims(['guest']),
            deps({ instructions: 'Be nice.' }));
        assert.strictEqual(out.body.result.instructions, 'Be nice. Available tools: open.');
    });

    it('names no tools at all when the server list is not cleared', async function () {
        const out = await handleRpc({ id: 1, method: 'initialize' }, claims(['guest']),
            deps({ requiredValue: 'staff' }));
        assert.strictEqual(out.body.result.instructions, '');
    });

    it('includes admin tool names only for admin-gated callers', async function () {
        const on  = await handleRpc({ id: 1, method: 'initialize' }, claims(['admin']),
            deps({ adminToolsEnabled: true }));
        assert.ok(on.body.result.instructions.includes('get_flow'));
        const off = await handleRpc({ id: 1, method: 'initialize' }, claims(['media']),
            deps({ adminToolsEnabled: true }));
        assert.ok(!off.body.result.instructions.includes('get_flow'));
    });
});

describe('lib/mcp-rpc protocol plumbing', function () {
    it('acks notifications/initialized with a bodyless 204', async function () {
        const out = await handleRpc({ method: 'notifications/initialized' }, claims([]), deps());
        assert.strictEqual(out.status, 204);
        assert.strictEqual(out.body, undefined);
    });

    it('answers ping with an empty result', async function () {
        const out = await handleRpc({ id: 7, method: 'ping' }, claims([]), deps());
        assert.deepStrictEqual(out.body, { jsonrpc: '2.0', id: 7, result: {} });
    });

    it('echoes the request id, defaulting to null', async function () {
        const out = await handleRpc({ method: 'nope' }, claims([]), deps());
        assert.strictEqual(out.body.id, null);
        assert.strictEqual(out.body.error.code, -32601);
    });

    it('rejects unknown methods and a missing body without throwing', async function () {
        const out = await handleRpc(undefined, claims([]), deps());
        assert.strictEqual(out.body.error.code, -32601);
    });
});

describe('lib/mcp-rpc tools/list', function () {
    it('filters by the per-tool gate', async function () {
        const out = await handleRpc({ id: 1, method: 'tools/list' }, claims(['guest']), deps());
        assert.deepStrictEqual(out.body.result.tools.map(t => t.name), ['open']);
    });

    it('is empty when the server list is not cleared, whatever the tool lists say', async function () {
        const out = await handleRpc({ id: 1, method: 'tools/list' }, claims(['media']),
            deps({ requiredValue: 'staff' }));
        assert.deepStrictEqual(out.body.result.tools, []);
    });

    it('appends admin tools only when enabled and admin-gated', async function () {
        const d = deps({ adminToolsEnabled: true });
        const admin = await handleRpc({ id: 1, method: 'tools/list' }, claims(['admin']), d);
        assert.deepStrictEqual(admin.body.result.tools.map(t => t.name),
            ['open', 'get_flow', 'deploy_flow']);
        const plain = await handleRpc({ id: 1, method: 'tools/list' }, claims(['media']), d);
        assert.deepStrictEqual(plain.body.result.tools.map(t => t.name), ['open', 'gated']);
    });
});

describe('lib/mcp-rpc tools/call', function () {
    it('denies at the server gate with the server-level message', async function () {
        const out = await call('open', { claims: claims(['guest']), deps: deps({ requiredValue: 'staff' }) });
        assert.strictEqual(out.body.result.isError, true);
        assert.ok(out.body.result.content[0].text.includes('use this server'));
    });

    it('denies at the per-tool gate, naming the tool', async function () {
        const out = await call('gated', { claims: claims(['guest']), deps: deps() });
        assert.strictEqual(out.body.result.isError, true);
        assert.ok(out.body.result.content[0].text.includes('"gated" tool requires a permission'));
    });

    it('dispatches an allowed call and wraps a string result', async function () {
        const seen = [];
        const d = deps({ callTool: async (name, timeoutMs, args) => { seen.push([name, timeoutMs, args]); return 'did it'; } });
        const out = await handleRpc({ id: 1, method: 'tools/call', params: { name: 'open', arguments: { a: 1 } } },
            claims(['guest']), d);
        assert.deepStrictEqual(out.body.result.content, [{ type: 'text', text: 'did it' }]);
        assert.deepStrictEqual(seen, [['open', 5000, { a: 1 }]]);
    });

    it('passes an array result through as the content array', async function () {
        const blocks = [{ type: 'text', text: 'x' }, { type: 'image', data: '...' }];
        const out = await call('open', { claims: claims([]), deps: deps({ callTool: async () => blocks }) });
        assert.deepStrictEqual(out.body.result.content, blocks);
        assert.strictEqual(out.body.result.isError, undefined);
    });

    it('reports a timeout as a tool result, not a protocol error', async function () {
        const out = await call('open', { claims: claims([]), deps: deps({ callTool: async () => { throw new Error('timeout'); } }) });
        assert.deepStrictEqual(JSON.parse(out.body.result.content[0].text), { error: 'Tool timed out: open' });
    });

    it('returns -32601 for unknown tools, including prototype-chain names', async function () {
        for (const name of ['missing', '__proto__', 'constructor', 'hasOwnProperty']) {
            const out = await call(name, { claims: claims([]), deps: deps() });
            assert.strictEqual(out.body.error && out.body.error.code, -32601, name);
        }
    });

    it('hides admin tools entirely when disabled', async function () {
        const out = await call('get_flow', { claims: claims(['admin']), deps: deps() });
        assert.strictEqual(out.body.error.code, -32601);
    });

    it('re-checks the admin gate on every call', async function () {
        const out = await call('get_flow', { claims: claims(['media']), deps: deps({ adminToolsEnabled: true }) });
        assert.strictEqual(out.body.result.isError, true);
        assert.ok(out.body.result.content[0].text.includes('admin privileges'));
    });

    it('runs an admin tool for a qualified caller', async function () {
        const out = await call('get_flow', { claims: claims(['admin']), deps: deps({ adminToolsEnabled: true }) });
        assert.deepStrictEqual(out.body.result.content, [{ type: 'text', text: 'admin ok' }]);
    });

    it('maps an admin rpcCode error to a JSON-RPC error', async function () {
        const boom = Object.assign(new Error('Invalid flow id'), { rpcCode: -32602 });
        const d = deps({ adminToolsEnabled: true,
            adminTools: { TOOLS, TOOL_NAMES, callTool: async () => { throw boom; } } });
        const out = await call('deploy_flow', { claims: claims(['admin']), deps: d });
        assert.deepStrictEqual(out.body.error, { code: -32602, message: 'Invalid flow id' });
    });
});

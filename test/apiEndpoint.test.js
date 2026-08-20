'use strict';
// One hal2Api node speaks for one endpoint. These drive core/mcpserver.js and core/api.js against
// a stub RED, because the thing being tested is the wiring — which registry a call lands in — and
// that is invisible to a unit test of either file's exports.

const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const MCPSERVER = path.join(__dirname, '..', 'core', 'mcpserver.js');
const API       = path.join(__dirname, '..', 'core', 'api.js');

// A node with a real emitter: the standalone dispatch hands the call to the flow with emit() and
// waits for resolveMCPCall, so a stubbed-out emitter would test nothing.
function makeNode(config) {
    const node = new EventEmitter();
    node.id = config.id;
    node.status = s => { node._status = s; };
    node.log = () => {}; node.warn = () => {}; node.error = () => {}; node.debug = () => {};
    return node;
}

function loadServer(config, eventHandler) {
    let registered = null;
    const routes = [];
    const RED = {
        nodes: {
            createNode(node, cfg) { node.id = cfg.id; },
            getNode: () => eventHandler,
            registerType: (name, fn) => { registered = fn; }
        },
        httpNode: { post: (p, ...rest) => routes.push(p), _router: { stack: [] } }
    };
    delete require.cache[require.resolve(MCPSERVER)];
    require(MCPSERVER)(RED);

    const node = makeNode(config);
    registered.call(node, config);
    return { node, routes };
}

// Enough of an event handler to satisfy the standalone server's preconditions.
const stubEventHandler = (extra) => Object.assign({
    requireBearer: async () => ({}), mcpEnabled: true, mcpExpectedHost: ''
}, extra);

describe('hal2MCPServer callTool (standalone)', function () {
    function standalone(extra) {
        const { node } = loadServer({ id: 's1', mode: 'standalone', path: 'jellyfin' },
                                    stubEventHandler(extra));
        return node;
    }

    it('dispatches a registered tool to the flow and returns the MCP envelope', async function () {
        const node = standalone();
        node.registerMCPTool('jellyfin_search', 'Search', {}, 30, '', 'in1');
        // Stand in for the hal2MCPOut that answers the call.
        node.on('mcp_tool_jellyfin_search', ev => {
            setImmediate(() => node.resolveMCPCall(ev._mcpCallId, [{ type: 'text', text: 'hit' }]));
        });

        const out = await node.callTool('jellyfin_search', { q: 'x' }, null, {});
        // Asserted field by field: api.js reads exactly these.
        assert.strictEqual(out.ok, true);
        assert.deepStrictEqual(out.content, [{ type: 'text', text: 'hit' }]);
    });

    it('answers an unknown name with -32601 rather than hanging', async function () {
        const out = await standalone().callTool('get_state', {}, null, {});
        assert.strictEqual(out.ok, false);
        assert.strictEqual(out.code, -32601);
        assert.ok(out.message.includes('get_state'), out.message);
    });

    it('resolves a timeout instead of rejecting', async function () {
        // Matches the Event handler: a tool result carrying an error, not a thrown promise, so
        // api.js reports it as a tool answer rather than a node crash.
        const node = standalone();
        node.registerMCPTool('slow', 'Never answers', {}, 0.01, '', 'in1');
        const out = await node.callTool('slow', {}, null, {});
        assert.strictEqual(out.ok, true);
        assert.ok(JSON.parse(out.text).error.includes('timed out'), out.text);
    });

    it('calls a tool restricted over MCP, because the flow path is ungated', async function () {
        // Deliberate, and pinned so that changing it has to break a test that says why: the
        // claim and scope gates run on the MCP route where the token was verified, and a flow
        // node is already inside the trust boundary. Tool access restricts MCP clients, not flows.
        const node = standalone();
        node.registerMCPTool('gated', 'Restricted over MCP', {}, 30, 'ops', 'in1');
        node.on('mcp_tool_gated', ev =>
            setImmediate(() => node.resolveMCPCall(ev._mcpCallId, [{ type: 'text', text: 'ran' }])));
        const out = await node.callTool('gated', {}, null, {});
        assert.strictEqual(out.ok, true);
        assert.deepStrictEqual(out.content, [{ type: 'text', text: 'ran' }]);
    });

    it('lists its own tools, including ones gated over MCP', async function () {
        // The flow path is ungated, so listing less than it can call would be a lie.
        const node = standalone();
        node.registerMCPTool('open', 'Open tool', { q: { type: 'string' } }, 30, '', 'in1');
        node.registerMCPTool('gated', 'Restricted', {}, 30, 'ops', 'in2');
        const names = node.listTools().map(t => t.name).sort();
        assert.deepStrictEqual(names, ['gated', 'open']);
        assert.deepStrictEqual(node.listTools().find(t => t.name === 'open').inputSchema,
                               { type: 'object', properties: { q: { type: 'string' } } });
    });
});

describe('hal2MCPServer callTool (embedded)', function () {
    it('delegates to the event handler, so the picker is safe to point at either mode', async function () {
        const calls = [];
        const eh = stubEventHandler({
            registerMCPTool: () => {}, unregisterMCPTool: () => {}, resolveMCPCall: () => {},
            on: () => {}, removeListener: () => {},
            callTool: async (...a) => { calls.push(a); return { ok: true, text: '"built-in"' }; },
            listTools: () => [{ name: 'get_state', description: 'b', inputSchema: {} }]
        });
        const { node } = loadServer({ id: 's2', mode: 'embedded' }, eh);
        const out = await node.callTool('get_state', { thing_id: 'x' }, null, {});
        assert.strictEqual(out.text, '"built-in"');
        assert.strictEqual(calls[0][0], 'get_state');
        assert.deepStrictEqual(node.listTools().map(t => t.name), ['get_state']);
    });
});

describe('hal2Api endpoint selection', function () {
    function loadApi(config, nodesById) {
        let registered = null;
        const RED = {
            nodes: {
                createNode(node, cfg) { node.id = cfg.id; },
                getNode: id => nodesById[id],
                registerType: (name, fn) => { registered = fn; }
            },
            util: {
                setMessageProperty: (msg, prop, val) => { msg[prop] = val; },
                parseContextStore: k => ({ key: k })
            }
        };
        delete require.cache[require.resolve(API)];
        require(API)(RED);
        const node = makeNode(config);
        let input = null;
        node.on = (ev, fn) => { if (ev === 'input') input = fn; };
        node.context = () => ({});
        registered.call(node, config);
        return payload => new Promise(resolve => {
            const msg = { payload };
            input(msg, () => {}, () => resolve(msg.payload));
        });
    }

    const ehNode = {
        callTool: async name => (name === 'get_state'
            ? { ok: true, text: '{"on":true}' }
            : { ok: false, code: -32601, message: 'Unknown tool: ' + name }),
        listTools: () => [{ name: 'get_state', description: 'b', inputSchema: {} }]
    };
    const srvNode = {
        callTool: async name => (name === 'jellyfin_search'
            ? { ok: true, content: [{ type: 'text', text: 'hit' }] }
            : { ok: false, code: -32601, message: 'Unknown tool: ' + name }),
        listTools: () => [{ name: 'jellyfin_search', description: 's', inputSchema: {} }]
    };

    it('uses the event handler when no endpoint is picked', async function () {
        // What every node configured before the field existed has, so this is the
        // backwards-compatibility check.
        const call = loadApi({ id: 'a1', eventHandler: 'eh' }, { eh: ehNode });
        assert.deepStrictEqual(await call({ tool: 'get_state' }), { ok: true, result: { on: true } });
    });

    it('uses the picked endpoint, and only its tools', async function () {
        const call = loadApi({ id: 'a2', eventHandler: 'eh', mcpServer: 'srv' },
                             { eh: ehNode, srv: srvNode });
        const hit = await call({ tool: 'jellyfin_search' });
        assert.deepStrictEqual(hit.result, [{ type: 'text', text: 'hit' }]);
        // No fallback: a built-in name is unknown on a standalone endpoint, exactly as it is
        // for an MCP client on that URL.
        const miss = await call({ tool: 'get_state' });
        assert.strictEqual(miss.ok, false);
        assert.strictEqual(miss.error.code, -32601);
    });

    it('answers { list: true } with the catalogue behind it', async function () {
        const viaEh  = loadApi({ id: 'a3', eventHandler: 'eh' }, { eh: ehNode });
        const viaSrv = loadApi({ id: 'a4', eventHandler: 'eh', mcpServer: 'srv' },
                               { eh: ehNode, srv: srvNode });
        assert.deepStrictEqual((await viaEh({ list: true })).result.map(t => t.name),  ['get_state']);
        assert.deepStrictEqual((await viaSrv({ list: true })).result.map(t => t.name), ['jellyfin_search']);
    });
});

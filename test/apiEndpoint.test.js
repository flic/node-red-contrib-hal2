'use strict';
// The flow-side MCP nodes against a stub RED: hal2Api calling the event handler's catalogue, tool
// call and tool result registering on and answering through the event handler, and the stubs
// for removed types that keep 3.x flows starting. What is tested is the wiring — which object a
// call lands on — which is invisible to a unit test of any one file's exports.

const assert = require('node:assert');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const API    = path.join(__dirname, '..', 'core', 'api.js');
const IN     = path.join(__dirname, '..', 'core', 'mcpin.js');
const OUT    = path.join(__dirname, '..', 'core', 'mcpout.js');
const LEGACY = path.join(__dirname, '..', 'core', 'legacy.js');

function makeNode(config) {
    const node = new EventEmitter();
    node.id = config.id;
    node.status = s => { node._status = s; };
    node.errors = [];
    node.log = () => {}; node.warn = () => {}; node.debug = () => {};
    node.error = m => node.errors.push(m);
    return node;
}

function load(file, config, nodesById, type) {
    let registered = null;
    const RED = {
        nodes: {
            createNode(node, cfg) { node.id = cfg.id; },
            getNode: id => nodesById[id],
            registerType: (name, fn) => { if (!type || name === type) { registered = fn; } }
        },
        util: {
            setMessageProperty: (msg, prop, val) => { msg[prop] = val; },
            parseContextStore: k => ({ key: k })
        }
    };
    delete require.cache[require.resolve(file)];
    require(file)(RED);
    const node = makeNode(config);
    const listeners = {};
    const realOn = node.on.bind(node);
    node.on = (ev, fn) => { listeners[ev] = fn; return realOn(ev, fn); };
    node.context = () => ({});
    node.sent = [];
    node.send = m => node.sent.push(m);
    registered.call(node, config);
    return { node, listeners };
}

describe('hal2Api', function () {
    const ehNode = {
        callTool: async name => (name === 'get_state'
            ? { ok: true, text: '{"on":true}' }
            : { ok: false, code: -32601, message: 'Unknown tool: ' + name }),
        listTools: () => [{ name: 'get_state', description: 'b', inputSchema: {} }]
    };
    const call = (config, payload) => {
        const { listeners } = load(API, config, { eh: ehNode });
        return new Promise(resolve => {
            const msg = { payload };
            listeners.input(msg, () => {}, () => resolve(msg.payload));
        });
    };

    it('calls the event handler\'s catalogue', async function () {
        assert.deepStrictEqual(await call({ id: 'a1', eventHandler: 'eh' }, { tool: 'get_state' }),
            { ok: true, result: { on: true } });
    });

    it('answers { list: true } with the catalogue', async function () {
        const out = await call({ id: 'a2', eventHandler: 'eh' }, { list: true });
        assert.deepStrictEqual(out.result.map(t => t.name), ['get_state']);
    });

    it('refuses to answer for a hal2MCPServer it still names, rather than calling the wrong tools', async function () {
        const out = await call({ id: 'a3', eventHandler: 'eh', mcpServer: 'gone' }, { tool: 'get_state' });
        assert.strictEqual(out.ok, false);
        assert.ok(out.error.message.includes('removed in 4.0.0'), out.error.message);
    });
});

describe('tool call / tool result', function () {
    function stubEventHandler() {
        const eh = new EventEmitter();
        eh.tools = {}; eh.resolved = [];
        eh.registerMCPTool = (name, description, schema, timeout, requiredValue, ownerId, opts) => {
            eh.tools[name] = { description, schema, requiredValue, ownerId, opts };
        };
        eh.unregisterMCPTool = name => { delete eh.tools[name]; };
        eh.resolveMCPCall = (id, content) => eh.resolved.push([id, content]);
        return eh;
    }

    it('hands its kind and validation to the event handler as configured, which holds the defaults', function () {
        // The one defaulting rule — write unless read, validate unless false — is registerMCPTool's.
        const eh = stubEventHandler();
        load(IN, { id: 'i1', eventHandler: 'eh', toolName: 'fw', description: 'd', inputSchema: '{"type":"object"}' }, { eh });
        assert.deepStrictEqual(eh.tools.fw.opts, { access: undefined, validate: undefined });
        load(IN, { id: 'i2', eventHandler: 'eh', toolName: 'stats', access: 'read', validateArgs: false }, { eh });
        assert.deepStrictEqual(eh.tools.stats.opts, { access: 'read', validate: false });
    });

    it('fires the flow on a call, and answers through the event handler', function () {
        const eh = stubEventHandler();
        const { node: inNode } = load(IN, { id: 'i1', eventHandler: 'eh', toolName: 'fw' }, { eh });
        eh.emit('mcp_tool_fw', { args: { a: 1 }, _mcpCallId: 'c1' });
        assert.deepStrictEqual(inNode.sent[0], { payload: { a: 1 }, _mcpCallId: 'c1', topic: 'fw' });
        const { listeners } = load(OUT, { id: 'o1', eventHandler: 'eh' }, { eh });
        listeners.input({ _mcpCallId: 'c1', payload: { done: true } });
        assert.deepStrictEqual(eh.resolved, [['c1', '{"done":true}']]);
    });

    it('says a node still pointing at a hal2MCPServer must be converted', function () {
        for (const file of [IN, OUT]) {
            const { node } = load(file, { id: 'x', mcpServer: 'old', toolName: 't' }, {});
            assert.ok(node.errors[0].includes('removed in 4.0.0'), node.errors.join());
            assert.ok(node._status.text.includes('convert'));
        }
    });
});

describe('removed-type stubs', function () {
    it('registers hal2MCPServer so 3.x flows start, and says it was removed', function () {
        for (const mode of ['standalone', 'embedded']) {
            const { node } = load(LEGACY, { id: 's', mode }, {}, 'hal2MCPServer');
            assert.ok(node.errors[0].includes('removed in 4.0.0'));
            assert.ok(node.errors[0].includes(mode === 'standalone' ? 'MCP Server of @frtnbach' : 'event handler'));
            assert.strictEqual(node._status.fill, 'red');
        }
    });

    it('registers hal2Group so 3.x flows start, and says it was removed', function () {
        const { node } = load(LEGACY, { id: 'g' }, {}, 'hal2Group');
        assert.ok(node.errors[0].includes('hal2Group was removed in 4.0.0'));
        assert.ok(node._status.text.includes('convert'));
    });
});

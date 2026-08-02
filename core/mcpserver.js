const crypto = require('crypto');
const { createHttpGuards, hostFilter, removeOwnedRoutes } = require('../lib/httpGuards');
const { handleRpc } = require('../lib/mcp-rpc');

module.exports = function (RED) {

    function hal2MCPServer(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const eventHandler = RED.nodes.getNode(config.eventHandler);
        if (!eventHandler) {
            node.error('No event handler configured');
            node.status({ fill: 'red', shape: 'ring', text: 'no event handler' });
            return;
        }

        // requireBearer exists on every EventHandler, so the real signal is mcpEnabled:
        // without it no OAuth discovery routes are registered, and clients could validate
        // tokens in principle but never complete a login. Refuse early instead.
        if (!eventHandler.requireBearer || !eventHandler.mcpEnabled) {
            node.error('MCP is not enabled on the event handler');
            node.status({ fill: 'red', shape: 'ring', text: 'MCP not enabled on event handler' });
            return;
        }

        // ── Embedded mode ─────────────────────────────────────────────────────
        // Delegates tool registration and call resolution to the EventHandler.
        // Tools appear on the shared /mcp endpoint alongside built-in tools.

        if (config.mode === 'embedded') {
            node.registerMCPTool = (name, description, schema, timeoutSec, requiredValue, ownerId) =>
                eventHandler.registerMCPTool(name, description, schema, timeoutSec, requiredValue, ownerId);

            node.unregisterMCPTool = (name, ownerId) =>
                eventHandler.unregisterMCPTool(name, ownerId);

            node.resolveMCPCall = (callId, content) =>
                eventHandler.resolveMCPCall(callId, content);

            // Proxy mcp_tool_* events to/from the EventHandler so MCPIn listeners work
            const origOn             = node.on.bind(node);
            const origRemoveListener = node.removeListener.bind(node);
            node.on = function (event, listener) {
                if (event.startsWith('mcp_tool_')) return eventHandler.on(event, listener);
                return origOn(event, listener);
            };
            node.removeListener = function (event, listener) {
                if (event.startsWith('mcp_tool_')) return eventHandler.removeListener(event, listener);
                return origRemoveListener(event, listener);
            };

            node.status({ fill: 'green', shape: 'dot', text: 'embedded' });
            return;
        }

        // ── Standalone mode ───────────────────────────────────────────────────
        // Registers its own POST /mcp/<path> route. Shares auth with EventHandler.

        // Null-prototype: names arrive from remote callers, and a plain {} resolves
        // "__proto__" or "constructor" through the prototype chain past the unknown-tool check.
        node.mcpRegisteredTools = Object.create(null);
        node.mcpPendingCalls    = Object.create(null);

        node.registerMCPTool = function (name, description, schema, timeoutSec, requiredValue, ownerId) {
            const existing = node.mcpRegisteredTools[name];
            if (existing && existing.ownerId !== ownerId) {
                node.warn('MCP tool "' + name + '" is registered by more than one hal2MCPIn node on this '
                    + 'server — each call will run every one of those flows, with unpredictable results. '
                    + 'Rename the tools so each name is unique.');
            }
            node.mcpRegisteredTools[name] = {
                description, schema, timeoutMs: timeoutSec * 1000,
                requiredValue: requiredValue || '', ownerId
            };
        };

        node.unregisterMCPTool = function (name, ownerId) {
            const entry = node.mcpRegisteredTools[name];
            if (!entry) { return; }
            if (ownerId !== undefined && entry.ownerId !== undefined && entry.ownerId !== ownerId) { return; }
            delete node.mcpRegisteredTools[name];
        };

        node.resolveMCPCall = function (callId, content) {
            const pending = node.mcpPendingCalls[callId];
            if (!pending) return;
            clearTimeout(pending.timer);
            delete node.mcpPendingCalls[callId];
            pending.resolve(content);
        };

        const mcpPath     = '/mcp/' + (config.path || 'server').replace(/^\/+/, '');
        const serverName  = config.name || ('hal2-mcp-' + config.path);
        const instructions = config.instructions || '';

        // Optional claim/value gate — same shape as the EventHandler's admin-tools gate.
        // Empty requiredValue → any authenticated user may use this server's tools (the
        // default, and the pre-existing behaviour). Set a value to restrict the whole server
        // to callers whose validated token carries that claim; others connect but see no
        // tools and cannot call any.
        const requiredClaim = (config.requiredClaim || 'groups').trim();
        // Default '' (allow all) only when never set. Empty string stays "any authenticated user".
        const requiredValue = (config.requiredValue === undefined ? '' : config.requiredValue).trim();

        node.log('hal2MCPServer registering route: POST ' + mcpPath);

        // Same hardening as the EventHandler's /mcp route (see lib/httpGuards.js).
        const { rateLimit, maxBody } = createHttpGuards({ warn: msg => node.warn(msg) });

        // Inherit the EventHandler's optional Host-header filtering so a standalone server
        // shares its hostname split. Empty (feature off, or single-host) → matches on path only.
        const expectedHost = eventHandler.mcpExpectedHost || '';

        // The whole decision surface — initialize, tools/list, tools/call, ping, and the
        // gates over them — lives in lib/mcp-rpc.js, shared with node-red-contrib-mcp-server
        // and unit-tested there. This handler is glue: authenticate, dispatch, write.
        const rpcDeps = {
            serverName, serverVersion: '1.0.0', instructions,
            requiredClaim, requiredValue,
            // A standalone server exposes only flow-defined tools; the built-in catalog and
            // its admin tools belong to the Event handler's embedded endpoint.
            adminToolsEnabled: false,
            adminTools: { TOOLS: [], TOOL_NAMES: new Set(), callTool: async () => '' },
            tools: node.mcpRegisteredTools,
            // Hands the call to the flow and waits for the matching hal2MCPOut, or times out.
            callTool: (name, timeoutMs, args, claims) => new Promise((resolve, reject) => {
                const callId = crypto.randomBytes(16).toString('hex');
                const timer  = setTimeout(() => {
                    delete node.mcpPendingCalls[callId];
                    reject(new Error('timeout'));
                }, timeoutMs);
                node.mcpPendingCalls[callId] = { resolve, reject, timer };
                node.emit('mcp_tool_' + name, { args, _mcpCallId: callId, _mcpClaims: claims });
            }),
            status: s => node.status(s)
        };

        const guard = hostFilter(expectedHost);
        // Tag the first middleware so removeOwnedRoutes can tell this node's chain from a sibling's.
        guard._mcpOwner = node.id;

        RED.httpNode.post(mcpPath, guard, rateLimit('mcp', 300), maxBody(1024 * 1024), async (req, res) => {
            const claims = await eventHandler.requireBearer(req, res);
            if (!claims) return;

            const out = await handleRpc(req.body, claims, rpcDeps);
            if (out.headers) res.set(out.headers);
            res.status(out.status);
            return out.body !== undefined ? res.json(out.body) : res.send('');
        });

        node.status({ fill: 'green', shape: 'dot', text: mcpPath });

        node.on('close', function () {
            for (const [, pending] of Object.entries(node.mcpPendingCalls)) {
                clearTimeout(pending.timer);
                pending.reject(new Error('MCP server closing'));
            }
            node.mcpPendingCalls = {};
            removeOwnedRoutes(RED.httpNode && RED.httpNode._router, 'post', mcpPath, node.id);
        });
    }

    RED.nodes.registerType('hal2MCPServer', hal2MCPServer);
};

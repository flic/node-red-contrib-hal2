const crypto = require('crypto');
const { createHttpGuards, hostFilter } = require('../lib/httpGuards');
const { claimSatisfied } = require('../lib/common');

function removeRoute(RED, path) {
    if (!RED.httpNode || !RED.httpNode._router) return;
    RED.httpNode._router.stack = RED.httpNode._router.stack.filter(layer => {
        if (!layer.route) return true;
        return !(layer.route.path === path && layer.route.methods['post']);
    });
}

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

        if (!eventHandler.requireBearer) {
            node.error('MCP is not enabled on the event handler');
            node.status({ fill: 'red', shape: 'ring', text: 'MCP not enabled on event handler' });
            return;
        }

        // ── Embedded mode ─────────────────────────────────────────────────────
        // Delegates tool registration and call resolution to the EventHandler.
        // Tools appear on the shared /mcp endpoint alongside built-in tools.

        if (config.mode === 'embedded') {
            node.registerMCPTool = (name, description, schema, timeoutSec) =>
                eventHandler.registerMCPTool(name, description, schema, timeoutSec);

            node.unregisterMCPTool = name =>
                eventHandler.unregisterMCPTool(name);

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

        node.mcpRegisteredTools = {};
        node.mcpPendingCalls    = {};

        node.registerMCPTool = function (name, description, schema, timeoutSec) {
            node.mcpRegisteredTools[name] = { description, schema, timeoutMs: timeoutSec * 1000 };
        };

        node.unregisterMCPTool = function (name) {
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

        const hasAccess = claims => claimSatisfied(claims, requiredClaim, requiredValue);

        node.log('hal2MCPServer registering route: POST ' + mcpPath);

        // Same hardening as the EventHandler's /mcp route (see lib/httpGuards.js).
        const { rateLimit, maxBody } = createHttpGuards({ warn: msg => node.warn(msg) });

        // Inherit the EventHandler's optional Host-header filtering so a standalone server
        // shares its hostname split. Empty (feature off, or single-host) → matches on path only.
        const expectedHost = eventHandler.mcpExpectedHost || '';

        RED.httpNode.post(mcpPath, hostFilter(expectedHost), rateLimit('mcp', 300), maxBody(1024 * 1024), async (req, res) => {
            const claims = await eventHandler.requireBearer(req, res);
            if (!claims) return;

            const allowed = hasAccess(claims);

            const body   = req.body || {};
            const id     = body.id     !== undefined ? body.id : null;
            const method = body.method || null;
            const params = body.params || {};

            const respond = result => res.status(200).json({ jsonrpc: '2.0', id, result });
            const rpcErr  = (c, m)  => res.status(200).json({ jsonrpc: '2.0', id, error: { code: c, message: m } });
            const toolOk  = text    => respond({ content: [{ type: 'text', text }] });

            if (method === 'initialize') {
                node.status({ fill: 'green', shape: 'dot', text: 'connected' });
                res.set('Cache-Control', 'no-store');
                // Don't leak tool names to callers who lack the required claim.
                const toolNames = allowed ? Object.keys(node.mcpRegisteredTools).join(', ') : '';
                return respond({
                    protocolVersion : '2024-11-05',
                    capabilities    : { tools: {} },
                    serverInfo      : { name: serverName, version: '1.0.0' },
                    instructions    : (instructions ? instructions + ' ' : '') +
                                      (toolNames ? 'Available tools: ' + toolNames + '.' : '')
                });
            }

            if (method === 'notifications/initialized') {
                return res.status(204).send('');
            }

            if (method === 'tools/list') {
                if (!allowed) return respond({ tools: [] });
                const tools = [];
                for (const [name, t] of Object.entries(node.mcpRegisteredTools)) {
                    const s = t.schema;
                    const inputSchema = (s && s.type === 'object') ? s : { type: 'object', properties: s || {} };
                    tools.push({ name, description: t.description, inputSchema });
                }
                return respond({ tools });
            }

            if (method === 'tools/call') {
                // Return the denial as a tool result (isError) rather than a JSON-RPC protocol
                // error — clients surface a result's text to the model, but collapse a protocol
                // error into a generic "tool execution failed" with no reason.
                if (!allowed) return respond({
                    content: [{ type: 'text', text: 'Access denied: your account lacks the required permission to use this server.' }],
                    isError: true
                });
                const toolName = params.name;
                const args     = params.arguments || {};
                node.status({ fill: 'blue', shape: 'dot', text: toolName });

                if (node.mcpRegisteredTools[toolName]) {
                    try {
                        const callId    = crypto.randomBytes(16).toString('hex');
                        const timeoutMs = node.mcpRegisteredTools[toolName].timeoutMs || 30000;
                        const result    = await new Promise((resolve, reject) => {
                            const timer = setTimeout(() => {
                                delete node.mcpPendingCalls[callId];
                                reject(new Error('timeout'));
                            }, timeoutMs);
                            node.mcpPendingCalls[callId] = { resolve, reject, timer };
                            node.emit('mcp_tool_' + toolName, { args, _mcpCallId: callId, _mcpClaims: claims });
                        });
                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return Array.isArray(result)
                            ? respond({ content: result })
                            : toolOk(result);
                    } catch (e) {
                        node.status({ fill: 'red', shape: 'dot', text: 'timeout' });
                        return toolOk(JSON.stringify({ error: e.message === 'timeout' ? 'Tool timed out: ' + toolName : e.message }));
                    }
                }

                return rpcErr(-32601, 'Unknown tool: ' + toolName);
            }

            return rpcErr(-32601, 'Unknown method: ' + (method || 'null'));
        });

        node.status({ fill: 'green', shape: 'dot', text: mcpPath });

        node.on('close', function () {
            for (const [, pending] of Object.entries(node.mcpPendingCalls)) {
                clearTimeout(pending.timer);
                pending.reject(new Error('MCP server closing'));
            }
            node.mcpPendingCalls = {};
            removeRoute(RED, mcpPath);
        });
    }

    RED.nodes.registerType('hal2MCPServer', hal2MCPServer);
};

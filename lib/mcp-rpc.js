'use strict';
// The MCP JSON-RPC dispatcher: everything that decides what a caller may see and do —
// initialize, tools/list, tools/call, ping — separated from Express and Node-RED so the
// whole decision surface is unit-testable. The mcp-server node's route handler is thin
// glue: authenticate, call handleRpc, write the described response.
//
// Side effects stay injected via deps: `callTool` performs the actual flow dispatch
// (pending-call promise, event emit, timeout) and `status` updates the node's editor
// badge. handleRpc itself never touches the network or the runtime.

const { createToolGate, visibleTools } = require('./claim-gate');

// handleRpc(body, claims, deps) → { status, headers?, body? }
//   body    — the parsed JSON-RPC request (may be null/undefined)
//   claims  — the caller's verified JWT claims (from requireBearer)
//   deps    — {
//     serverName, serverVersion, instructions,
//     requiredClaim, requiredValue,            // the server-wide claim gate
//     adminToolsEnabled, adminRequiredValue,   // admin gate value list
//     adminTools,                              // { TOOLS, TOOL_NAMES, callTool }
//     tools,                                   // live registry: name → { description, schema, timeoutMs, requiredValue }
//     callTool(name, timeoutMs, args, claims), // dispatch one dynamic tool call, resolves content
//     status(statusObj)                        // optional node.status passthrough
//   }
// An absent body field is missing from the result: body:undefined means "no JSON body"
// (used for the 204 notification ack).
async function handleRpc(body, claims, deps) {
    const {
        serverName, serverVersion, instructions = '',
        requiredClaim, requiredValue,
        adminToolsEnabled = false, adminRequiredValue = '',
        adminTools, tools, callTool,
        status = () => {}
    } = deps;

    body = body || {};
    const id     = body.id !== undefined ? body.id : null;
    const method = body.method || null;
    const params = body.params || {};

    const respond = (result, headers) => ({ status: 200, headers, body: { jsonrpc: '2.0', id, result } });
    const rpcErr  = (code, message)   => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });
    const toolOk  = text => respond({ content: [{ type: 'text', text }] });
    // Denials surfaced as a tool result (isError) rather than a JSON-RPC protocol error —
    // clients show a result's text to the model, but collapse a protocol error into a
    // generic "tool execution failed" with no reason.
    const denied  = text => respond({ content: [{ type: 'text', text }], isError: true });

    // One gate per request: `serverGranted` is the whole-server list, `allows(list)` adds a
    // tool's own list on top of it. Every tool — dynamic or admin — goes through `allows`.
    const gate    = createToolGate({ claims, claimName: requiredClaim, serverValue: requiredValue });
    const allowed = gate.serverGranted;
    const adminAllowed = adminToolsEnabled && gate.allows(adminRequiredValue);

    // The registry may be a plain object built by older code — never resolve caller-supplied
    // names ("__proto__", "constructor", …) through its prototype chain.
    const toolEntry = name =>
        Object.prototype.hasOwnProperty.call(tools, name) ? tools[name] : undefined;

    if (method === 'initialize') {
        status({ fill: 'green', shape: 'dot', text: 'connected' });
        // Don't leak tool names to callers who lack the required claim — neither the
        // server's own list nor any individual tool's. Same filter as tools/list.
        const toolNames = allowed ? [
            ...visibleTools(tools, gate).map(t => t.name),
            ...(adminAllowed ? [...adminTools.TOOL_NAMES] : [])
        ] : [];
        return respond({
            protocolVersion : '2024-11-05',
            capabilities    : { tools: {} },
            serverInfo      : { name: serverName, version: serverVersion },
            instructions    : (instructions ? instructions + ' ' : '') +
                              (toolNames.length ? 'Available tools: ' + toolNames.join(', ') + '.' : '')
        }, { 'Cache-Control': 'no-store' });
    }

    if (method === 'notifications/initialized') {
        return { status: 204 };
    }

    // MCP-level keepalive; some clients probe with it and treat an error as a dead server.
    if (method === 'ping') {
        return respond({});
    }

    if (method === 'tools/list') {
        if (!allowed) return respond({ tools: [] });
        const list = visibleTools(tools, gate);
        if (adminAllowed) list.push(...adminTools.TOOLS);
        return respond({ tools: list });
    }

    if (method === 'tools/call') {
        if (!allowed) {
            return denied('Access denied: your account lacks the required permission to use this server.');
        }
        const toolName = params.name;
        const args     = params.arguments || {};
        status({ fill: 'blue', shape: 'dot', text: toolName });

        const entry = toolEntry(toolName);
        if (entry) {
            // Per-tool gate, checked on every call rather than only at listing time.
            if (!gate.allows(entry.requiredValue)) {
                status({ fill: 'red', shape: 'ring', text: 'forbidden' });
                return denied('Access denied: the "' + toolName + '" tool requires a permission '
                    + 'your token does not have. This is a permission restriction, not a tool error.');
            }
            try {
                const result = await callTool(toolName, entry.timeoutMs || 30000, args, claims);
                status({ fill: 'green', shape: 'dot', text: 'ready' });
                return Array.isArray(result)
                    ? respond({ content: result })
                    : toolOk(result);
            } catch (e) {
                status({ fill: 'red', shape: 'dot', text: 'timeout' });
                return toolOk(JSON.stringify({ error: e.message === 'timeout' ? 'Tool timed out: ' + toolName : e.message }));
            }
        }

        if (adminTools.TOOL_NAMES.has(toolName)) {
            if (!adminToolsEnabled) return rpcErr(-32601, 'Unknown tool: ' + toolName);
            // Admin tools require a verified admin claim on every call — the
            // adminToolsEnabled flag alone is never sufficient to reach them.
            if (!gate.allows(adminRequiredValue)) {
                status({ fill: 'red', shape: 'ring', text: 'forbidden' });
                return denied('Access denied: the "' + toolName + '" tool requires admin privileges, '
                    + 'which your token does not have. This is a permission restriction, not a tool error.');
            }
            try {
                const result = await adminTools.callTool(toolName, args);
                status({ fill: 'green', shape: 'dot', text: 'ready' });
                return toolOk(result);
            } catch (e) {
                if (e.rpcCode) return rpcErr(e.rpcCode, e.message);
                status({ fill: 'red', shape: 'ring', text: 'admin error' });
                return toolOk('Admin call error: ' + e.message);
            }
        }

        return rpcErr(-32601, 'Unknown tool: ' + toolName);
    }

    return rpcErr(-32601, 'Unknown method: ' + (method || 'null'));
}

module.exports = { handleRpc };

module.exports = function(RED) {
    function hal2Api(config) {
        RED.nodes.createNode(this, config);
        this.eventHandler    = RED.nodes.getNode(config.eventHandler);
        this.allowAdminTools = config.allowAdminTools === true;
        var node = this;

        node.status({});

        node.on('input', async function(msg, send, done) {
            // Node-RED >=1.0 always provides send/done; keep a guard for safety.
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            const fail = (message, code) => {
                node.status({ fill: 'red', shape: 'dot', text: 'error' });
                msg.payload = { ok: false, error: { code: code || -32000, message: message } };
                send(msg);
                done();
            };

            if (!node.eventHandler || typeof node.eventHandler.callTool !== 'function') {
                return fail('No event handler connected (or it does not expose callTool)');
            }

            // Accept { tool, args } on msg.payload; allow msg.tool / msg.args to override.
            // A JSON string payload is auto-parsed for convenience (e.g. an inject/http node
            // that emitted a string rather than an object).
            let payload = msg.payload;
            if (typeof payload === 'string' && payload.trim().startsWith('{')) {
                try { payload = JSON.parse(payload); } catch (e) { /* handled below */ }
            }
            if (!payload || typeof payload !== 'object') payload = {};
            const tool = msg.tool || payload.tool;
            const args = msg.args || payload.args || {};

            if (!tool || typeof tool !== 'string') {
                const hint = (typeof msg.payload === 'string')
                    ? ' — msg.payload is a string; set the inject node type to JSON (or add a json node before this) so it becomes an object'
                    : '';
                return fail('Missing "tool" — provide msg.payload.tool (e.g. "get_state")' + hint, -32602);
            }

            node.status({ fill: 'blue', shape: 'dot', text: tool });

            try {
                const out = await node.eventHandler.callTool(
                    tool, args, msg.claims || null, { adminEnabled: node.allowAdminTools }
                );

                if (!out || out.ok !== true) {
                    return fail((out && out.message) || 'Tool call failed', out && out.code);
                }

                let result;
                if (out.content !== undefined) {
                    // MCP content array (images / dynamic tools) — pass through verbatim.
                    result = out.content;
                } else {
                    // Tool results are JSON strings; fall back to raw text (e.g. get_flow markdown).
                    try { result = JSON.parse(out.text); }
                    catch (e) { result = out.text; }
                }

                node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                msg.payload = { ok: true, result: result };
                send(msg);
                done();
            } catch (err) {
                node.error('hal2Api callTool error: ' + err.message, msg);
                return fail(err.message);
            }
        });
    }
    RED.nodes.registerType("hal2Api", hal2Api);
};

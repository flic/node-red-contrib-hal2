module.exports = function (RED) {

    function hal2MCPIn(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // The tool goes into the event handler's catalogue, served at its /mcp. Before 4.0.0 it
        // went through a hal2MCPServer node (`mcpServer`), which no longer exists; such a node is
        // said so, rather than left looking unconfigured.
        const eventHandler = RED.nodes.getNode(config.eventHandler);
        if (!eventHandler) {
            const legacy = !config.eventHandler && config.mcpServer;
            node.error(legacy
                ? 'Points at a hal2MCPServer, removed in 4.0.0. Convert the flows in the editor.'
                : 'No event handler configured');
            node.status({ fill: 'red', shape: 'ring', text: legacy ? 'hal2MCPServer removed — convert' : 'no event handler' });
            return;
        }

        const toolName   = config.toolName;
        const timeoutSec = Number(config.timeout || 30);
        const topic      = config.topic || toolName;

        let schema;
        try {
            schema = config.inputSchema ? JSON.parse(config.inputSchema) : { type: 'object', properties: {} };
        } catch (e) {
            node.error('Invalid input schema JSON: ' + e.message);
            schema = { type: 'object', properties: {} };
        }

        // Per-tool gate: a comma-separated any-of list against the event handler's access claim,
        // on top of its read list — and its write list too for a write tool, the default, so a
        // tool nobody classified is held to the stricter gate. Arguments are checked against the
        // schema unless Validate is switched off; older nodes, saved without either field, get
        // the defaults.
        eventHandler.registerMCPTool(toolName, config.description, schema, timeoutSec,
            (config.requiredValue || '').trim(), node.id,
            { access: config.access, validate: config.validateArgs });

        const exposeClaims = config.exposeClaims === true;

        node.listener = function ({ args, _mcpCallId, _mcpClaims }) {
            node.status({ fill: 'blue', shape: 'dot', text: 'called' });
            const msg = {
                payload    : args,
                _mcpCallId : _mcpCallId,
                topic      : topic
            };
            if (exposeClaims && _mcpClaims) msg.jwtClaims = _mcpClaims;
            node.send(msg);
            setTimeout(() => node.status({ fill: 'green', shape: 'dot', text: 'ready' }), 1000);
        };

        eventHandler.on('mcp_tool_' + toolName, node.listener);
        node.status({ fill: 'green', shape: 'dot', text: 'ready' });

        node.on('close', function () {
            eventHandler.unregisterMCPTool(toolName, node.id);
            eventHandler.removeListener('mcp_tool_' + toolName, node.listener);
        });
    }

    RED.nodes.registerType('hal2MCPIn', hal2MCPIn);
};

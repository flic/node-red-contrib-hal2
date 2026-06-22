module.exports = function (RED) {

    function hal2MCPIn(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        const mcpServer = RED.nodes.getNode(config.mcpServer);
        if (!mcpServer) {
            node.error('No MCP server configured');
            node.status({ fill: 'red', shape: 'ring', text: 'no MCP server' });
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

        mcpServer.registerMCPTool(toolName, config.description, schema, timeoutSec);

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

        mcpServer.on('mcp_tool_' + toolName, node.listener);
        node.status({ fill: 'green', shape: 'dot', text: 'ready' });

        node.on('close', function () {
            mcpServer.unregisterMCPTool(toolName);
            mcpServer.removeListener('mcp_tool_' + toolName, node.listener);
        });
    }

    RED.nodes.registerType('hal2MCPIn', hal2MCPIn);
};

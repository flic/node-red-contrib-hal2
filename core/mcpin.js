module.exports = function (RED) {

    function hal2MCPIn(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.eventHandler = RED.nodes.getNode(config.eventHandler);
        if (!node.eventHandler) {
            node.error('No event handler configured');
            node.status({ fill: 'red', shape: 'ring', text: 'no event handler' });
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

        node.eventHandler.registerMCPTool(toolName, config.description, schema, timeoutSec);

        node.listener = function ({ args, _mcpCallId }) {
            node.status({ fill: 'blue', shape: 'dot', text: 'called' });
            node.send({
                payload    : args,
                _mcpCallId : _mcpCallId,
                topic      : topic
            });
            setTimeout(() => node.status({ fill: 'green', shape: 'dot', text: 'ready' }), 1000);
        };

        node.eventHandler.on('mcp_tool_' + toolName, node.listener);
        node.status({ fill: 'green', shape: 'dot', text: 'ready' });

        node.on('close', function () {
            if (node.eventHandler) {
                node.eventHandler.unregisterMCPTool(toolName);
                node.eventHandler.removeListener('mcp_tool_' + toolName, node.listener);
            }
        });
    }

    RED.nodes.registerType('hal2MCPIn', hal2MCPIn);
};

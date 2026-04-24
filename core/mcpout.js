module.exports = function (RED) {

    function hal2MCPOut(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.eventHandler = RED.nodes.getNode(config.eventHandler);
        if (!node.eventHandler) {
            node.error('No event handler configured');
            node.status({ fill: 'red', shape: 'ring', text: 'no event handler' });
            return;
        }

        node.status({ fill: 'grey', shape: 'ring', text: 'idle' });

        node.on('input', function (msg) {
            const callId = msg._mcpCallId;
            if (!callId) {
                node.error('msg._mcpCallId is missing');
                node.status({ fill: 'red', shape: 'dot', text: 'missing _mcpCallId' });
                return;
            }
            const payload = msg.payload;
            const isEmpty = payload === null || payload === undefined ||
                (Array.isArray(payload) && payload.length === 0) ||
                payload === '';
            let content;
            if (isEmpty) {
                content = msg.emptyMessage || config.emptyMessage || 'No results found.';
            } else {
                content = Array.isArray(payload)
                    ? payload
                    : (typeof payload === 'string' ? payload : JSON.stringify(payload));
            }
            node.eventHandler.resolveMCPCall(callId, content);
            node.status({ fill: 'green', shape: 'dot', text: 'responded' });
            setTimeout(() => node.status({ fill: 'grey', shape: 'ring', text: 'idle' }), 1000);
        });
    }

    RED.nodes.registerType('hal2MCPOut', hal2MCPOut);
};

module.exports = function(RED) {
    function hal2Value(config) {
        RED.nodes.createNode(this,config);
        this.thing = config.thing;
        this.item = config.item;
        this.outputValue = config.outputValue;
        this.outputType = config.outputType;
        this.heartbeat = config.heartbeat;
        var node = this;

        node.on('input', function(msg) {
            var thing = RED.nodes.getNode(node.thing);

            if (!thing.state.hasOwnProperty(node.item)) {
                // No value stored in item
                return;
            }

            switch (node.outputType) {
                case 'flow':
                    node.context().flow.set(node.outputValue,thing.state[node.item]);
                    break;
                case 'global':
                    node.context().global.set(node.outputValue,thing.state[node.item]);
                    break;
                case 'msg':
                    msg[node.outputValue] = thing.state[node.item];
                    break;
            }
            if (node.heartbeat) {
                msg.heartbeat = thing.heartbeat[node.item];
            }
            node.send(msg);
        });
    }
    RED.nodes.registerType("hal2Value",hal2Value);
}
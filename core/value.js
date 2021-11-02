module.exports = function(RED) {
    function hal2Value(config) {
        RED.nodes.createNode(this,config);
        this.thing = config.thing;
        this.item = config.item;
        this.outputValue = config.outputValue;
        this.outputType = config.outputType;
        this.info = config.info;
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
            if (node.info) {
                var i;
                for (i in thing.thingType.items) {
                    if (thing.thingType.items[i].id == node.item) { break; }
                }
                msg.thing = {
                    name: thing.name,
                    id: thing.id,
                    last_update: thing.heartbeat[node.item]
                }
                msg.item = {
                    name: thing.thingType.items[i].name,
                    id: thing.thingType.items[i].id,
                    last_update: thing.heartbeat[node.item]
                }
            }
            node.send(msg);
        });
    }
    RED.nodes.registerType("hal2Value",hal2Value);
}
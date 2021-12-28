module.exports = function(RED) {
    var common = require("../lib/common");

    function hal2Action(config) {
        RED.nodes.createNode(this,config);
        this.eventHandler = RED.nodes.getNode(config.eventHandler);
        this.name = config.name;
        this.commandset = config.commandset;
        this.ratelimit = Number(config.ratelimit);
        var node = this;

        node.on('input', function(msg) {
            var command = {};
            var queue = [];

            for (let i = 0; i < node.commandset.length; i += 1) {
                command = {
                    payload: "",
                    item: "",
                    thing: ""
                };

                switch (node.commandset[i].type) {
                    case 'msg':
                        command.payload = RED.util.getMessageProperty(msg,node.commandset[i].value);
                        break;
                    case 'flow':
                        command.payload = node.context().flow.get(node.commandset[i].value);
                        break;
                    case 'global':
                        command.payload = node.context().global.get(node.commandset[i].value);
                        break;
                    case 'env':
                        command.payload = process.env[node.commandset[i].value];
                        break;
                    default:
                        command.payload = RED.util.evaluateNodeProperty(node.commandset[i].value,node.commandset[i].type);
                }

                if (node.commandset[i].category == 'dynamic') {
                    if ((typeof msg.thing !== 'undefined') && (typeof msg.thing.id !== 'undefined')) {
                        var thing = RED.nodes.getNode(msg.thing.id);
                        if (thing === null) {
                            node.error("Can't find thing with id "+msg.thing.id);
                        } else if (thing.type !== 'hal2Thing') {
                            node.error("Node with id "+msg.thing.id+ " isn't a thing");
                        } else if (thing.thingType.id !== node.commandset[i].thing) {
                            node.error("Node with id "+msg.thing.id+ " is of the wrong type");
                        } else {
                            command.thing = msg.thing.id;
                            command.item = node.commandset[i].item;
                            queue.push(command);                            
                        }
                    } else {
                        node.error("thing.id missing from payload");
                    }
                } else {
                    command.item = node.commandset[i].item;
                    command.thing = node.commandset[i].thing;
                    queue.push(command);
                }
            }
            common.queueSend(node,queue);
        });
    }
    RED.nodes.registerType("hal2Action",hal2Action);
}
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
                    item: ""
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
                }
                command.item = node.commandset[i].item;
                queue.push(command);
            }
            common.queueSend(node,queue);
        });
    }
    RED.nodes.registerType("hal2Action",hal2Action);
}
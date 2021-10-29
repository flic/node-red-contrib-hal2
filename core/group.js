module.exports = function(RED) {
    var common = require("../lib/common");

    function hal2Group(config) {
        RED.nodes.createNode(this,config);
        this.eventHandler = RED.nodes.getNode(config.eventHandler);
        this.name = config.name;
        this.group = config.group;
        this.ratelimit = Number(config.ratelimit);
        this.input = config.input;
        this.output = config.output;
        var node = this;
        var events = [];

        function sendCommand(payload) {
            var command;
            var queue = [];
            for (var i = 0; i < node.group.length; i += 1) {
                command = {
                    item: node.group[i].item,
                    payload: payload
                }
                queue.push(command);
            }
            common.queueSend(node,queue);              
        }

        if (node.eventHandler) {
            node.updateListener = function(id, payload) {
                node.eventHandler.publish("update",node.id,payload);
            }

            node.commandListener = function(id, payload) {
                sendCommand(payload);
            }

            // Start listening for events
            for (let g in node.group) {
                node.eventHandler.subscribe('update', node.group[g].item, node.updateListener);
            }
            node.eventHandler.subscribe('command', node.id, node.commandListener);
        }

        node.on("close",function() { 
            if (node.eventHandler) {
                for (let g in events) {
                    node.eventHandler.unsubscribe('update', node.group[g].item, node.listener);
                }
                node.eventHandler.unsubscribe('command', node.id, node.commandListener);
            }
        });

        node.on('input', function(msg) {
            sendCommand(msg.payload);
        });
    }
    RED.nodes.registerType("hal2Group",hal2Group);
}
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
                    thing: node.group[i].thing,
                    item: node.group[i].item,
                    payload: payload
                }
                queue.push(command);
            }
            common.queueSend(node,queue);              
        }

        if (node.eventHandler) {
            node.updateListener = function(thingid, itemid, payload) {
                var match = false;
                for (let g in node.group) {
                    if ((node.group[g].thing == thingid) && (node.group[g].item == itemid)) {
                        match = true;
                        break;
                    }
                }
                if (match) {
                    node.eventHandler.publish("update",node.id,node.id,payload);
                    node.send(payload);
                }
            }

            node.commandListener = function(thingid, itemid, payload) {
                sendCommand(payload);
            }

            // Start listening for events
            var things = [];
            for (let g in node.group) {
                things.push(node.group[g].thing);
            }
            var uniqueThings = [...new Set(things)];
            for (let t in uniqueThings) {
                node.eventHandler.subscribe('update', uniqueThings[t], node.updateListener);
            }
            node.eventHandler.subscribe('command', node.id, node.commandListener);
        }

        node.on("close",function() { 
            if (node.eventHandler) {
                var things = [];
                for (let g in node.group) {
                    things.push(node.group[g].thing);
                }
                var uniqueThings = [...new Set(things)];
                uniqueThings = Array.from(uniqueThings);
                for (let t in uniqueThings) {
                    node.eventHandler.unsubscribe('update', uniqueThings[t], node.updateListener);
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
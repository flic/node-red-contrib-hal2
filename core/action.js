module.exports = function(RED) {
    var common = require("../lib/common");

    function hal2Action(config) {
        RED.nodes.createNode(this,config);
        this.eventHandler = RED.nodes.getNode(config.eventHandler);
        this.name = config.name;
        this.commandset = config.commandset;
        this.ratelimit = Number(config.ratelimit);
        this.passthru = config.passthru || false;
        var node = this;

        node.on('input', function(msg,send,done) {
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
                    var id = common.thingIdFromMsg(RED,node,node.commandset[i].thing,msg);
                    if (typeof id != 'undefined') {
                        command.thing = id;
                        command.item = node.commandset[i].item;
                        queue.push(command); 
                    }
                } else {
                    command.item = node.commandset[i].item;
                    command.thing = node.commandset[i].thing;
                    queue.push(command);
                }
            }
            common.queueSend(node,queue,null,function(){
                if (node.passthru) { send(msg); }
                done();
            });
        });
    }
    RED.nodes.registerType("hal2Action",hal2Action);
}
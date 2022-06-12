module.exports = function(RED) {
    function hal2Log(config) {
        RED.nodes.createNode(this,config);
        this.eventHandler = RED.nodes.getNode(config.eventHandler);
        this.onchange = config.onchange;
        var node = this;

        if (node.eventHandler) {
            node.listener = function(event) {
                    var msg = RED.util.cloneMessage(event);
                    msg._msgid = RED.util.generateId();

                    if (event.logtype == 'ingress') {
                        if (((node.onchange) && (event.state != event.laststate)) || (!node.onchange)){
                            node.send(msg);
                        }
                    } else {
                        node.send(msg);
                    }
            }

            // Start listening for events
            node.eventHandler.subscribe('log', '' , node.listener);
        }
            
        node.on("close",function() { 
            if (node.eventHandler) {
                node.eventHandler.unsubscribe('log', '', node.listener);
            }
        });
    }
    RED.nodes.registerType("hal2Log",hal2Log);
}
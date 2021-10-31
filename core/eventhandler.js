module.exports = function(RED) {
    function hal2EventHandler(config) {
        RED.nodes.createNode(this,config);
        this.host = config.name;
        this.maxlisteners = config.maxlisteners;
        this.checkHeartbeat = config.checkHeartbeat;
        this.heartbeat = config.heartbeat;
        var node = this;

        node.debug("Max listeners set to "+node.maxlisteners);
        node.setMaxListeners(Number(node.maxlisteners));

        if (this.heartbeat) {
            node.debug("Heartbeat check interval set to "+node.heartbeat);
            setInterval(function(){
                // Check all Things for heartbeat
                node.error("heartbeat check");
            }, this.heartbeat*1000);
        }

        node.subscribe = function (event, id, listener) {
            let eventStr = event+"_"+id;
            this.addListener(eventStr, listener)
            node.debug("Added listener for event "+eventStr+", number of listeners: "+this.listenerCount(eventStr))
        }

        node.unsubscribe = function (event, id, listener) {
            let eventStr = event+"_"+id;
            this.removeListener(eventStr, listener)
            node.debug("Removed listener for event "+eventStr+", number of listeners: "+this.listenerCount(eventStr))
        }

        node.publish = function (event, thingid, itemid, payload) {
            //Events:
            //update - item value updated
            //command - execute command
            let eventStr = event+"_"+thingid;
            node.debug("Event: "+eventStr);
            this.emit(eventStr, thingid, itemid, payload);
        }

    }
    RED.nodes.registerType("hal2EventHandler",hal2EventHandler);
}
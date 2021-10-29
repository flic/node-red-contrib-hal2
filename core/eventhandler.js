module.exports = function(RED) {
    function hal2EventHandler(config) {
        RED.nodes.createNode(this,config);
        this.host = config.name;
        this.maxlisteners = config.maxlisteners;
        var node = this;

        node.debug("Max listeners set to "+node.maxlisteners);
        node.setMaxListeners(Number(node.maxlisteners));

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

        node.publish = function (event, id, payload) {
            //Events:
            //update - item value updated
            //command - execute command
            let eventStr = event+"_"+id;
            node.debug("Event: "+eventStr);
            this.emit(eventStr, id, payload);
        }

    }
    RED.nodes.registerType("hal2EventHandler",hal2EventHandler);
}
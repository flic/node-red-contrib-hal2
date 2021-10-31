module.exports = function(RED) {
    function hal2EventHandler(config) {
        RED.nodes.createNode(this,config);
        this.host = config.name;
        this.maxlisteners = config.maxlisteners;
        this.checkHeartbeat = config.checkHeartbeat;
        this.heartbeat = config.heartbeat;
        var node = this;
        var hbList = [];

        node.debug("Max listeners set to "+node.maxlisteners);
        node.setMaxListeners(Number(node.maxlisteners));

        function checkHeartbeat() {
            // Check all Things for heartbeat
            var thing;
            const date = Date.now();
            var online;
            for (let n in hbList) {
                thing = RED.nodes.getNode(hbList[n].id);
                if (date-thing.thingType.hbTTL > thing.heartbeat) {
                    online=false;
                } else {
                    online=true;
                }

                if (online != thing.state[1]) {
                    thing.state['1'] = online;
                    thing.laststate['1'] = !online;
                    thing.heartbeat['1'] = date;
                    thing.showState();
                }
            }            
        }

        if (this.heartbeat) {
            node.debug("Heartbeat check interval set to "+node.heartbeat);
            setTimeout(checkHeartbeat, 5000);
            setInterval(checkHeartbeat, this.heartbeat*1000);
        }

        node.registerHeartbeat = function (id, ttl) {
            var hb = {
                id: id,
                ttl: ttl
            }
            hbList.push(hb);
            node.debug("Added heartbeat TTL check for "+id);
        }

        node.unregisterHeartbeat = function (id) {
            var tempArray = [];
            for (let i in hbList) {
                if (hbList[i].id != id) { tempArray.push(hbList[i])}
            }
            hbList = [...tempArray];
            node.debug("Removed heartbeat TTL check for "+id);
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
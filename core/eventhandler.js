module.exports = function(RED) {
    function hal2EventHandler(config) {
        RED.nodes.createNode(this,config);
        this.host           = config.name;
        this.contextStore   = config.contextStore;
        this.maxlisteners   = config.maxlisteners;
        this.checkHeartbeat = config.checkHeartbeat;
        this.heartbeat      = config.heartbeat;

        if (typeof this.contextStore == 'undefined') { this.contextStore = ''; }

        var node = this;
        var hbList = [];

        node.debug("Max listeners set to "+node.maxlisteners);
        node.setMaxListeners(Number(node.maxlisteners));

        function checkHeartbeat() {
            // Check all Things for heartbeat
            node.debug("Check heartbeat");
            var thing;
            let date = Date.now();
            var online;
            for (let n in hbList) {
                thing = RED.nodes.getNode(hbList[n].id);
                if (thing.id in thing.heartbeat) {
                    if (date < (Number(thing.thingType.hbTTL)*1000)+thing.heartbeat[thing.id]) {
                        online=true;
                    } else {
                        online=false;
                    }
                } else {
                    online=false;
                }

                if (online != thing.state['1']) {
                    if (!online) {
                        node.debug("Heartbeat: "+thing.name+" offline")
                    }
                    thing.updateState([],'1',false,'heartbeat');
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

//        node.publish = function (event, thingtypeid, thingid, itemid, payload) {
//            //Events:
//            //update - item value updated
//            //command - execute command
//            //Emit events for both Thing and ThingType
//            node.debug("Event: "+eventStr);
//            this.emit(event+"_"+thingtypeid, thingtypeid, thingid, itemid, payload);
//            this.emit(event+"_"+thingid, thingtypeid, thingid, itemid, payload);
//        }

        node.publishCommand = function (id, itemid, payload) {
            node.debug("Command event: Id "+id+" Item "+itemid);
            this.emit("command_"+id, itemid, payload);
        }

        node.publishUpdate = function (thingtypeid, thingid, itemid, payload) {
            //Emit events for both Thing and ThingType
            if (thingtypeid !== null) {
                node.debug("Update event: Thingtype "+thingtypeid+" Item "+itemid);
                this.emit("update_"+thingtypeid, thingtypeid, thingid, itemid, payload);
            }
            node.debug("Update event: Thing "+thingid+" Item "+itemid);
            this.emit("update_"+thingid, thingtypeid, thingid, itemid, payload);
        }

        node.publishLog = function (payload) {
            node.debug("Log event");
            this.emit("log_", payload);
        }
    }
    RED.nodes.registerType("hal2EventHandler",hal2EventHandler);
}
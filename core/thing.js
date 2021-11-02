module.exports = function(RED) {
    function matchTopic(ts,t) {
        if (ts == "#") {
            return true;
        }
        /* The following allows shared subscriptions (as in MQTT v5)
           http://docs.oasis-open.org/mqtt/mqtt/v5.0/cs02/mqtt-v5.0-cs02.html#_Toc514345522
           4.8.2 describes shares like:
           $share/{ShareName}/{filter}
           $share is a literal string that marks the Topic Filter as being a Shared Subscription Topic Filter.
           {ShareName} is a character string that does not include "/", "+" or "#"
           {filter} The remainder of the string has the same syntax and semantics as a Topic Filter in a non-shared subscription. Refer to section 4.7.
        */
        else if(ts.startsWith("$share")){
            ts = ts.replace(/^\$share\/[^#+/]+\/(.*)/g,"$1");

        }
        var re = new RegExp("^"+ts.replace(/([\[\]\?\(\)\\\\$\^\*\.|])/g,"\\$1").replace(/\+/g,"[^/]+").replace(/\/#$/,"(\/.*)?")+"$");
        return re.test(t);
    }

    //a=msg.topic, b=filter
    var topicFilter = {
        'str': function (a, b) { return a === b; },
        're': function (a, b) { return (new RegExp(b)).test(a+""); },
        'mqtt': function (a,b) { return matchTopic(b,a); },
        'StrStart': function (a,b) { return (a.startsWith(b)) },
        'StrEnd': function (a,b) { return (a.endsWith(b)) },
        'StrContain': function (a,b) { return (a.includes(b)) }
    };

    function hal2Thing(config) {
        RED.nodes.createNode(this,config);

        this.thingType = RED.nodes.getNode(config.thingType);
        this.eventHandler = RED.nodes.getNode(config.eventHandler);
        this.name = config.name;
        this.notes = config.notes;
        this.topicPrefix = config.topicPrefix;
        this.topicFilter = config.topicFilter;
        this.topicFilterType = config.topicFilterType;
        var node = this;
        var nodeContext = this.context();

        node.laststate = nodeContext.get("laststate",node.thingType.contextStore);
        node.state = nodeContext.get("state",node.thingType.contextStore);
        node.heartbeat = nodeContext.get("heartbeat",node.thingType.contextStore);
        if (typeof node.laststate === 'undefined') { node.laststate = {}; }
        if (typeof node.state === 'undefined') { node.state = {}; }
        if (typeof node.heartbeat === 'undefined') { node.heartbeat = {}; }

        node.showState = function () {
            var statusMsg = [];

            // Heartbeat
            if (node.thingType.hbCheck) {
                statusMsg["shape"] = "dot";

                if (node.state[1] === 'undefined') { statusMsg["fill"] = "gray"; }
                if (node.state[1] === true) { statusMsg["fill"] = "green"; }
                if (node.state[1] === false) { statusMsg["fill"] = "red"; }
            }

            if ((typeof node.thingType.nodestatus === 'undefined') || (node.thingType.nodestatus == '')) { 
                node.status(statusMsg);
            } else {            
                var stateStr = node.thingType.nodestatus;
                for (let i in node.thingType.items) {
                    if (typeof node.state[node.thingType.items[i].id] === 'undefined') {
                        stateStr = stateStr.replace("%"+node.thingType.items[i].name,'no value');
                    } else {
                        stateStr = stateStr.replace("%"+node.thingType.items[i].name,node.state[node.thingType.items[i].id]);
                    }
                }
                statusMsg["text"] = stateStr;
                node.status(statusMsg);
            }
        }
            
        node.showState();

        node.on('input', function(msg) {
            var eventmsg;
            var result;
            var _ingressFn;
            var msgClone;

            if (node.topicFilter) {
                if (topicFilter[node.topicFilterType](msg.topic,node.topicFilter) === false) { return; }
            }

            if (!node.thingType.items) {
                node.debug("No items configured. Dropping message.");
                return;
            }

            for (var i in node.thingType.items) {
                if (node.thingType.items[i].topicFilterValue) {
                    if (topicFilter[node.thingType.items[i].topicFilterType](msg.topic,node.thingType.items[i].topicFilterValue) == false) { continue; }
                }

                for (let n in node.thingType.ingress) {
                    if (node.thingType.ingress[n].id == node.thingType.items[i].ingress){
                        var fn = node.thingType.ingress[n].fn;
                        break;
                    }
                }

                msgClone = RED.util.cloneMessage(msg);
                _ingressFn = new Function('msg',fn);
                try {
                    result = _ingressFn(msgClone);
                } catch (err) {
                    node.error("Error running ingress for "+node.thingType.items[i].name+": "+err);
                }
                if (result != null) {
                    node.debug("State "+node.thingType.items[i].name+"["+node.thingType.items[i].id+"] set to value '"+result+"'");
                    node.laststate[node.thingType.items[i].id] = node.state[node.thingType.items[i].id];
                    node.state[node.thingType.items[i].id] = result;
                    node.heartbeat[node.thingType.items[i].id] = Date.now();
                    node.heartbeat[node.id] = Date.now();

                    // Save to node context
                    nodeContext.set("laststate",node.laststate,node.thingType.contextStore);
                    nodeContext.set("state",node.state,node.thingType.contextStore);
                    eventmsg = {
                        _msgid: RED.util.generateId(),
                        state: result,
                        laststate: node.laststate[node.thingType.items[i].id],
                        topic: msg.topic,
                        payload: result,
                        thing: {
                            name: node.name,
                            id: node.id,
                            last_update: node.heartbeat[node.id]
                        },
                        item: {
                            name: node.thingType.items[i].name,
                            id: node.thingType.items[i].id,
                            last_update: node.heartbeat[node.thingType.items[i].id]
                        }
                    }
                    node.eventHandler.publish('update',node.id,node.thingType.items[i].id,eventmsg);
                    node.eventHandler.publish('update',node.thingType.id,node.thingType.items[i].id,eventmsg);
                    node.showState();
                }
            }
        });

        if (node.eventHandler) {
            node.listener = function(thingid, itemid, payload) {
                var item;

                if (!node.thingType.items) {
                    node.debug("No items configured. Dropping message.");
                    return;
                }
    
                for (i in node.thingType.items) {
                    if (node.thingType.items[i].id == itemid){
                        item = node.thingType.items[i];
                        break;
                    }
                }

                if (!item) {
                    node.error("Item ["+id+"] undefined.");
                    return;
                }

                if (item.readOnly) {
                    node.error("Item "+item.name+"["+item.id+"] is read only");
                    return;
                }

                var command = {
                    _msgid: RED.util.generateId(),
                    topic: node.topicPrefix + item.topicSuffix,
                    payload: payload
                }

                for (let i in node.thingType.egress) {
                    if (node.thingType.egress[i].id == item.egress){
                        var fn = node.thingType.egress[i].fn;
                        break;
                    }
                }
             
                let _egressFn = new Function('msg',fn);
                try {
                    command = _egressFn(command);
                } catch (err) {
                    node.error("Error running egress for "+item.name+": "+err);
                }
                if (command != null) {
                    node.send(command);
                }
            }

            // Start listening for events
            node.eventHandler.subscribe('command', node.id, node.listener);

            // Register heartbeat check
            if ((node.thingType.hbCheck) && (node.thingType.hbType == "ttl")) {
                node.eventHandler.registerHeartbeat(node.id,node.thingType.hbTTL);
            }
        }
        
        node.on("close",function() { 
            if (node.eventHandler) {
                node.eventHandler.unsubscribe('command', node.id, node.listener);
                if ((node.thingType.hbCheck) && (node.thingType.hbType == "ttl")) {
                    node.eventHandler.unregisterHeartbeat(node.id);
                }
            }

        });
    }
    RED.nodes.registerType("hal2Thing",hal2Thing);
}
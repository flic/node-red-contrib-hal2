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

    function fixTopic(topicstring,configuredTopic) {
        var topic = topicstring;
        if (topic.startsWith('.')) {
            topic = topic.replace('.',configuredTopic);
        }
        if (topic.startsWith('/')) {
            topic = configuredTopic + topic;
        }
        return topic;
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
        this.attributes = config.attributes;
        var node = this;
        var nodeContext = this.context();

        node.laststate = nodeContext.get("laststate",node.thingType.contextStore);
        node.state = nodeContext.get("state",node.thingType.contextStore);
        node.heartbeat = nodeContext.get("heartbeat",node.thingType.contextStore);
        if (typeof node.thingType.filterFunction === 'undefined') { node.thingType.filterFunction = '0'; }
        if (typeof node.laststate === 'undefined') { node.laststate = {}; }
        if (typeof node.state === 'undefined') { node.state = {}; }
        if (typeof node.heartbeat === 'undefined') { node.heartbeat = {}; }

        function getAttributes() {
            var attribute = [];
            if (typeof node.thingType.attributes === 'object') {
                for (d in node.thingType.attributes) {
                    attribute[node.thingType.attributes[d].name] = ""
                    if (typeof node.attributes === 'object') {
                        for (let a in node.attributes) {
                            if (node.attributes[a].id == node.thingType.attributes[d].id) {
                                attribute[node.thingType.attributes[d].name] = node.attributes[a].val;
                                break;
                            }
                        }
                    
                    }
                }
            }
            return attribute;
        }

        function statusUpdate(msg) {
            var eventmsg;
            var result;
            var _ingressFn;
            var msgClone;
            var attribute;

            if (node.topicFilter) {
                if (topicFilter[node.topicFilterType](msg.topic,node.topicFilter) === false) { return; }
            }

            if (!node.thingType.items) {
                node.debug("No items configured. Dropping message.");
                return;
            }

            if (node.thingType.filterFunction != '0') {
                for (let n in node.thingType.ingress) {
                    if (node.thingType.ingress[n].id == node.thingType.filterFunction){
                        var fn = node.thingType.ingress[n].fn;
                        break;
                    }
                }
                var attribute = getAttributes();
                msgClone =  RED.util.cloneMessage(msg);
                _ingressFn = new Function('msg','attribute',fn);
                try {
                    result = _ingressFn(msgClone,attribute);
                } catch (err) {
                    node.error("Error running filter ingress: "+err);
                    return;
                }
                if (result != true) { return; }
            }

            for (var i in node.thingType.items) {
                if ((node.thingType.items[i].id == '1') && (node.thingType.hbType == 'ttl')) { continue; }

                if (node.thingType.items[i].topicFilterValue) {
                    var topic = node.thingType.items[i].topicFilterValue;
                    if (node.thingType.items[i].topicFilterType == 'str') {
                        topic = fixTopic(topic,node.topicPrefix);
                    }
                    if (topicFilter[node.thingType.items[i].topicFilterType](msg.topic,topic) == false) { continue; }
                }

                for (let n in node.thingType.ingress) {
                    if (node.thingType.ingress[n].id == node.thingType.items[i].ingress){
                        var fn = node.thingType.ingress[n].fn;
                        break;
                    }
                }

                msgClone = RED.util.cloneMessage(msg);
                attribute = getAttributes();
                _ingressFn = new Function('msg','attribute',fn);
                try {
                    result = _ingressFn(msgClone,attribute);
                } catch (err) {
                    node.error("Error running ingress for "+node.thingType.items[i].name+": "+err);
                }
                if (result != null) {
                    node.debug("Ingress for "+node.thingType.items[i].name+"["+node.thingType.items[i].id+"] returns value: '"+result+"'");
                    node.updateState(msg,node.thingType.items[i].id,result,'ingress');

                    // Refresh heartbeat
                    if (node.thingType.hbType == 'ttl') {
                        var date = Date.now();
                        node.heartbeat[node.thingType.items[i].id] = date;
                        node.heartbeat[node.id] = date;
                        if (node.state['1'] === false) {
                            node.state['1'] = true;
                            node.laststate['1'] = false;
                            node.heartbeat['1'] = date;
                        }
                        nodeContext.set("heartbeat",node.heartbeat,node.thingType.contextStore);
                    }
                    node.showState();
                }
            }
        }

        node.updateState = function (msg,itemId, state, logtype) {
            var item = "";

            if (itemId == '1') { return; }

            for (var i in node.thingType.items) {
                if (node.thingType.items[i].id == itemId) { 
                    item = i;
                    break;
                }
            }

            if (item == "") { return; }

            node.debug("State "+node.thingType.items[item].name+"["+node.thingType.items[item].id+"] set to value '"+state+"'");
            node.laststate[node.thingType.items[item].id] = node.state[node.thingType.items[item].id];
            node.state[node.thingType.items[item].id] = state;
            // Save to node context
            nodeContext.set("laststate",node.laststate,node.thingType.contextStore);
            nodeContext.set("state",node.state,node.thingType.contextStore);

            var attribute = getAttributes();
            eventmsg = {
                _msgid: RED.util.generateId(),
                state: state,
                laststate: node.laststate[node.thingType.items[item].id],
                topic: msg.topic,
                payload: state,
                type: {
                    name: node.thingType.name,
                    id: node.thingType.id
                },
                thing: {
                    name: node.name,
                    id: node.id,
                    last_update: node.heartbeat[node.id]
                },
                item: {
                    name: node.thingType.items[item].name,
                    id: node.thingType.items[item].id,
                    last_update: node.heartbeat[node.thingType.items[item].id]
                }
            }
            if (Object.keys(attribute) != 0) {
                eventmsg.thing.attributes = Object.assign({},attribute);
            }
            node.eventHandler.publish('update',node.id,node.thingType.items[item].id,eventmsg);
            node.eventHandler.publish('update',node.thingType.id,node.thingType.items[item].id,eventmsg);
            eventmsg.logtype = logtype;
            node.eventHandler.publish('log','0',node.thingType.items[item].id,eventmsg);
            node.showState();            
        }        

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
                        stateStr = stateStr.replace("%"+node.thingType.items[i].name+"%",'no value');
                    } else {
                        stateStr = stateStr.replace("%"+node.thingType.items[i].name+"%",node.state[node.thingType.items[i].id]);
                    }
                }
                statusMsg["text"] = stateStr;
                node.status(statusMsg);
            }
        }
            
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
                    node.error("Item ["+itemid+"] undefined.");
                    return;
                }

                if (item.type == 'status') {
                    node.error("Item "+item.name+"["+item.id+"] is status only");
                    return;
                }

                if (item.topicSuffix != '') {
                    var topic = fixTopic(item.topicSuffix,node.topicPrefix);
                } else {
                    var topic = node.topicPrefix;
                }
                var command = {
                    _msgid: RED.util.generateId(),
                    topic: topic,
                    payload: payload
                }

                attribute = getAttributes();
                for (let i in node.thingType.egress) {
                    if (node.thingType.egress[i].id == item.egress){
                        var fn = node.thingType.egress[i].fn;
                        break;
                    }
                }
             
                let _egressFn = new Function('msg','attribute',fn);
                try {
                    command = _egressFn(command,attribute);
                } catch (err) {
                    node.error("Error running egress for "+item.name+": "+err);
                }
                if (command != null) {
                    if ((item.type == 'both') || (item.type == 'command')) {
                        node.send(command);
                    } else {
                        statusUpdate(command);
                    }

                    command.type = {
                        name: node.thingType.name,
                        id: node.thingType.id
                    }
                    command.thing = {
                        name: node.name,
                        id: node.id,
                        last_update: node.heartbeat[node.id]
                    }
                    command.item = {
                        name: item.name,
                        id: item.id,
                        last_update: node.heartbeat[item.id]
                    }
                    command.logtype = 'egress';
                    if (Object.keys(attribute) != 0) {
                        command.thing.attributes = Object.assign({},attribute);
                    }
                    node.eventHandler.publish('log','0',node.thingType.items[i].id,command);
                }
            }

            // Start listening for events
            node.eventHandler.subscribe('command', node.id, node.listener);
            node.eventHandler.subscribe('command', node.thingType.id, node.listener);


            // Register heartbeat check
            if ((node.thingType.hbCheck) && (node.thingType.hbType == "ttl")) {
                node.eventHandler.registerHeartbeat(node.id,node.thingType.hbTTL);
            }

            node.showState();
            node.on('input',function(msg) {
                statusUpdate(msg);
            });
        }
        
        node.on("close",function() { 
            if (node.eventHandler) {
                node.eventHandler.unsubscribe('command', node.id, node.listener);
                node.eventHandler.unsubscribe('command', node.thingType.id, node.listener);
                if ((node.thingType.hbCheck) && (node.thingType.hbType == "ttl")) {
                    node.eventHandler.unregisterHeartbeat(node.id);
                }
            }

        });
    }
    RED.nodes.registerType("hal2Thing",hal2Thing);
}
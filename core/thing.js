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

    function showState(node,state) {
        if (state === null) {
            node.status({fill:"gray",shape:"ring",text:"no value"});
            return;
        }
        switch(typeof state) {
            case "boolean":
                if (state) {
                    node.status({fill:"green",shape:"dot",text:state});
                } else {
                    node.status({fill:"gray",shape:"ring",text:state});
                }
                break;
            case "number":
                if (state > 0) {
                    node.status({fill:"green",shape:"dot",text:state});
                } else {
                    node.status({fill:"gray",shape:"ring",text:'0'});
                }
                break;
            case "string":
                    if (state != '') {
                        node.status({fill:"green",shape:"dot",text:state});
                    } else {
                        node.status({fill:"gray",shape:"ring",text:state});
                    }
                break;
            default:
                node.status({text:"unknown"});
                break;
        }
    }

    function hal2Thing(config) {
        RED.nodes.createNode(this,config);

        this.thingType = RED.nodes.getNode(config.thingType);
        this.eventHandler = RED.nodes.getNode(config.eventHandler);
        this.name = config.name;
        this.topicPrefix = config.topicPrefix;
        this.topicFilter = config.topicFilter;
        this.topicFilterType = config.topicFilterType; 
        var node = this;

        node.laststate = {};
        node.state = {};
        
        showState(node,null);

        node.on('input', function(msg) {
            var eventmsg;

            if (node.topicFilter) {
                if (topicFilter[node.topicFilterType](msg.topic,node.topicFilter) === false) { return; }
            }

            if (!node.thingType.items) {
                node.debug("No items configured. Dropping message.");
                return;
            }

            for (let i in node.thingType.items) {
                var item = node.thingType.items[i];
                if (item.topicFilterValue) {
                    if (topicFilter[item.topicFilterType](msg.topic,item.topicFilterValue) == false) { return; }
                }

                for (let i in node.thingType.ingress) {
                    if (node.thingType.ingress[i].id == item.ingress){
                        var fn = node.thingType.ingress[i].fn;
                        break;
                    }
                }

                let _ingessFn;
                _ingressFn = new Function('msg',fn);
                try {
                    var result = _ingressFn(msg);
                } catch (err) {
                    node.error("Error running ingress for "+item.name+": "+err);
                }
                if (result != null) {
                    node.debug("State "+item.name+"["+item.id+"] set to value '"+result+"'");
                    node.laststate[item.id] = node.state[item.id];
                    node.state[item.id] = result;
                    eventmsg = {
                        _msgid: RED.util.generateId(),
                        state: result,
                        laststate: node.laststate[item.id],
                        topic: msg.topic,
                        thing: {
                            name: node.name,
                            id: node.id
                        },
                        item: {
                            name: item.name,
                            id: item.id
                        }
                    }
                    node.eventHandler.publish('update',item.id,eventmsg);
                }
            }
        });

        if (node.eventHandler) {
            node.listener = function(id, payload) {
                var item;

                if (!node.thingType.items) {
                    node.debug("No items configured. Dropping message.");
                    return;
                }
    
                for (i in node.thingType.items) {
                    if (node.thingType.items[i].id == id){
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
            for (i in node.thingType.items) {
                let item = node.thingType.items[i];
                if (!node.thingType.items[i].readOnly) {
                    node.eventHandler.subscribe('command', node.thingType.items[i].id, node.listener);
                }
            }
        }
        
        node.on("close",function() { 
            if (node.eventHandler) {
                for (i in node.thingType.items) {
                    let item = node.thingType.items[i];
                    if (!node.thingType.items[i].readOnly) {
                        node.eventHandler.unsubscribe('command', node.thingType.items[i].id, node.listener);
                    }
                }            
            }
        });
    }
    RED.nodes.registerType("hal2Thing",hal2Thing);
}
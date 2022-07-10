module.exports = function(RED) {
    function hal2Value(config) {
        RED.nodes.createNode(this,config);
        this.action = config.action;
        this.thing = config.thing;
        this.thingType = config.thingType;
        this.item = config.item;
        this.outputValue = config.outputValue;
        this.outputType = config.outputType;
        this.info = config.info;
        var node = this;

        if (typeof node.action == 'undefined') { node.action = 'get' }

        node.on('input', function(msg) {
            var thing;
            if (node.thing == '0') {
                if ((typeof msg.thing !== 'undefined') && (typeof msg.thing.id !== 'undefined')) {
                    thing = RED.nodes.getNode(msg.thing.id);
                    if (thing === null) {
                        node.error("Can't find thing with id "+msg.thing.id);
                        return;
                    } else if (thing.type !== 'hal2Thing') {
                        node.error("Node with id "+msg.thing.id+ " isn't a thing");
                        return;                        
                    } else if (thing.thingType.id !== node.thingType) {
                        node.error("Node with id "+msg.thing.id+ " is of the wrong type");
                        return;                         
                    }
                } else {
                    node.error("thing.id missing from payload");
                    return;
                }
            } else {
                thing = RED.nodes.getNode(node.thing);
            }

            var oVal;
            var oProp = RED.util.normalisePropertyExpression(node.outputValue);
            if (node.action == 'get') {
                if (!thing.state.hasOwnProperty(node.item)) {
                    // No value stored in item
                    return;
                }
                switch (node.outputType) {
                    case 'flow':
                        if (oProp.length > 1) {
                            oVal = node.context().flow.get(oProp[0]) || {};
                            RED.util.setObjectProperty(oVal, node.outputValue, thing.state[node.item], true);
                            //oVal = RED.util.getObjectProperty(oVal,oProp[0]);
                        } else {
                            oVal = thing.state[node.item];
                        }
                        node.context().flow.set(oProp[0],oVal);
                        break;
                    case 'global':
                        if (oProp.length > 1) {
                            oVal = node.context().global.get(oProp[0]) || {};
                            RED.util.setObjectProperty(oVal, node.outputValue, thing.state[node.item], true);
                            //oVal = RED.util.getObjectProperty(oVal,oProp[0]);
                        } else {
                            oVal = thing.state[node.item];
                        }
                        node.context().global.set(oProp[0],oVal);
                        break;
                    case 'msg':
                        RED.util.setMessageProperty(msg,node.outputValue,thing.state[node.item],true);
                        break;
                }
            } else {
                switch (node.outputType) {
                    case 'flow':
                        oVal = {};
                        oVal[oProp[0]] = node.context().flow.get(oProp[0]);
                        oVal = RED.util.getObjectProperty(oVal,node.outputValue);
                        break;
                    case 'global':
                        oVal = {};
                        oVal[oProp[0]] = node.context().global.get(oProp[0]);
                        oVal = RED.util.getObjectProperty(oVal,node.outputValue);
                        break;
                    case 'msg':
                        oVal = RED.util.getMessageProperty(msg,node.outputValue);
                        break;
                }
                thing.updateState(msg,node.item,oVal,'set_value');
                thing.showState();
            }

            if (node.info) {
                var i;
                for (i in thing.thingType.items) {
                    if (thing.thingType.items[i].id == node.item) { break; }
                }
                var attribute = [];
                if (typeof thing.thingType.attributes === 'object') {
                    for (d in thing.thingType.attributes) {
                        attribute[thing.thingType.attributes[d].name] = ""
                        if (typeof thing.attributes === 'object') {
                            for (let a in thing.attributes) {
                                if (thing.attributes[a].id == thing.thingType.attributes[d].id) {
                                    attribute[thing.thingType.attributes[d].name] = thing.attributes[a].val;
                                    break;
                                }
                            }
                        
                        }
                    }
                }
                msg.thing = {
                    name: thing.name,
                    id: thing.id,
                    last_update: thing.heartbeat[node.item],
                    last_change: thing.last_change[node.item]

                }
                msg.item = {
                    name: thing.thingType.items[i].name,
                    id: thing.thingType.items[i].id,
                    last_update: thing.heartbeat[thing.thingType.items[i].id],
                    last_change: thing.last_change[thing.thingType.items[i].id]
                }
                if (Object.keys(attribute) != 0) {
                    msg.thing.attributes = Object.assign({},attribute);
                }
            }
            node.send(msg);
        });
    }
    RED.nodes.registerType("hal2Value",hal2Value);
}
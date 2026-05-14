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
        this.historyMode = config.historyMode;
        this.historyRangeMode = config.historyRangeMode || 'relative';
        this.historyFrom = config.historyFrom;
        this.historyFromUnit = config.historyFromUnit;
        this.historyTo = config.historyTo;
        this.historyToUnit = config.historyToUnit;
        this.historyFromDate = config.historyFromDate;
        this.historyToDate = config.historyToDate;
        this.historyTransitionsOnly = config.historyTransitionsOnly;
        this.historySourceExternal = config.historySourceExternal !== false;
        this.historySourceHal2 = config.historySourceHal2 !== false;
        this.historySourceHeartbeat = config.historySourceHeartbeat === true;
        var node = this;

        if (typeof node.action == 'undefined') { node.action = 'get' }

        function addInfo(thing, msg) {
            var i;
            for (i in thing.thingType.items) {
                if (thing.thingType.items[i].id == node.item) { break; }
            }
            var attribute = [];
            if (typeof thing.thingType.attributes === 'object') {
                for (var d in thing.thingType.attributes) {
                    attribute[thing.thingType.attributes[d].name] = '';
                    if (typeof thing.attributes === 'object') {
                        for (var a in thing.attributes) {
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
            };
            msg.item = {
                name: thing.thingType.items[i].name,
                id: thing.thingType.items[i].id,
                last_update: thing.heartbeat[thing.thingType.items[i].id],
                last_change: thing.last_change[thing.thingType.items[i].id]
            };
            if (thing.thingType.items[i].haType) { msg.item.ha_type = thing.thingType.items[i].haType; }
            if (Object.keys(attribute).length !== 0) {
                msg.thing.attributes = Object.assign({}, attribute);
            }
        }

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
            if (node.action == 'get' && node.historyMode) {
                if (!thing.eventHandler) { node.error('No event handler on thing'); return; }
                const unitMs = { minutes: 60000, hours: 3600000, days: 86400000 };
                let fromMs, toMs;
                if (node.historyRangeMode === 'absolute') {
                    fromMs = node.historyFromDate ? new Date(node.historyFromDate).getTime() : 0;
                    toMs   = node.historyToDate   ? new Date(node.historyToDate).getTime()   : Date.now();
                    if (isNaN(fromMs) || isNaN(toMs)) { node.error('Invalid absolute history date'); return; }
                } else {
                    const fromMul = unitMs[node.historyFromUnit] || unitMs.hours;
                    const toMul   = unitMs[node.historyToUnit]   || unitMs.hours;
                    fromMs = Date.now() - (Number(node.historyFrom) || 24) * fromMul;
                    toMs   = Date.now() - (Number(node.historyTo)   || 0)  * toMul;
                }
                const allowedSources = new Set();
                if (node.historySourceExternal)  allowedSources.add('external');
                if (node.historySourceHal2)      allowedSources.add('hal2');
                if (node.historySourceHeartbeat) allowedSources.add('heartbeat');

                thing.eventHandler.queryHistory(thing.id, node.item, fromMs, toMs, function(err, docs) {
                    if (err) { node.error('History query failed: ' + err.message); return; }
                    let rows = docs;
                    if (allowedSources.size < 3) {
                        rows = rows.filter(d => allowedSources.has(d.source || 'external'));
                    }
                    if (node.historyTransitionsOnly) {
                        const deduped = [];
                        let prevState;
                        for (const d of rows) {
                            if (deduped.length === 0 || d.state !== prevState) {
                                deduped.push(d);
                                prevState = d.state;
                            }
                        }
                        rows = deduped;
                    }
                    RED.util.setMessageProperty(msg, node.outputValue, rows.map(d => ({ state: d.state, ts: d.ts, source: d.source || 'external' })), true);
                    if (node.info) { addInfo(thing, msg); }
                    node.send(msg);
                });
                return;
            }
            if (node.action == 'get') {
                if (!thing.state.hasOwnProperty(node.item)) {
                    // No value stored in item
                    return;
                }
                switch (node.outputType) {
                    case 'flow':
                        if (oProp.length > 1) {
                            oVal = {};
                            oVal[oProp[0]] = node.context().flow.get(oProp[0]) || {};
                            RED.util.setObjectProperty(oVal, node.outputValue, thing.state[node.item], true);
                            oVal = RED.util.getObjectProperty(oVal,oProp[0]);
                        } else {
                            oVal = thing.state[node.item];
                        }
                        node.context().flow.set(oProp[0],oVal);
                        break;
                    case 'global':
                        if (oProp.length > 1) {
                            oVal = {};
                            oVal[oProp[0]] = node.context().global.get(oProp[0]) || {};
                            RED.util.setObjectProperty(oVal, node.outputValue, thing.state[node.item], true);
                            oVal = RED.util.getObjectProperty(oVal,oProp[0]);
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

            if (node.info) { addInfo(thing, msg); }
            node.send(msg);
        });
    }
    RED.nodes.registerType("hal2Value",hal2Value);
}
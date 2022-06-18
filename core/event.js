module.exports = function(RED) {

    function hal2Event(config) {
        RED.nodes.createNode(this,config);
        this.eventHandler   = RED.nodes.getNode(config.eventHandler);
        this.thing          = config.thing;
        this.item           = config.item;
        this.topic          = config.topic;
        this.operator       = config.operator;
        this.change         = config.change;
        this.compareValue   = config.compareValue;
        this.compareType    = config.compareType;
        this.outputValue    = config.outputValue;
        this.outputType     = config.outputType;
        this.typeSel        = config.typeSel;
        this.ratelimit      = config.ratelimit;
        this.ratetype       = config.ratetype;
        this.rate           = Number(config.rate);
        this.rateUnits      = config.rateUnits;
        this.delay          = config.delay;
        this.delayExtend    = config.delayExtend;
        this.delayValue     = config.delayValue;

        var node = this;
        var nodeContext = this.context();

        try {
            var contextStore = '';
            var thing = RED.nodes.getNode(this.thing);
            if (thing.type == 'hal2Thing') { contextStore = thing.thingType.contextStore; }
            else if (thing.type == 'hal2ThingType') { contextStore = thing.contextStore; }
        } catch (err) {
            node.error("Error getting thingType "+err);
            return;
        }

        var eventTimestamp = nodeContext.get('eventTimestamp',contextStore);
        if (typeof eventTimestamp === 'undefined') { eventTimestamp = []; }

        var eventDelay = [];
        var rateLimited = 0;

        var convertRate = {
            'second':   function(a) { return a*1000; },
            'minute':   function(a) { return a*60*1000; },
            'hour':     function(a) { return a*60*60*1000; },
            'day':      function(a) { return a*24*60*60*1000; }
        }

        //a=state, b=compare value, c=oldState/ruleMatch
        var compare = {
            'always':   function ()         { return true; },
            'change':   function (a,b,c)    { return a !== c },
            'otherwise':function (a,b,c)    { return c === 0 },
            'eq':       function (a, b)     { return a === b; },
            'neq':      function (a, b)     { return a !== b; },
            'lt':       function (a, b)     { return ((typeof a == 'number') && (a < b)); },
            'lte':      function (a, b)     { return ((typeof a == 'number') && (a <= b)); },
            'gt':       function (a, b)     { return ((typeof a == 'number') && (a > b)); },
            'gte':      function (a, b)     { return ((typeof a == 'number') && (a >= b)); },
            'cont':     function (a, b)     { return (a + "").indexOf(b) !== -1; },
            'regex':    function (a, b)     { return b.test(a+""); },
            'true':     function (a)        { return a === true; },
            'false':    function (a)        { return a === false; }
        };

        var convertTo = {
            'num':      function (value)    { return Number(value); },
            'str':      function (value)    { return value+""; },
            'bool':     function (value)    { return (value === 'true'); },
            'json':     function (value)    { return JSON.parse(value); },
            're':       function (value)    { return new RegExp(value) }
        };

        function showState() {
            var now = Date.now();
            var status = '';
            var s = {
                fill: 'gray'
            };

            if (eventTimestamp[node.id]) {
                let td = new Date(eventTimestamp[node.id]);
                s.fill = 'green';
                s.text = td.toLocaleString();
            }

            if (now < rateLimited) {
                s.fill = 'blue';
                if (s.text) { s.text += ' rate limited' } else { s.text = 'rate limited' }
            }

            if (Object.keys(eventDelay).length >0) {
                s.fill = 'yellow';
                if (s.text) { s.text += ' delayed' } else { s.text = 'delayed' }
            }
            node.status(s);
        }

        function triggerEvent(thingtypeid, thingid, itemid, event) {
            if (node.delay) {
                delete eventDelay[thingid];
            }

            var now = Date.now();

            if (node.ratelimit) {
                var rateid;

                if (node.ratetype == 'all') {
                    rateid = node.id;
                } else {
                    rateid = thingid;
                }

                if (typeof eventTimestamp[rateid] === 'undefined') { eventTimestamp[rateid] = 0 }

                if (now < eventTimestamp[rateid] + convertRate[node.rateUnits](node.rate)) {
                    node.debug('Rate limit enabled. Last message: '+Math.round((now-eventTimestamp[rateid])/1000)+" sec ago.");
                    return;
                }
                rateLimited = now+convertRate[node.rateUnits](node.rate);
                showState();
                setTimeout(showState,convertRate[node.rateUnits](node.rate));
            }

            eventTimestamp[thingid] = now;
            eventTimestamp[node.id] = now;
            nodeContext.set('eventTimestamp',eventTimestamp,contextStore);

            var msg = {};
            msg._msgid = RED.util.generateId();

            switch (node.outputType) {
                case 'state':
                    msg = RED.util.cloneMessage(event);
                    break;
                case 'flow':
                    msg.payload = node.context().flow.get(node.outputValue);
                    break;
                case 'global':
                    msg.payload = node.context().global.get(node.outputValue);
                    break;
                case 'env':
                    msg.payload = process.env[node.outputValue];
                    break;
                default:
                    msg.payload = RED.util.evaluateNodeProperty(node.outputValue,node.outputType);
            }

            if (node.topic != '') {
                msg.topic = node.topic;
            }
            node.send(msg);
            node.debug('Event: Id '+thingid);
            showState();
        }

        if (node.eventHandler) {
            node.listener = function(thingtypeid, thingid, itemid, event) {
                if (itemid != node.item) { return; }
                if (node.change == '2' && event.laststate == undefined) { return; }
                if (node.change == '1' && event.state === event.laststate) { return; }
                if (compare[node.operator](event.state,convertTo[node.compareType](node.compareValue),event.laststate)){
                    if (node.delay) {
                        if (typeof eventDelay[thingid] != 'undefined') {
                            if (node.delayExtend) {
                                clearTimeout(eventDelay[thingid]);
                                eventDelay[thingid] = setTimeout(triggerEvent,node.delayValue*1000,thingtypeid, thingid, itemid, event);
                                node.debug('Event delay extended, Id '+thingid+' Time '+node.delayValue+'s');
                            }
                        } else {
                            eventDelay[thingid] = setTimeout(triggerEvent,node.delayValue*1000,thingtypeid, thingid, itemid, event);
                            node.debug('Event delay, Id '+thingid+' Time '+node.delayValue+'s');
                        }
                    } else {
                        triggerEvent(thingtypeid, thingid, itemid, event);
                    }
                    showState();
                }
            }

            // Start listening for events
            node.eventHandler.subscribe('update', node.thing, node.listener);
        }
            
        node.on("close",function() { 
            if (node.eventHandler) {
                node.eventHandler.unsubscribe('update', node.thing, node.listener);
            }
        });

        showState();
    }
    RED.nodes.registerType("hal2Event",hal2Event);
}
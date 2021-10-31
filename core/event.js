module.exports = function(RED) {

    function hal2Event(config) {
        RED.nodes.createNode(this,config);
        this.eventHandler = RED.nodes.getNode(config.eventHandler);
        this.thing = config.thing;
        this.item = config.item;
        this.operator = config.operator;
        this.change = config.change;
        this.compareValue = config.compareValue;
        this.compareType = config.compareType;
        this.outputValue = config.outputValue;
        this.outputType = config.outputType;
        var node = this;

        //a=state, b=compare value, c=oldState/ruleMatch
        var compare = {
            'always':   function ()         {return true;},
            'change':   function (a,b,c)    {return a !== c},
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

        if (node.eventHandler) {
            node.listener = function(thingid, itemid, event) {
                if (itemid != node.item) { return; }
                if (node.change == '2' && event.laststate == undefined) { return; }
                if (node.change == '1' && event.state === event.laststate) { return; }
                if (compare[node.operator](event.state,convertTo[node.compareType](node.compareValue),event.laststate)){
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
                    node.send(msg);
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
    }
    RED.nodes.registerType("hal2Event",hal2Event);
}
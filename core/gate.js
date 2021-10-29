module.exports = function(RED) {    
    function checkRules(node,msg) {
        // Don't convert msg, flow, global. Assume same type.
        var convertTo = {
            'num':      function (value)    { return Number(value); },
            'str':      function (value)    { return value+""; },
            'bool':     function (value)    { return (value === 'true'); },
            'json':     function (value)    { return JSON.parse(value); },
            're':       function (value)    { return new RegExp(value) },
            'flow':     function (value)    { return node.context().flow.get(value); },
            'global':   function (value)    { return node.context().global.get(value); },
            'env':      function (value)    { return process.env[value]; },
            'msg':      function (value,msg)    { return RED.util.getMessageProperty(msg,value); }
        };

        //a=state, b=comparison value
        var compare = {
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
        var ruleMatch = 0;
        for (var i = 0; i < node.rules.length; i += 1) {
            var rule = node.rules[i];
            var thing = RED.nodes.getNode(rule.thing);

            var cv = convertTo[rule.type](rule.value,msg);

            // Check if item has state
            if (thing.state.hasOwnProperty(rule.item)) {
                if (compare[rule.operator](thing.state[rule.item],cv,thing.laststate[rule.item])){
                    ruleMatch ++;
                }
            }
        }

        if (node.checkall === 'true') {
            if (ruleMatch == node.rules.length) {
                node.status({fill:"green",shape:"dot",text:ruleMatch + "/" + node.rules.length});
                return true;
            } else {
                node.status({fill:"red",shape:"ring",text:ruleMatch + "/" + node.rules.length});
                return false;
            }
        } else {
            if (ruleMatch > 0) {
                node.status({fill:"green",shape:"dot",text:ruleMatch + "/" + node.rules.length});
                return true;
            } else {
                node.status({fill:"red",shape:"ring",text:ruleMatch + "/" + node.rules.length});
                return false;
            }
        }
    }

    function hal2Gate(config) {
        RED.nodes.createNode(this,config);
        this.name = config.name;
        this.rules = config.rules;
        this.checkall = config.checkall;
        var node = this;

        node.on('input', function(msg) {
            if (checkRules(node,msg)) {
                node.send([msg,null]);
            } else {
                node.send([null,msg]);
            }
        });
    }
    RED.nodes.registerType("hal2Gate",hal2Gate);
}
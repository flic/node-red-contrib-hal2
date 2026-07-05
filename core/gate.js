module.exports = function(RED) {
    var common = require("../lib/common");
    var rules  = require("../lib/rules");

    function checkRules(node,msg) {
        // Base converters (num/str/bool/json/re) are shared with hal2Event via lib/rules;
        // the context-bound ones below need node/RED/msg so they stay local.
        var convertTo = Object.assign({
            'flow':     function (value)    { return node.context().flow.get(value); },
            'global':   function (value)    { return node.context().global.get(value); },
            'env':      function (value)    { return process.env[value]; },
            'msg':      function (value,msg)    { return RED.util.getMessageProperty(msg,value); }
        }, rules.CONVERTERS);

        //a=state, b=comparison value
        var compare = rules.COMPARE;

        var ruleMatch = 0;
        for (var i = 0; i < node.rules.length; i += 1) {
            var rule = node.rules[i];
            var id;
            if (rule.thing == 'dynamic') {
                id = common.thingIdFromMsg(RED,node,rule.thingtype,msg);
                if (typeof id == 'undefined') { continue; }
            } else {
                id = rule.thing;
            }

            var thing;
            try {
                thing = RED.nodes.getNode(id);
            } catch (error) {
                console.log('Error: '+error.message);
            }
            if ( typeof thing == 'undefined' ) { continue; }

            var cv = convertTo[rule.type](rule.value,msg);

            // Check if item has state
            if (thing.state.hasOwnProperty(rule.item)) {
                if (rule.operator.includes('last_')) {
                    let now = Date.now();
                    let last_update = Math.trunc((now - thing.heartbeat[rule.item])/1000);
                    let last_change = Math.trunc((now - thing.last_change[rule.item])/1000);
                    switch (rule.operator) {
                        case 'last_update_gte':
                            if (last_update >= Number(cv)) { ruleMatch++; }
                            break;
                        case 'last_update_lte':
                            if (last_update <= Number(cv)) { ruleMatch++; }
                            break;
                        case 'last_change_gte':
                            if (last_change >= Number(cv)) { ruleMatch++; }
                            break;
                        case 'last_change_lte':
                            if (last_change <= Number(cv)) { ruleMatch++; }
                            break;
                    }
                } else if (compare[rule.operator](thing.state[rule.item],cv,thing.laststate[rule.item])){
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
        this.if = config.if;
        var node = this;

        node.on('input', function(msg) {
            if (checkRules(node,msg)) {
                if (node.if) {
                    msg.payload = true;
                    node.send(msg);
                } else {
                    node.send([msg,null]);
                }
            } else {
                if (node.if) {
                    msg.payload = false;
                    node.send(msg);
                } else {                
                    node.send([null,msg]);
                }
            }
        });
    }
    RED.nodes.registerType("hal2Gate",hal2Gate);
}
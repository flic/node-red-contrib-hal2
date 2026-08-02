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

        // The state a rule compares against, plus the timestamps the last_* operators need.
        // A thing keeps these per item; a group keeps one set for its whole aggregated value.
        function sourceOf(rule) {
            if (rule.category === 'hal2Group') {
                if (!node.eventHandler || typeof node.eventHandler.getGroupState !== 'function') {
                    node.warn('Rule skipped: a group rule needs an event handler on this node');
                    return null;
                }
                // Each rule reads the group its own way; without a function of its own it
                // falls back to whatever the group reports by default.
                if (rule.function) {
                    var read = node.eventHandler.readGroup(rule.thing, rule.function);
                    if (!read || read.value === undefined) { return null; }
                    // A computed read has no history behind it, so the last_* operators have
                    // nothing to answer with — better than answering with the default's.
                    return { state: read.value, laststate: undefined,
                             last_update: undefined, last_change: undefined };
                }
                var rec = node.eventHandler.getGroupState(rule.thing);
                // No record, or no live member reporting: the rule has nothing to compare
                // and does not match, rather than matching against a stale or invented value.
                if (!rec || rec.state === undefined) { return null; }
                return { state: rec.state, laststate: rec.laststate,
                         last_update: rec.last_update, last_change: rec.last_change };
            }
            var id = (rule.thing == 'dynamic')
                ? common.thingIdFromMsg(RED,node,rule.thingtype,msg)
                : rule.thing;
            if (typeof id == 'undefined') { return null; }
            var thing;
            try {
                thing = RED.nodes.getNode(id);
            } catch (error) {
                console.log('Error: '+error.message);
            }
            if (typeof thing == 'undefined' || thing === null) { return null; }
            if (!thing.state || !thing.state.hasOwnProperty(rule.item)) { return null; }
            return { state: thing.state[rule.item], laststate: thing.laststate[rule.item],
                     last_update: thing.heartbeat[rule.item], last_change: thing.last_change[rule.item] };
        }

        var ruleMatch = 0;
        for (var i = 0; i < node.rules.length; i += 1) {
            var rule = node.rules[i];
            var src = sourceOf(rule);
            if (src === null) { continue; }      // unresolvable source never matches

            var cv = convertTo[rule.type](rule.value,msg);

            if (rule.operator.includes('last_')) {
                let now = Date.now();
                let last_update = Math.trunc((now - src.last_update)/1000);
                let last_change = Math.trunc((now - src.last_change)/1000);
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
            } else if (compare[rule.operator](src.state,cv,src.laststate)){
                ruleMatch ++;
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
        this.eventHandler = RED.nodes.getNode(config.eventHandler);
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
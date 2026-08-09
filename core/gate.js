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
            'msg':      function (value,msg)    { return RED.util.getMessageProperty(msg,value); },
            // Both sides read in the same pass, so they cannot disagree because one was stored
            // earlier — which is the whole reason this type exists.
            'state':    function (value,msg,rule) {
                var read = rule && rule.cmp ? readSource(rule.cmp) : null;
                return read ? read.state : undefined;
            }
        }, rules.CONVERTERS);

        //a=state, b=comparison value
        var compare = rules.COMPARE;

        // One reading, from a spec that says where to look: { src, thing, item, group,
        // groupFunction } — the shape hal2Bayes uses for its steps, so both sides of a rule and
        // all three rule nodes describe a source the same way. Returns null when it cannot be
        // read, which every caller treats as "no match" rather than as a value.
        //
        // `dynamic` is only meaningful on the left: the right-hand side of a comparison names
        // the thing it means.
        function readSource(spec) {
            if (spec.src === 'group') {
                if (!node.eventHandler || typeof node.eventHandler.readGroup !== 'function') {
                    node.warn('Rule skipped: a group source needs an event handler on this node');
                    return null;
                }
                if (spec.groupFunction) {
                    var gread = node.eventHandler.readGroup(spec.group, spec.groupFunction);
                    if (!gread || gread.value === undefined) { return null; }
                    return { state: gread.value, laststate: gread.laststate,
                             last_update: gread.last_update, last_change: gread.last_change };
                }
                var grec = node.eventHandler.getGroupState(spec.group);
                if (!grec || grec.state === undefined) { return null; }
                return { state: grec.state, laststate: grec.laststate,
                         last_update: grec.last_update, last_change: grec.last_change };
            }
            var t;
            try { t = RED.nodes.getNode(spec.thing); }
            catch (error) { return null; }
            if (!t || !t.state || !t.state.hasOwnProperty(spec.item)) { return null; }
            return { state: t.state[spec.item], laststate: t.laststate[spec.item],
                     last_update: t.heartbeat[spec.item], last_change: t.last_change[spec.item] };
        }

        // The left-hand side of a rule, expressed as a spec and read the same way. `dynamic`
        // resolves to a thing named by the message; everything else is a plain source.
        function sourceOf(rule) {
            if (rule.category === 'hal2Group') {
                return readSource({ src: 'group', group: rule.thing, groupFunction: rule.function });
            }
            var id = (rule.thing == 'dynamic')
                ? common.thingIdFromMsg(RED,node,rule.thingtype,msg)
                : rule.thing;
            if (typeof id == 'undefined') { return null; }
            return readSource({ src: 'thing', thing: id, item: rule.item });
        }

        var ruleMatch = 0;
        for (var i = 0; i < node.rules.length; i += 1) {
            var rule = node.rules[i];
            var src = sourceOf(rule);
            if (src === null) { continue; }      // unresolvable source never matches

            // A range compares against a pair. The converters take one value each, so the pair
            // is assembled here rather than pretending to be a value type.
            var cv = (rule.operator === 'range' || rule.operator === 'outrange')
                ? rules.rangeBounds(rule.value, rule.valueHigh)
                : convertTo[rule.type](rule.value,msg,rule);
            // An unreadable comparison source is not a value of undefined to compare against;
            // the rule simply has nothing to say.
            if (rule.type === 'state' && cv === undefined) { continue; }

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
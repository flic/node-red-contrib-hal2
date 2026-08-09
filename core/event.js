module.exports = function(RED) {
    var rules = require("../lib/rules");

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
        this.compareHigh    = config.compareHigh;
        this.compareSource  = config.compareSource || null;
        this.outputValue    = config.outputValue;
        this.outputType     = config.outputType;
        this.typeSel        = config.typeSel;
        this.groupFunction  = config.groupFunction || '';
        this.ratelimit      = config.ratelimit;
        this.ratetype       = config.ratetype;
        this.rate           = Number(config.rate);
        this.rateUnits      = config.rateUnits;
        this.delay          = config.delay;
        this.delayExtend    = config.delayExtend;
        this.delayReset     = config.delayReset;
        // Which edge the delay applies to, for a level output. Both by default, so a ticked
        // "Delay event" always does something: leaving one edge undelayed is a choice you make,
        // not a state you can land in by not noticing a second checkbox.
        this.delayOnTrue    = config.delayOnTrue  !== false;
        this.delayOnFalse   = config.delayOnFalse !== false;
        this.delayValue     = config.delayValue;

        var node = this;
        var nodeContext = this.context();
        var contextStore = this.eventHandler.contextStore;

        var eventTimestamp = nodeContext.get('eventTimestamp',contextStore) || {};
        // Only used when this node reads a group with a function of its own. The engine keeps
        // state/laststate for the group's default; a node that asked for something else has to
        // remember its own previous value to know whether anything changed — and to persist it,
        // or a restart would read as a change.
        var groupLast = nodeContext.get('groupLast',contextStore);
        // A level exists only when the rule can stop holding. 'always' cannot, so it is not a
        // level: it keeps the node's ordinary firing discipline and simply carries true as its
        // payload, exactly as the boolean output type does. Everything that separates the two
        // modes — the change gating, the rate limit, the forced delay reset — reads this one
        // predicate rather than each deciding for itself what "the new mode" means.
        var levelMode = node.outputType === 'trigger' && node.operator !== 'always';
        // What the level last said. Persisted for the same reason groupLast is: a restart must
        // not manufacture an edge out of a level that never moved.
        var lastResult = nodeContext.get('lastResult',contextStore);

        var eventDelay = {};
        // What a pending timer will announce, per thing. Without it a queued edge cannot be
        // recognised as stale: the level machine has to know not just that something is waiting
        // but which way it points, or a true left over from a condition that has since stopped
        // holding lands anyway.
        var delayPending = {};
        var rateLimited = 0;

        var convertRate = {
            'second':   function(a) { return a*1000; },
            'minute':   function(a) { return a*60*1000; },
            'hour':     function(a) { return a*60*60*1000; },
            'day':      function(a) { return a*24*60*60*1000; }
        }

        // Base comparison operators are shared with hal2Gate via lib/rules; the trigger-only
        // operators below (always/change/otherwise) are specific to event evaluation.
        //a=state, b=compare value, c=oldState/ruleMatch
        var compare = Object.assign({
            'always':   function ()         { return true; },
            'change':   function (a,b,c)    { return a !== c },
            'otherwise':function (a,b,c)    { return c === 0 }
        }, rules.COMPARE);

        // Copy so per-node use can never mutate the shared converter table. `state` compares
        // against another live reading rather than a constant, resolved at trigger time so the
        // two sides cannot disagree because one was stored earlier.
        var convertTo = Object.assign({
            'state': function () {
                var spec = node.compareSource;
                if (!spec) { return undefined; }
                if (spec.src === 'group') {
                    if (!node.eventHandler || typeof node.eventHandler.readGroup !== 'function') { return undefined; }
                    if (spec.groupFunction) {
                        var read = node.eventHandler.readGroup(spec.group, spec.groupFunction);
                        return read ? read.value : undefined;
                    }
                    var rec = node.eventHandler.getGroupState(spec.group);
                    return rec ? rec.state : undefined;
                }
                var thing = RED.nodes.getNode(spec.thing);
                return (thing && thing.state) ? thing.state[spec.item] : undefined;
            }
        }, rules.CONVERTERS);

        function showState() {
            var now = Date.now();
            var status = '';
            var s = {
                fill: 'gray'
            };

            // A level's interesting fact is what it currently says, not when it last spoke.
            if (levelMode && typeof lastResult !== 'undefined') {
                s.fill = lastResult ? 'green' : 'gray';
                s.text = String(lastResult);
            } else if (eventTimestamp[node.id]) {
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

        // Settle a level against what the node last said. Kept apart from the listener because
        // there are four questions here — is there anything to say, is something already queued
        // to say it, does a queued announcement still hold, and does this edge wait — and reading
        // them inside the event filtering is what let a stale `true` slip through before.
        function settleLevel(thingtypeid, thingid, itemid, event, matched) {
            var waiting = delayPending[thingid];

            // A queued announcement is worth keeping only while the answer still agrees with it.
            if (waiting !== undefined && waiting !== matched) {
                clearTimeout(eventDelay[thingid]);
                delete eventDelay[thingid];
                delete delayPending[thingid];
                waiting = undefined;
            }

            if (matched === lastResult) { return; }      // nothing to say, or cancelled back
            if (waiting === matched) {                   // already queued; only extend it
                if (node.delayExtend) {
                    clearTimeout(eventDelay[thingid]);
                    eventDelay[thingid] = setTimeout(triggerEvent, node.delayValue*1000,
                        thingtypeid, thingid, itemid, event, matched);
                    node.debug('Event delay extended, Id '+thingid+' Time '+node.delayValue+'s');
                }
                return;
            }

            if (node.delay && (matched ? node.delayOnTrue : node.delayOnFalse)) {
                delayPending[thingid] = matched;
                eventDelay[thingid] = setTimeout(triggerEvent, node.delayValue*1000,
                    thingtypeid, thingid, itemid, event, matched);
                node.debug('Event delay ('+matched+'), Id '+thingid+' Time '+node.delayValue+'s');
            } else {
                triggerEvent(thingtypeid, thingid, itemid, event, matched);
            }
        }

        function triggerEvent(thingtypeid, thingid, itemid, event, result) {
            if (node.delay) {
                delete eventDelay[thingid];
                delete delayPending[thingid];
            }

            var now = Date.now();

            // Rate limit drops messages inside its window. On a level that is not a degraded
            // signal but a wrong one: a dropped false leaves the receiver believing true for as
            // long as nothing else happens to move. It is hidden in the editor for the same
            // reason, so this guard is only what protects an already-saved configuration.
            if (node.ratelimit && !levelMode) {
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

            // Before the group branch below returns early, so both output paths record it.
            if (levelMode) {
                lastResult = result;
                nodeContext.set('lastResult',lastResult,contextStore);
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
                case 'trigger':
                    msg.payload = result;
                    break;
                default:
                    msg.payload = RED.util.evaluateNodeProperty(node.outputValue,node.outputType);
            }

            if (node.topic != '') {
                msg.topic = node.topic;
            }
            // A group is not a node: its context travels on the event itself, so pass it
            // through whatever the output type is rather than looking anything up.
            if (node.typeSel === 'hal2Group') {
                if (event && event.group)  { msg.group  = event.group; }
                if (event && event.member) { msg.member = event.member; }
                node.send(msg);
                node.debug('Event: Group '+thingid);
                showState();
                return;
            }
            const thing = RED.nodes.getNode(thingid);
            if (thing && thing.thingType && thing.thingType.items) {
                const itm = thing.thingType.items.find(i => i.id === itemid);
                if (itm && itm.haType) {
                    msg.item = {
                        name       : itm.name,
                        id         : itm.id,
                        ha_type    : itm.haType,
                        last_update: thing.heartbeat && thing.heartbeat[itemid],
                        last_change: thing.last_change && thing.last_change[itemid]
                    };
                }
            }
            node.send(msg);
            node.debug('Event: Id '+thingid);
            showState();
        }

        if (node.eventHandler) {
            node.listener = function(thingtypeid, thingid, itemid, event) {
                // A group emits under its own id with its own aggregated state, so the item
                // filter does not apply — the group is the item.
                if (node.typeSel != 'hal2Group' && itemid != node.item) { return; }

                // With a function of this node's own, the group's emission is a wake-up and the
                // value is computed here. Two Event nodes can then watch the same group for
                // different things — "is a lamp on" and "did they all come on" — which one
                // shared value could never answer.
                if (node.typeSel == 'hal2Group' && node.groupFunction) {
                    var read = node.eventHandler.readGroup(thingid, node.groupFunction);
                    var value = read ? read.value : undefined;
                    // Nothing to report is not a change to nothing: a function that stops
                    // fitting its members, or a group gone quiet, must not fire an event.
                    if (value === undefined) { return; }
                    // The whole group block is rebuilt, not just the value: the engine's
                    // emission describes the group's default, and every field in it —
                    // function, live, the timestamps, the provenance — belongs to that
                    // function rather than to the one this node asked for.
                    var grp = Object.assign({}, event.group, {
                        function   : node.groupFunction,
                        members    : read.members,
                        live       : read.live,
                        last_update: read.last_update,
                        last_change: read.last_change
                    });
                    if (read.source)          { grp.source = read.source; }
                    else                      { delete grp.source; }
                    if (read.last_changed_by) { grp.last_changed_by = read.last_changed_by; }
                    else                      { delete grp.last_changed_by; }
                    event = Object.assign({}, event, {
                        state: value, laststate: groupLast, payload: value, group: grp
                    });
                    if (groupLast !== value) {
                        groupLast = value;
                        nodeContext.set('groupLast', groupLast, contextStore);
                    }
                }
                if (node.change == '2' && typeof event.laststate == 'undefined') { return; }
                // Both '1' and '2' mean on change; the clause above is the only thing that
                // separates them. '2' used to skip the initial value and then fire on every
                // update regardless, which is neither what it is called nor what it means.
                if ((node.change == '1' || node.change == '2') && event.state === event.laststate) { return; }
                // A range compares against a pair. The converter table takes one value each,
                // so the pair is assembled here rather than pretending to be a value type.
                var cv = (node.operator === 'range' || node.operator === 'outrange')
                    ? rules.rangeBounds(node.compareValue, node.compareHigh)
                    : convertTo[node.compareType](node.compareValue);
                if (node.compareType === 'state' && cv === undefined) { showState(); return; }
                var matched = compare[node.operator](event.state,cv,event.laststate);

                // A level speaks only when its answer moves. A threshold that stays unmet while
                // its reading wanders must not narrate every reading — that is the difference
                // between reporting a level and reporting an evaluation.
                if (levelMode) {
                    settleLevel(thingtypeid, thingid, itemid, event, matched);
                    showState();
                    return;
                }

                if (matched) {
                    if (node.delay) {
                        if (typeof eventDelay[thingid] != 'undefined') {
                            if (node.delayExtend) {
                                clearTimeout(eventDelay[thingid]);
                                eventDelay[thingid] = setTimeout(triggerEvent,node.delayValue*1000,thingtypeid, thingid, itemid, event, true);
                                node.debug('Event delay extended, Id '+thingid+' Time '+node.delayValue+'s');
                            }
                        } else {
                            eventDelay[thingid] = setTimeout(triggerEvent,node.delayValue*1000,thingtypeid, thingid, itemid, event, true);
                            node.debug('Event delay, Id '+thingid+' Time '+node.delayValue+'s');
                        }
                    } else {
                        triggerEvent(thingtypeid, thingid, itemid, event, true);
                    }
                } else {
                    if ((node.delay) && (node.delayReset) && (typeof eventDelay[thingid] != 'undefined')) {
                        clearTimeout(eventDelay[thingid]);
                        delete eventDelay[thingid];
                        node.debug('Event delay reset, Id '+thingid);
                    }
                }
                showState();
            }

            // Start listening for events
            node.eventHandler.subscribe('update', node.thing, node.listener);
        }
            
        node.on("close",function() { 
            if (node.eventHandler) {
                node.eventHandler.unsubscribe('update', node.thing, node.listener);
            }
            for (let d in eventDelay) {
                clearTimeout(eventDelay[d]);
                delete eventDelay[d];
            }
        });

        showState();
    }
    RED.nodes.registerType("hal2Event",hal2Event);
}
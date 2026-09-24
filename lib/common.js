// Who is sending, in the shape a command carries to the Thing: enough for a refusal there to
// point at the node to fix, without handing the Thing a live node object.
function senderOf(node) {
    return { type: node.type, name: node.name, id: node.id, z: node.z };
}

// A command that a Thing refuses says who sent it and what it could have asked for instead.
// The usual cause is a flow node still holding an item id from a ThingType the Thing has since
// left — the item id alone never says which of hundreds of nodes to open.
// `flowLabelOf` turns a tab id into its label; it may be absent or return nothing.
function describeSender(source, flowLabelOf) {
    if (!source) { return 'an unknown sender'; }
    if (typeof source === 'string') { return source; }
    let s = source.type || 'node';
    if (source.name) { s += ' "' + source.name + '"'; }
    if (source.id) { s += ' [' + source.id + ']'; }
    if (source.z) {
        const label = typeof flowLabelOf === 'function' ? flowLabelOf(source.z) : null;
        s += ' in flow "' + (label || source.z) + '"';
    }
    return s;
}

function describeCommandableItems(items) {
    const list = (items || [])
        .filter(i => i.type !== 'status')
        .map(i => i.id + ' (' + i.name + ')');
    return list.length ? list.join(', ') : 'none';
}

function refusalText(head, thing, source, flowLabelOf) {
    const type = thing.thingType && thing.thingType.name;
    return head + ' on "' + thing.name + '"' + (type ? ' (type "' + type + '")' : '') +
        ', sent by ' + describeSender(source, flowLabelOf) +
        '. Commandable items: ' + describeCommandableItems(thing.thingType && thing.thingType.items) + '.';
}

// `node` may be a real Node-RED node or any object exposing { ratelimit, eventHandler, status }.
// `qLast` is the timestamp of the last send (0 on first call); `onFinish` is optional.
function queueSend(node,queue,qLast,onFinish) {
    qLast = Number(qLast) || 0;
    const date = Date.now();
    if (date - qLast > node.ratelimit) {
        if (Object.keys(queue).length > 0) {
            qLast = date;
            node.eventHandler.publishCommand(queue[0].thing,queue[0].item,queue[0].payload,senderOf(node));
            queue.shift();
        }

        if (Object.keys(queue).length > 0) {
            setTimeout(() => { queueSend(node,queue,qLast,onFinish); },node.ratelimit)
        }
    } else {
        setTimeout(() => { queueSend(node,queue,qLast,onFinish); }, node.ratelimit-(date-qLast));
    }

    if (Object.keys(queue).length > 0) {
        node.status({text:"Queue: "+Object.keys(queue).length});
    } else {
        node.status({});
        if (typeof onFinish === 'function') { onFinish(); }
    }
}

// Persistent rate-limited command queue (used by the EventHandler's group engine).
// Unlike queueSend — which paces a single burst — the throttle keeps its last-send
// timestamp across bursts, so the rate limit holds even when commands arrive as
// separate events. `send` is called with one queued item at a time.
function createThrottledQueue(ratelimit, send) {
    const q = [];
    let timer = null, last = 0;
    function tick() {
        timer = null;
        if (q.length === 0) { return; }
        const wait = last + ratelimit - Date.now();
        if (wait > 0) { timer = setTimeout(tick, wait); return; }
        last = Date.now();
        send(q.shift());
        if (q.length > 0) { timer = setTimeout(tick, ratelimit); }
    }
    return {
        push(items) { q.push(...items); if (!timer) { tick(); } },
        clear()     { if (timer) { clearTimeout(timer); timer = null; } q.length = 0; },
        size()      { return q.length; }
    };
}

// One heartbeat sweep over the EventHandler's registered things: mark a thing offline when
// its TTL has expired — and only on that transition. Coming back online happens through real
// item updates (core/thing.js flips '1' back for ttl things), never here.
//
// The transition-only guard matters because updateState refreshes the thing's heartbeat
// timestamp as a side effect: rewriting false on every sweep would keep that timestamp fresh
// forever (so `online` computes true for a device that has said nothing) and re-emit an
// update event per sweep, waking every group the thing belongs to.
function checkHeartbeats(hbList, getNode, now, debug) {
    for (const hb of hbList) {
        const thing = getNode(hb.id);
        // Stale entry (thing removed mid-flight) — skip rather than crash the sweep.
        if (!thing || !thing.thingType) { continue; }
        const online = !!(thing.heartbeat && (thing.id in thing.heartbeat) &&
                          (now < Number(thing.thingType.hbTTL) * 1000 + thing.heartbeat[thing.id]));
        if (!online && (thing.state || {})['1'] !== false) {
            if (debug) { debug("Heartbeat: " + thing.name + " offline"); }
            thing.updateState([], '1', false, 'heartbeat');
        }
    }
}

function thingIdFromMsg(RED,node,type,msg) {
    if (("thing" in msg) && ("id" in msg.thing)) {
        var thing;
        try {
            thing = RED.nodes.getNode(msg.thing.id);
        } catch (error) {
            console.log('Error: '+error.message);
        }
        if (thing === null) {
            node.error("Can't find thing with id "+msg.thing.id);
        } else if (thing.type != 'hal2Thing') {
            node.error("Node with id "+msg.thing.id+ " isn't a thing");
        } else if (thing.thingType.id !== type) {
            node.error("Node with id "+msg.thing.id+ " is of the wrong type");
        } else {
            return thing.id;
        }
    } else {
        node.error("thing.id missing from payload");
    }
}

// Item capability predicates. The editor has its own copies in resources/hal.js (halStatusItem /
// halCommandItem) because it cannot require() from here; these two are the runtime's, and the
// pair must agree — an item the editor offers as a group member is one the engine must accept.
// Item id '1' is the reserved heartbeat item, which always carries state.
function statusCapableItem(item) {
    if (!item) { return false; }
    const t = item.type;
    return (t === 'both' || t === 'status' || t === 'loopback_both' || item.id === '1');
}

function commandCapableItem(item) {
    if (!item) { return false; }
    const t = item.type;
    return (t === 'both' || t === 'command' || t === 'loopback_both' || t === 'loopback_command');
}

// Is a thing currently reporting? The single definition of "offline" in hal2: it decides both
// the `alive` flag in the MCP catalog and whether a member's value counts towards its group's
// value. A ThingType with heartbeat checking switched off is always alive, and so is a thing
// that has simply never had a heartbeat recorded — only an explicit false takes a thing out.
function isThingAlive(thing) {
    if (!thing || !thing.thingType) { return false; }
    if (thing.thingType.hbCheck === false) { return true; }
    return !thing.state || thing.state['1'] !== false;
}

module.exports = {
    queueSend: queueSend,
    createThrottledQueue: createThrottledQueue,
    senderOf: senderOf,
    describeSender: describeSender,
    refusalText: refusalText,
    checkHeartbeats: checkHeartbeats,
    thingIdFromMsg: thingIdFromMsg,
    statusCapableItem: statusCapableItem,
    commandCapableItem: commandCapableItem,
    isThingAlive: isThingAlive
}
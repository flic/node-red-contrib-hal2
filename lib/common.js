// `node` may be a real Node-RED node or any object exposing { ratelimit, eventHandler, status }.
// `qLast` is the timestamp of the last send (0 on first call); `onFinish` is optional.
function queueSend(node,queue,qLast,onFinish) {
    qLast = Number(qLast) || 0;
    const date = Date.now();
    if (date - qLast > node.ratelimit) {
        if (Object.keys(queue).length > 0) {
            qLast = date;
            node.eventHandler.publishCommand(queue[0].thing,queue[0].item,queue[0].payload);
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

module.exports = {
    queueSend: queueSend,
    createThrottledQueue: createThrottledQueue,
    thingIdFromMsg: thingIdFromMsg
}
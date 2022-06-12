function queueSend(node,queue,qLast=null) {
    const date = Date.now();
    if (date - qLast > node.ratelimit) {
        if (Object.keys(queue).length > 0) {
            qLast = date;
            node.eventHandler.publishCommand(queue[0].thing,queue[0].item,queue[0].payload);
            queue.shift();
        }

        if (Object.keys(queue).length > 0) {
            setTimeout(() => { queueSend(node,queue,qLast); },node.ratelimit)
        }
    } else {
        setTimeout(() => { queueSend(node,queue,qLast); }, node.ratelimit-(date-qLast));
    }

    if (Object.keys(queue).length > 0) {
        node.status({text:"Queue: "+Object.keys(queue).length});
    } else {
        node.status({});
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

module.exports = {
    queueSend: queueSend,
    thingIdFromMsg: thingIdFromMsg
}
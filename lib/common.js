function queueSend(node,queue,qLast=null) {
    const date = Date.now();
    if (date - qLast > node.ratelimit) {
        if (Object.keys(queue).length > 0) {
            qLast = date;
            node.eventHandler.publish("command",queue[0].item,queue[0].payload);
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

module.exports = {
    queueSend: queueSend
}
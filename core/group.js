module.exports = function(RED) {
    // DEPRECATED. Groups are no longer separate nodes — their identity lives on the
    // EventHandler (Groups tab) and membership lives per item on each hal2Thing.
    //
    // This node still works during the transition: the EventHandler's group engine
    // folds legacy hal2Group nodes in automatically (by node id), so commands and
    // events keep flowing. This stub only bridges the node's own input/output wires
    // to that engine. Run tools/migrate-groups.js to make the move permanent and then
    // delete these nodes; the node type will be removed in a future release.
    function hal2Group(config) {
        RED.nodes.createNode(this, config);
        this.eventHandler = RED.nodes.getNode(config.eventHandler);
        this.name   = config.name;
        this.output = config.output;
        var node = this;

        node.status({ fill: 'yellow', shape: 'ring', text: 'deprecated' });

        if (node.eventHandler) {
            // Output wire: forward member updates re-emitted by the engine under this id.
            if (config.output) {
                node.updateListener = function (thingtypeid, thingid, itemid, payload) {
                    node.send(payload);
                };
                node.eventHandler.subscribe('update', node.id, node.updateListener);
            }

            // Input wire: hand the payload to the engine's group command path.
            node.on('input', function (msg) {
                node.eventHandler.publishCommand(node.id, node.id, msg.payload);
            });
        }

        node.on('close', function () {
            if (node.eventHandler && node.updateListener) {
                node.eventHandler.unsubscribe('update', node.id, node.updateListener);
            }
        });
    }
    RED.nodes.registerType("hal2Group", hal2Group);
}

// Types removed in 4.0.0. hal2MCPServer: embedded tools register on the event handler directly,
// and standalone servers are node-red-contrib-mcp-server's. hal2Group: a group's identity lives
// on the event handler and its membership on each Thing's items, as since 3.x. Node-RED starts no
// flow at all while a flow names a type nobody registers, so the types stay registered here — no
// .html, so the editor shows such nodes as unknown — and do nothing but say what happened. The
// editor plugin (plugins/convert.html) converts the flows that use them.
//
// Removed in 5.0.0, with the plugin.

module.exports = function (RED) {
    function hal2MCPServer(config) {
        RED.nodes.createNode(this, config);
        const standalone = config.mode !== 'embedded';
        this.error('hal2MCPServer was removed in 4.0.0, and the tools on it are not served. '
            + (standalone
                ? 'This standalone server becomes an MCP Server of @frtnbach/node-red-contrib-mcp-server; '
                : 'Its tools belong on the event handler now; ')
            + 'the editor offers to convert the flows.');
        this.status({ fill: 'red', shape: 'ring', text: 'removed in 4.0.0 — convert' });
    }
    RED.nodes.registerType('hal2MCPServer', hal2MCPServer);

    function hal2Group(config) {
        RED.nodes.createNode(this, config);
        this.error('hal2Group was removed in 4.0.0, and this group neither commands nor reports its members. '
            + 'Groups live on the event handler\'s Groups tab; the editor offers to convert the flows.');
        this.status({ fill: 'red', shape: 'ring', text: 'removed in 4.0.0 — convert' });
    }
    RED.nodes.registerType('hal2Group', hal2Group);
};

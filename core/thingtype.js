module.exports = function(RED) {
    function hal2ThingType(config) {
        RED.nodes.createNode(this,config);
        this.name = config.name;
        this.contextStore = config.contextStore;
        this.nodestatus = config.nodestatus;
        this.items = config.items;
        this.ingress = config.ingress;
        this.egress = config.egress;
        this.readOnly = config.readOnly;
    }
    RED.nodes.registerType("hal2ThingType",hal2ThingType);
}
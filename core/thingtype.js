module.exports = function(RED) {
    function hal2ThingType(config) {
        RED.nodes.createNode(this,config);
        this.name = config.name;
        this.contextStore = config.contextStore;
        this.nodestatus = config.nodestatus;
        this.attributes = config.attributes;
        this.items = config.items;
        this.ingress = config.ingress;
        this.egress = config.egress;
        this.thingStatus = config.thingStatus;
        this.thingCommand = config.thingCommand;
        this.hbCheck= config.hbCheck;
        this.hbType = config.hbType;
        this.hbTTL = config.hbTTL;
        this.hbLWT = config.hbLWT;
        this.hbFilterVal = config.hbFilterVal;
        this.hbFilterType = config.hbFiltertype;
        this.filterFunction = config.filterFunction;
    }
    RED.nodes.registerType("hal2ThingType",hal2ThingType);
}
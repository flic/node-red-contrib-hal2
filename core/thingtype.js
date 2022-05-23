module.exports = function(RED) {
    function hal2ThingType(config) {
        RED.nodes.createNode(this,config);
        this.name = config.name;
        this.contextStore = config.contextStore;
        this.nodestatus = config.nodestatus;
        this.nodestatusType = config.nodestatusType;
        this.statusFn = config.statusFn;
        this.attributes = config.attributes;
        this.items = config.items;
        this.ingress = config.ingress;
        this.egress = config.egress;
        this.thingStatus = config.thingStatus;
        this.thingCommand = config.thingCommand;
        this.thingOutput = config.thingOutput;
        this.outputs = config.outputs;
        this.hbCheck= config.hbCheck;
        this.hbType = config.hbType;
        this.hbTTL = config.hbTTL;
        this.hbLWT = config.hbLWT;
        this.hbFilterVal = config.hbFilterVal;
        this.hbFilterType = config.hbFilterType;
        this.hbPropVal = config.hbPropVal;
        this.hbPropType = config.hbPropType;
        this.filterFunction = config.filterFunction;
    }
    RED.nodes.registerType("hal2ThingType",hal2ThingType);
    RED.library.register("hal2ThingType");
}
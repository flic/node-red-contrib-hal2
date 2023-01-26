function halCreateId () {
    return (1+Math.random()*4294967295).toString(16);
}

function halStatusItem(item) {
    return ((item.type == 'both') || (item.type == 'status') || (item.type == 'loopback_both') || (item.id == '1'));
}

function halCommandItem(item) {
    return ((item.type == 'both') || (item.type == 'command') || (item.type == 'loopback_both') || (item.type == 'loopback_command'));
}

function halOperators(ops) {
    var operators = [
        { v: "eq", t: "==" },
        { v: "neq", t: "!=" },
        { v: "lt", t: "<" },
        { v: "lte", t: "<=" },
        { v: "gt", t: ">" },
        { v: "gte", t: ">=" },
        { v: "cont", t: "contains" },
        { v: "regex", t: "regex" },
        { v: "true", t: "is true" },
        { v: "false", t: "is false" }
    ];
    if (ops) {
        operators = operators.concat(ops);
    }
    return operators;    
}

function halTypeMQTT() {
    return {
        value: "mqtt",
        label: "MQTT Topic",
        icon: "fa fa-tasks",
        validate: /^(#$|(\+|[^+#]*)(\/(\+|[^+#]*))*(\/(\+|#|[^+#]*))?$)/,
        hasValue: true
    }
}

function halGetThings(RED,filter) {
    //get all things and sort them alphabetically
    var completeThingsList = RED.nodes.filterNodes({type: "hal2Thing"});
    var filteredThingsList=[];
    for (let t in completeThingsList) {
        try {
            let thingType = RED.nodes.node(completeThingsList[t].thingType);
            if (filter == 'command') {
                if (thingType.thingCommand) {
                    filteredThingsList.push(completeThingsList[t]);
                }
             } else if (filter == 'status') {
                if (thingType.thingStatus) {
                    filteredThingsList.push(completeThingsList[t]);
                }
             } else if (completeThingsList[t].name) {
                filteredThingsList.push(completeThingsList[t]);
             }
        } catch (error) {
            console.log('Error: '+error.message);
        }
    }
    filteredThingsList.sort(function(a, b) {
        var textA = a.name.toUpperCase();
        var textB = b.name.toUpperCase();
        return (textA < textB) ? -1 : (textA > textB) ? 1 : 0;
    });

    return filteredThingsList;
}

function halGetGroups(RED) {
    //get all groups and sort them alphabetically
    var groupsList = RED.nodes.filterNodes({type: "hal2Group"});
    groupsList.sort(function(a, b) {
        var textA = a.name.toUpperCase();
        var textB = b.name.toUpperCase();
        return (textA < textB) ? -1 : (textA > textB) ? 1 : 0;
    });
    return groupsList;
}

function halGetThingTypes(RED,thingsList) {
    //get all Thingtypes and sort them alphabetically
    var thingTypeId = [];
    for (let i in thingsList) {
        try {
            if (thingTypeId.indexOf(thingsList[i].thingType) == -1) {
                thingTypeId.push(thingsList[i].thingType);
            }
        } catch (error) {
            console.log('Error: '+error.message);
        }                
    }
    var thingTypeList = [];
    for (let i in thingTypeId) {
        try {
            var thingType = RED.nodes.node(thingTypeId[i]);
            if (thingType.thingCommand) {
                thingTypeList.push(thingType);
            }
        } catch (error) {
            console.log('Error: '+error.message);
        }                    
    }
    thingTypeList.sort(function(a, b) {
        var textA = a.name.toUpperCase();
        var textB = b.name.toUpperCase();
        return (textA < textB) ? -1 : (textA > textB) ? 1 : 0;
    });            
    return thingTypeList;
}

function halAddExpandButton(appendTo,expandRow,visible) {
    var collapsed   = "fa fa-angle-right";
    var expanded    = "fa fa-angle-down"

    // Show a clickable expand icon
    var expandButton = $('<span/>', {style: "margin-left:5px; margin-right:10px"})
        .html('<i class="' + (visible ? expanded : collapsed) + '"></i>')
        .appendTo(appendTo);
    expandButton.click(function(e) {
        e.preventDefault();
        
        // Switch the icon between expand and compress
        if (this.firstElementChild.className === collapsed) {
            this.firstElementChild.className = expanded;
        }
        else {
            this.firstElementChild.className = collapsed;
        }

        // Only show the relevant widget type properties
        expandRow.change();
    });

    expandRow.change(function () {
        if (expandButton.children()[0].className === expanded) {
            expandRow.show();
        } else {
            expandRow.hide();
        }
    });
    expandRow.change();
}
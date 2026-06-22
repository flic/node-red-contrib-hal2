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

function halGetGroups(RED, eventHandlerId) {
    // Groups live in the EventHandler registry (config node). For back-compat we also
    // surface any legacy hal2Group nodes still in the flow (the runtime folds these in
    // too, by node id), so existing Action/Event references keep resolving until
    // tools/migrate-groups.js is run. Registry wins on id collision.
    // Returns [{ id, name, haType, notes, ratelimit }] sorted by name.
    var eh = eventHandlerId ? RED.nodes.node(eventHandlerId) : null;
    var groupsList = (eh && Array.isArray(eh.groups)) ? eh.groups.slice() : [];

    var seen = {};
    for (var i in groupsList) { seen[groupsList[i].id] = true; }

    var legacy = RED.nodes.filterNodes({type: "hal2Group"});
    for (var l in legacy) {
        var g = legacy[l];
        if (seen[g.id]) { continue; }
        if (eventHandlerId && g.eventHandler !== eventHandlerId) { continue; }
        groupsList.push({ id: g.id, name: g.name, haType: 'other', notes: '', ratelimit: Number(g.ratelimit) || 0 });
        seen[g.id] = true;
    }

    groupsList.sort(function(a, b) {
        if ((typeof a.name === 'undefined') || (typeof b.name === 'undefined')) { return 0; }
        var textA = a.name.toUpperCase();
        var textB = b.name.toUpperCase();
        return (textA < textB) ? -1 : (textA > textB) ? 1 : 0;
    });
    return groupsList;
}

// Canonical HAType list, shared by ThingType items and group definitions.
// `other` doubles as the "mixed/untyped" group mode (accepts any item).
function halHaTypes() {
    return [
        { v: 'button',             t: 'Button' },
        { v: 'switch',             t: 'Switch [On/Off]' },
        { v: 'light',              t: 'Light [On/Off]' },
        { v: 'dimmer',             t: 'Dimmer' },
        { v: 'cover',              t: 'Cover / Blind / Shutter' },
        { v: 'lock',               t: 'Lock' },
        { v: 'fan',                t: 'Fan' },
        { v: 'climate',            t: 'Climate / HVAC' },
        { v: 'media_player',       t: 'Media player' },
        { v: 'temperature',        t: 'Temperature sensor' },
        { v: 'humidity',           t: 'Humidity sensor' },
        { v: 'motion',             t: 'Motion sensor' },
        { v: 'contact',            t: 'Contact sensor' },
        { v: 'smoke',              t: 'Smoke sensor' },
        { v: 'co2',                t: 'CO₂ sensor' },
        { v: 'illuminance',        t: 'Illuminance sensor' },
        { v: 'power',              t: 'Power / Energy sensor' },
        { v: 'battery',            t: 'Battery sensor' },
        { v: 'water leak',         t: 'Water leak sensor' },
        { v: 'depth',              t: 'Depth sensor (mm)' },
        { v: 'pressure',           t: 'Pressure sensor (hPa)' },
        { v: 'ac mode',            t: 'AC mode (off/cool/heat/…)' },
        { v: 'fan mode',           t: 'AC fan mode' },
        { v: 'swing mode',         t: 'AC swing mode' },
        { v: 'color',              t: 'Color (HSB)' },
        { v: 'color temperature',  t: 'Color temperature' },
        { v: 'presence',           t: 'Presence (home/away)' },
        { v: 'room',               t: 'Room / Location' },
        { v: 'scene',              t: 'Scene' },
        { v: 'target temperature', t: 'Target temperature (setpoint)' },
        { v: 'heater',             t: 'Heater' },
        { v: 'circulation pump',   t: 'Circulation pump' },
        { v: 'airjets',            t: 'Airjets' },
        { v: 'binary_sensor',      t: 'Binary sensor (generic)' },
        { v: 'sensor',             t: 'Sensor (generic)' },
        { v: 'other',              t: 'Other / Mixed (any item type)' }
    ];
}

// Group compatibility family for a HAType. Items can share a group only if their
// families match (or the group is 'other'). Family defaults to the HAType itself
// — i.e. exact match — except where two HATypes are genuinely the same function
// AND command contract. The only such case today: switch ≡ light (boolean On/Off).
// dimmer / cover / color temperature are all 0–100 but different functions, so they
// stay distinct (singleton families).
function halHaTypeFamily(haType) {
    if (haType === 'switch' || haType === 'light') { return 'onoff'; }
    return haType || '';
}

// Can an item of `itemHaType` be a member of a group whose type is `groupHaType`?
// Compatibility is DIRECTIONAL — the member must be able to honour the group's
// command contract:
//   - an 'other' (mixed) group accepts anything;
//   - an untyped item ('') is a wildcard (membership is the user's responsibility);
//   - otherwise the families must match (switch ≡ light = On/Off), EXCEPT that a
//     dimmable item (dimmer family) may also join an On/Off group — turning a dimmer
//     off is well-defined. The reverse does NOT hold: a switch/light cannot join a
//     Dimmer group, because an On/Off device can't honour a 0–100 level.
function halGroupAccepts(groupHaType, itemHaType) {
    if (groupHaType === 'other') { return true; }
    if (!itemHaType) { return true; }
    var gFam = halHaTypeFamily(groupHaType);
    var iFam = halHaTypeFamily(itemHaType);
    if (iFam === gFam) { return true; }
    if (gFam === 'onoff' && iFam === 'dimmer') { return true; }
    return false;
}

function halGetThingTypes(RED,thingsList,filterOnStatus=false,filterOnCommand=false) {
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
            if (((filterOnCommand) && (thingType.thingCommand)) || ((filterOnStatus) && (thingType.thingStatus)) || ((filterOnStatus = false) && (filterOnCommand = false))) {
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
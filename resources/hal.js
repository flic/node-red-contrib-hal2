// Tags as the editors store them: a comma-separated field in, an array out. Blank entries are
// dropped rather than kept as '' — an empty tag would match a tag filter for the empty string.
function halParseTags(s) {
    if (Array.isArray(s)) { return s.map(function (t) { return String(t).trim(); }).filter(Boolean); }
    return (s || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
}

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

// Comparisons that can only mean a number. The editors narrow the value field's type list to
// num when one of these is chosen, the way hal2Event and hal2Gate have always done — offering
// a string for "greater than" only invites a comparison that works by coercion or not at all.
function halNumericOperator(op) {
    return ['lt', 'lte', 'gt', 'gte'].indexOf(op) >= 0;
}

// Fill a <select> with the value functions a group can serve, given its HAType. The saved
// value is always kept even when it no longer fits — the same rule the group HAType select
// follows, so a node can never be trapped by a group whose members changed under it. Returns
// true when the saved value is one of those strays, so the caller can say so on the row.
function halFillGroupFunctions(sel, haType, saved) {
    var ga = (typeof window !== 'undefined') && window.hal2GroupAggregate;
    if (!ga) { return false; }
    var fits = ga.functionsForHaType(haType);
    var stray = !!saved && fits.indexOf(saved) < 0;
    var deflt = ga.defaultFunction(haType);

    // Kept short enough to read inside the field: which default applies, and why a stray no
    // longer fits, are both said in full on the tip line under it.
    sel.children().remove();
    sel.append($('<option></option>').val('').text(deflt ? '(default)' : '(no default)'));
    fits.forEach(function (v) { sel.append($('<option></option>').val(v).text(ga.label(v))); });
    if (stray) { sel.append($('<option></option>').val(saved).text(ga.label(saved) + ' (unfit)')); }
    sel.val(saved || '');
    return stray;
}

// The line under a group's function picker: what the chosen function means, or what the
// group falls back to when none is chosen. `stray` is halFillGroupFunctions' return value.
function halGroupFunctionTip(haType, chosen, stray, strayNote) {
    var ga = (typeof window !== 'undefined') && window.hal2GroupAggregate;
    if (!ga) { return ''; }
    if (stray) { return strayNote; }
    if (chosen) { return ga.label(chosen) + ' — ' + ga.describe(chosen); }
    var deflt = ga.defaultFunction(haType);
    return deflt
        ? 'Following the group: ' + ga.label(deflt) + ' — ' + ga.describe(deflt) + '.'
        : 'This group has no default for its HAType — pick a function or it reads as no value.';
}

// The custom typedInput type for comparing against another live reading. The value the
// typedInput itself holds is unused — the source is picked in its own row, because a flat list
// of every thing item and group function runs to several hundred entries.
function halTypeState() {
    return { value: "state", label: "state", icon: "fa fa-sitemap", hasValue: false };
}

// Fill a source picker pair: a thing/group select and, depending on which was chosen, an item
// select or a group function select. `spec` is { src, thing, item, group, groupFunction } — the
// shape hal2Bayes uses for its steps, so both sides of a rule describe a source the same way.
// Returns the element set so the caller can show and hide them together.
function halFillSourcePicker(sel, itemSel, fnSel, things, groups, spec) {
    spec = spec || {};
    sel.children().remove();
    for (var g in groups) {
        sel.append($("<option></option>").val('g:' + groups[g].id).text('Group - ' + groups[g].name));
    }
    for (var t in things) {
        sel.append($("<option></option>").val('t:' + things[t].id).text(things[t].name));
    }
    var want = spec.src === 'group' ? 'g:' + spec.group : 't:' + spec.thing;
    if (sel.find('option[value="' + want + '"]').length) { sel.val(want); }

    return function sync() {
        var val = sel.val() || '';
        var isGroup = val.indexOf('g:') === 0;
        var id = val.slice(2);
        itemSel.toggle(!isGroup);
        fnSel.toggle(isGroup);
        if (isGroup) {
            var grp = null;
            for (var i in groups) { if (groups[i].id === id) { grp = groups[i]; } }
            halFillGroupFunctions(fnSel, grp && grp.haType,
                                  fnSel.val() || (spec.src === 'group' ? spec.groupFunction : '') || '');
        } else {
            var keep = (spec.src !== 'group' && spec.thing === id) ? spec.item : itemSel.val();
            halFillStatusItems(itemSel, id, keep);
        }
    };
}

// The status-capable items of a thing, for a source picker. Mirrors what every node's own item
// select already does; kept here so the compare side and the rule side agree on what is readable.
function halFillStatusItems(sel, thingId, keep) {
    sel.children().remove();
    var thing = thingId ? RED.nodes.node(thingId) : null;
    var tt = null;
    try { tt = thing ? RED.nodes.node(thing.thingType) : null; } catch (e) {}
    if (tt && Array.isArray(tt.items)) {
        tt.items.forEach(function (it) {
            if (halStatusItem(it)) { sel.append($("<option></option>").val(it.id).text(it.name)); }
        });
    }
    if (keep) { sel.val(keep); }
}

// Read a source picker back into the spec shape.
function halReadSourcePicker(sel, itemSel, fnSel) {
    var val = sel.val() || '';
    if (val.indexOf('g:') === 0) {
        return { src: 'group', group: val.slice(2), groupFunction: fnSel.val() || '' };
    }
    return { src: 'thing', thing: val.slice(2), item: itemSel.val() || '' };
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

function halGetGroups(RED, eventHandlerId, filter) {
    // Groups live in the EventHandler registry (config node). For back-compat we also
    // surface any legacy hal2Group nodes still in the flow (the runtime folds these in
    // too, by node id), so existing Action/Event references keep resolving until
    // tools/migrate-groups.js is run. Registry wins on id collision.
    // Returns [{ id, name, haType, notes, ratelimit, aggregate }] sorted by name.
    //
    // filter 'value' keeps only groups that have a value function configured — the ones
    // that can be read by Value/Gate/Event/Bayes. Expressed once here so every node that
    // offers a group as a source applies the same rule. Legacy hal2Group nodes never have
    // one, so they are command-only until migrated.
    // A specific handler when one is given and resolves; otherwise every handler in the
    // flow. Nodes that only gained an Event handler field recently (Value, Gate) carry an
    // empty one on existing instances, and a group id is unique across handlers anyway —
    // returning nothing there would silently offer an empty list instead of the real groups.
    var eh = eventHandlerId ? RED.nodes.node(eventHandlerId) : null;
    var groupsList = [];
    if (eh && Array.isArray(eh.groups)) {
        groupsList = eh.groups.slice();
    } else if (typeof RED.nodes.eachConfig === 'function') {
        // eachConfig, not filterNodes: the latter only walks flow nodes, and an Event
        // handler is a config node — it would find nothing at all.
        RED.nodes.eachConfig(function (cfg) {
            if (cfg && cfg.type === 'hal2EventHandler' && Array.isArray(cfg.groups)) {
                groupsList = groupsList.concat(cfg.groups);
            }
        });
    }

    var seen = {};
    for (var i in groupsList) { seen[groupsList[i].id] = true; }

    var legacy = RED.nodes.filterNodes({type: "hal2Group"});
    for (var l in legacy) {
        var g = legacy[l];
        if (seen[g.id]) { continue; }
        if (eventHandlerId && g.eventHandler !== eventHandlerId) { continue; }
        groupsList.push({ id: g.id, name: g.name, haType: 'other', notes: '', ratelimit: Number(g.ratelimit) || 0, aggregate: '' });
        seen[g.id] = true;
    }

    if (filter === 'value') {
        // Readable means "has members that carry a state" — not "someone configured a
        // function", which is no longer a thing anyone does. The reading nodes each pick a
        // function; what decides whether a group can be read at all is its membership.
        var readable = {};
        var things = RED.nodes.filterNodes({ type: "hal2Thing" });
        for (var t in things) {
            var thing = RED.nodes.node(things[t].id);
            if (!thing || !Array.isArray(thing.groups)) { continue; }
            var tt = null;
            try { tt = RED.nodes.node(thing.thingType); } catch (err) {}
            if (!tt || !Array.isArray(tt.items)) { continue; }
            for (var g in thing.groups) {
                var m = thing.groups[g];
                if (!m || !m.group || m.item === '1') { continue; }   // heartbeat is a filter, not a value
                var it = tt.items.find(function(x) { return x.id === m.item; });
                if (it && halStatusItem(it)) { readable[m.group] = true; }
            }
        }
        groupsList = groupsList.filter(function(x) { return x && readable[x.id]; });
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
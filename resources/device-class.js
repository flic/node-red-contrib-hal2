// What an item drives, as opposed to how you speak to it.
//
// `ha_type` answers the second question — switch, dimmer, cover — and for most devices the two
// coincide: a bulb is a light. They come apart at a relay. A Matter Metered Plug driving the
// coffee machine and one driving the ceiling lamp are the same ThingType with the same `switch`
// item, so the type cannot know; only the Thing does. `device_class` is where the Thing says so.
//
// Loaded two ways from one source, so the vocabulary the editor offers can never drift from the
// one the tools resolve against:
//   - editor: <script src="resources/node-red-contrib-hal2/device-class.js"> → window.hal2DeviceClass
//   - runtime/tests: require('../resources/device-class')

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
    else { root.hal2DeviceClass = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Which item ha_types define each device category. Single source of truth for category
    // derivation, ha_type filter expansion and tool exposure. Extend freely if a location uses
    // non-standard ha_types for a category.
    var HA_TYPE_GROUPS = {
        climate : ['target temperature', 'ac mode', 'fan mode', 'swing mode'],
        spa     : ['heater', 'circulation pump', 'airjets'],
        light   : ['light', 'dimmer'],
        fan     : ['fan'],
        cover   : ['cover'],
        scene   : ['scene']
    };

    // What a switch may be declared to drive. Deliberately NOT every category: a class is only
    // worth offering where something can act on it once declared.
    //
    //   light      — set_light switches it, and it answers a query for lights.
    //   fan        — it reads as a fan and stays out of the lights. control_fan cannot set a
    //                speed on a relay, so it is turned on and off with control_device.
    //   appliance  — explicitly none of the above. A plug on the coffee machine says so rather
    //                than staying silent, which is the difference between "not classified yet"
    //                and "classified, and not a light".
    //
    // climate, spa, cover and scene are left out on purpose. Their tools dispatch on the setpoint,
    // mode, position and scene ha_types, none of which a switch has, so declaring one would
    // advertise a capability nothing could honour — a radiator on a relay is an appliance, and
    // control_device is what commands it. 'outlet' is left out for the opposite reason: nothing
    // would behave differently from 'appliance', and two values with one behaviour only split the
    // data arbitrarily.
    var DEVICE_CLASSES = ['light', 'fan', 'appliance'];

    // Whether an item's ha_type leaves the question open, and so whether it is worth asking.
    // A `light`, `dimmer`, `cover` or `fan` item says what it is; a `switch` says only that
    // something can be turned on and off, and the load decides the rest.
    function needsDeviceClass(haType) {
        return String(haType || '').toLowerCase() === 'switch';
    }

    // The class an ha_type implies on its own. A `light` or `dimmer` drives a light and needs
    // nobody to say so; a `switch` could be driving anything, which is the whole reason
    // device_class exists. Returns '' when the ha_type does not settle the question.
    function deviceClassFromHaType(haType) {
        var t = String(haType || '').toLowerCase();
        for (var cat in HA_TYPE_GROUPS) {
            if (!Object.prototype.hasOwnProperty.call(HA_TYPE_GROUPS, cat)) { continue; }
            for (var i = 0; i < HA_TYPE_GROUPS[cat].length; i++) {
                if (HA_TYPE_GROUPS[cat][i].toLowerCase() === t) { return cat; }
            }
        }
        return '';
    }

    // What this item presents as: what it was declared to drive, or what its ha_type implies.
    // The declaration wins — it is the one that knows what is wired to this particular Thing.
    function effectiveDeviceClass(item) {
        var explicit = String((item && item.device_class) || '').toLowerCase();
        if (explicit) { return explicit; }
        return deviceClassFromHaType(item && item.ha_type);
    }

    // What an item counts as when the device is categorised — the declaration if there is one,
    // otherwise what the ha_type implies. Phrased as counting rather than driving, because that
    // is what HA_TYPE_GROUPS says and no more: `dimmer` does not mean the item drives a light,
    // it means an item like this is part of what makes the device one. Calling it "derived: the
    // item drives a light" claimed something the rule never did, and read as a bug on every
    // brightness row. Returns '' when nothing counts.
    function countsAs(declared, haType) {
        return effectiveDeviceClass({ device_class: declared, ha_type: haType });
    }

    return {
        HA_TYPE_GROUPS: HA_TYPE_GROUPS,
        DEVICE_CLASSES: DEVICE_CLASSES,
        deviceClassFromHaType: deviceClassFromHaType,
        effectiveDeviceClass: effectiveDeviceClass,
        countsAs: countsAs,
        needsDeviceClass: needsDeviceClass
    };
}));

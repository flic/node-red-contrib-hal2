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

    // The categories above, because every consumer already understands them, plus 'appliance'
    // for "explicitly none of these" — a plug on the coffee machine says so rather than staying
    // silent, which is the difference between "not classified yet" and "classified, not a light".
    var DEVICE_CLASSES = Object.keys(HA_TYPE_GROUPS).concat(['appliance']);

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

    // A label for a dropdown row: the declared value, or what the ha_type already implies shown
    // as inherited, so the Thing view answers "what does this item present as" without anyone
    // opening the ThingType to find out.
    function describe(declared, haType) {
        if (declared) { return declared; }
        var derived = deviceClassFromHaType(haType);
        return derived ? '— derived: ' + derived + ' —' : '— none —';
    }

    return {
        HA_TYPE_GROUPS: HA_TYPE_GROUPS,
        DEVICE_CLASSES: DEVICE_CLASSES,
        deviceClassFromHaType: deviceClassFromHaType,
        effectiveDeviceClass: effectiveDeviceClass,
        describe: describe
    };
}));

'use strict';
// The per-Thing function store: the object handed to a ThingType's ingress, egress, filter and
// status functions as `store`, so they can remember something between messages the way a
// function node uses context.get/set.
//
// Pure — the backing object and the persist callback are injected, so the caller decides where
// the data lives (hal2Thing keeps it in node context under the ThingType's context store).
// Values must be JSON-serialisable, because that is what a context store can hold.

// `bag` is the live object holding the values; `persist` is called after every mutation.
// Returns { api, replace } — `api` is what gets injected into the functions, `replace` swaps
// the backing object (clear() needs a fresh one rather than deleting key by key).
function createStore(bag, persist) {
    var current = bag || {};
    persist = persist || function () {};

    var api = {
        get: function (key) { return current[key]; },
        set: function (key, val) {
            if (typeof key === 'undefined') { return; }
            // null/undefined deletes, matching the metadata channel's "empty value removes it".
            if (val === undefined || val === null) { delete current[key]; }
            else { current[key] = val; }
            persist(current);
        },
        keys: function () { return Object.keys(current); },
        clear: function () { current = {}; persist(current); }
    };

    return {
        api: api,
        // Read the live bag — after clear() it is a different object than the one passed in.
        value: function () { return current; }
    };
}

module.exports = { createStore };

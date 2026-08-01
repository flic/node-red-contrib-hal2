// How a group turns its members' states into one value of its own.
//
// Loaded two ways from one source, so the function list the editor offers can never drift
// from what the engine computes:
//   - editor: <script src="resources/node-red-contrib-hal2/group-aggregate.js"> → window.hal2GroupAggregate
//   - runtime/tests: require('../resources/group-aggregate')
//
// The module is pure: it receives the samples that count and returns a value. Deciding which
// members count — state-capable item, thing alive, has ever reported — belongs to the engine,
// so "no live member" and "no member at all" arrive here as the same empty list.

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
    else { root.hal2GroupAggregate = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // kind drives the order the editor offers these in, given the group's HAType. Nothing is
    // ever hidden — a mixed group may legitimately want to count booleans.
    var FUNCTIONS = [
        { v: 'latest',      t: 'latest — the most recently updated member',  kind: 'any' },
        { v: 'min',         t: 'min — the lowest value',                     kind: 'number' },
        { v: 'max',         t: 'max — the highest value',                    kind: 'number' },
        { v: 'average',     t: 'average — the mean of all values',           kind: 'number' },
        { v: 'median',      t: 'median — the middle value',                  kind: 'number' },
        { v: 'sum',         t: 'sum — all values added together',            kind: 'number' },
        { v: 'range',       t: 'range — highest minus lowest',               kind: 'number' },
        { v: 'anyTrue',     t: 'any true — at least one member is true',     kind: 'boolean' },
        { v: 'allTrue',     t: 'all true — every member is true',            kind: 'boolean' },
        { v: 'anyFalse',    t: 'any false — at least one member is false',   kind: 'boolean' },
        { v: 'allFalse',    t: 'all false — no member is true',              kind: 'boolean' },
        { v: 'countTrue',   t: 'count true — how many are true',             kind: 'boolean' },
        { v: 'countFalse',  t: 'count false — how many are false',           kind: 'boolean' },
        { v: 'percentTrue', t: 'percent true — share that are true (0–100)', kind: 'boolean' }
    ];

    // Which flavour of value a group's HAType tends to want, used to preselect a function for
    // a new group and to order the list. Keys are HATypes from halHaTypes() in hal.js; anything
    // not listed (modes, colors, scenes, 'other') falls through to 'any'. Only a starting
    // point: any function can be chosen afterwards.
    var KIND_BY_HATYPE = {
        temperature: 'number', humidity: 'number', co2: 'number', illuminance: 'number',
        power: 'number', battery: 'number', depth: 'number', pressure: 'number',
        dimmer: 'number', cover: 'number', 'color temperature': 'number',
        'target temperature': 'number', sensor: 'number',
        switch: 'boolean', light: 'boolean', lock: 'boolean', fan: 'boolean',
        motion: 'boolean', contact: 'boolean', smoke: 'boolean', 'water leak': 'boolean',
        presence: 'boolean', heater: 'boolean', 'circulation pump': 'boolean',
        airjets: 'boolean', binary_sensor: 'boolean'
    };
    var SUGGESTION = { number: 'average', boolean: 'anyTrue', any: 'latest' };

    function suggestFor(haType) {
        return SUGGESTION[KIND_BY_HATYPE[haType] || 'any'];
    }

    function kindOf(fn) {
        for (var i = 0; i < FUNCTIONS.length; i++) {
            if (FUNCTIONS[i].v === fn) { return FUNCTIONS[i].kind; }
        }
        return null;
    }

    function isFunction(fn) { return kindOf(fn) !== null; }

    function label(fn) {
        for (var i = 0; i < FUNCTIONS.length; i++) {
            if (FUNCTIONS[i].v === fn) { return FUNCTIONS[i].t; }
        }
        return fn;
    }

    // Float noise is not a value anyone wants to see in a status badge or compare against:
    // (21.5 + 22.3) / 2 is 21.900000000000002 in binary floating point.
    function round(n) { return Math.round(n * 1e4) / 1e4; }

    // Only genuine numbers, or the numeric strings sensors so often send. Booleans are
    // excluded deliberately: Number(true) is 1, which would let an on/off member skew an
    // average as if it had measured something.
    function numbers(samples) {
        var out = [];
        for (var i = 0; i < samples.length; i++) {
            var s = samples[i].state;
            if (typeof s !== 'number' && typeof s !== 'string') { continue; }
            if (typeof s === 'string' && s.trim() === '') { continue; }
            var n = Number(s);
            if (isFinite(n)) { out.push(n); }
        }
        return out;
    }

    // Strict, exactly like the comparison operators in lib/rules.js: a ThingType's ingress
    // function is where 'ON' becomes true, so by the time a state reaches a group it is a
    // real boolean or it is not a boolean at all.
    function booleans(samples) {
        var out = [];
        for (var i = 0; i < samples.length; i++) {
            if (samples[i].state === true || samples[i].state === false) { out.push(samples[i].state); }
        }
        return out;
    }

    function count(list, wanted) {
        var n = 0;
        for (var i = 0; i < list.length; i++) { if (list[i] === wanted) { n++; } }
        return n;
    }

    // aggregate(fn, samples) → value, or undefined when nothing eligible contributed.
    // samples: [{ state, updatedAt }]. Returning undefined rather than 0/false is what keeps a
    // silent group from reading as a real "off" in a Gate or an Event.
    function aggregate(fn, samples) {
        samples = Array.isArray(samples) ? samples : [];
        if (!samples.length) { return undefined; }

        if (fn === 'latest') {
            var best = null;
            for (var i = 0; i < samples.length; i++) {
                if (samples[i].state === undefined) { continue; }
                if (!best || (samples[i].updatedAt || 0) > (best.updatedAt || 0)) { best = samples[i]; }
            }
            return best ? best.state : undefined;
        }

        var kind = kindOf(fn);
        if (kind === 'number') {
            var nums = numbers(samples);
            if (!nums.length) { return undefined; }
            switch (fn) {
                case 'min': return Math.min.apply(null, nums);
                case 'max': return Math.max.apply(null, nums);
                case 'sum': return round(nums.reduce(function (a, b) { return a + b; }, 0));
                case 'range': return round(Math.max.apply(null, nums) - Math.min.apply(null, nums));
                case 'average':
                    return round(nums.reduce(function (a, b) { return a + b; }, 0) / nums.length);
                case 'median': {
                    var sorted = nums.slice().sort(function (a, b) { return a - b; });
                    var mid = Math.floor(sorted.length / 2);
                    return sorted.length % 2
                        ? sorted[mid]
                        : round((sorted[mid - 1] + sorted[mid]) / 2);
                }
            }
            return undefined;
        }

        if (kind === 'boolean') {
            var bools = booleans(samples);
            if (!bools.length) { return undefined; }
            switch (fn) {
                // Note these are not vacuous: an empty set returned above. 'all true' over
                // members that are all present and all true is the only way to get true.
                case 'anyTrue':   return count(bools, true) > 0;
                case 'allTrue':   return count(bools, true) === bools.length;
                case 'anyFalse':  return count(bools, false) > 0;
                case 'allFalse':  return count(bools, true) === 0;
                case 'countTrue': return count(bools, true);
                case 'countFalse':return count(bools, false);
                case 'percentTrue': return round(100 * count(bools, true) / bools.length);
            }
        }

        return undefined;
    }

    // How many of these samples a function would actually use. 'latest' takes anything that has
    // reported; the numeric and boolean families each take only their own kind. Zero means the
    // question cannot be asked of these members at all — asking a temperature group whether all
    // its members are true is not a query that returns false, it is a query that does not apply.
    function usableCount(fn, samples) {
        samples = Array.isArray(samples) ? samples : [];
        if (fn === 'latest') {
            var n = 0;
            for (var i = 0; i < samples.length; i++) { if (samples[i].state !== undefined) { n++; } }
            return n;
        }
        var kind = kindOf(fn);
        if (kind === 'number')  { return numbers(samples).length; }
        if (kind === 'boolean') { return booleans(samples).length; }
        return 0;
    }

    // The functions that would return something for these members, in catalog order — what to
    // offer instead when the one asked for does not apply.
    function suitableFunctions(samples) {
        var out = [];
        for (var i = 0; i < FUNCTIONS.length; i++) {
            if (usableCount(FUNCTIONS[i].v, samples) > 0) { out.push(FUNCTIONS[i].v); }
        }
        return out;
    }

    // What these members look like, for saying why a function does not fit.
    function sampleKinds(samples) {
        return {
            numbers  : numbers(samples).length,
            booleans : booleans(samples).length,
            reporting: usableCount('latest', samples)
        };
    }

    // One step of a group's state record, mirroring what hal2Thing.updateState does to a
    // thing item (core/thing.js:218-231) — because hal2Event's change filters compare
    // state against laststate and must behave identically for both.
    //
    // The rule that matters: `laststate` is ALWAYS the previous value, even when it is the
    // same value. Only `last_change` is conditional. Carrying the last *different* value
    // forward instead would make every later update look like a change, which is exactly
    // what "on change" is there to suppress.
    function nextRecord(prev, value, now) {
        prev = prev || {};
        var changed = prev.state !== value;
        return {
            state:       value,
            laststate:   prev.state,
            last_update: now,
            last_change: changed ? now : (prev.last_change || now),
            changed:     changed
        };
    }

    return {
        FUNCTIONS: FUNCTIONS,
        aggregate: aggregate,
        usableCount: usableCount,
        suitableFunctions: suitableFunctions,
        sampleKinds: sampleKinds,
        nextRecord: nextRecord,
        suggestFor: suggestFor,
        kindOf: kindOf,
        isFunction: isFunction,
        label: label
    };
}));

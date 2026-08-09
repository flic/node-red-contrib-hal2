'use strict';
// Shared rule primitives for hal2Gate and hal2Event: value converters and comparison
// operators. Kept as pure functions so both nodes evaluate rules identically and the logic
// is unit-testable without Node-RED. Context-bound converters (flow, global, env, msg) stay
// in the nodes that need them, since they require runtime node/message state.

// Base value converters. value = raw config string → typed value.
const CONVERTERS = {
    num:  (value) => Number(value),
    str:  (value) => value + '',
    bool: (value) => (value === 'true'),
    json: (value) => JSON.parse(value),
    re:   (value) => new RegExp(value)
};

// Comparison operators. a = current/state value, b = comparison value (already converted).
const COMPARE = {
    eq:      (a, b) => a === b,
    neq:     (a, b) => a !== b,
    lt:      (a, b) => (typeof a === 'number') && (a < b),
    lte:     (a, b) => (typeof a === 'number') && (a <= b),
    gt:      (a, b) => (typeof a === 'number') && (a > b),
    gte:     (a, b) => (typeof a === 'number') && (a >= b),
    cont:    (a, b) => (a + '').indexOf(b) !== -1,
    regex:   (a, b) => b.test(a + ''),
    'true':  (a)    => a === true,
    'false': (a)    => a === false,
    // Inclusive at both ends, and indifferent to which bound was typed first: a range is a
    // pair, not an ordered instruction, and "20 to 24" and "24 to 20" name the same band.
    // The pair arrives as b rather than as a third argument, because the third is already
    // spoken for — hal2Event passes laststate there. A non-numeric bound makes every
    // comparison false rather than throwing, so a half-filled rule stays quiet.
    range:   (a, b) => (typeof a === 'number') && Array.isArray(b) &&
                       a >= Math.min(b[0], b[1]) && a <= Math.max(b[0], b[1]),
    // Not simply the negation: a reading that is not a number is outside nothing. Written out
    // rather than as !range so a non-numeric or half-filled rule stays false both ways, instead
    // of one operator failing closed and its opposite failing open.
    outrange:(a, b) => (typeof a === 'number') && Array.isArray(b) &&
                       (a < Math.min(b[0], b[1]) || a > Math.max(b[0], b[1]))
};

// A range's two bounds, as the comparators want them. Not simply Number(): Number('') is 0 and
// Number(' ') is 0, so an empty field would quietly become a real bound and the rule would match
// a band nobody configured. NaN is the only value that makes both range and outrange false, and
// a half-filled rule should say nothing rather than something arbitrary.
const rangeBounds = (low, high) => [blankToNaN(low), blankToNaN(high)];
const blankToNaN = (v) =>
    (v === null || v === undefined || String(v).trim() === '') ? NaN : Number(v);

module.exports = { CONVERTERS, COMPARE, rangeBounds };

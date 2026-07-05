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
    'false': (a)    => a === false
};

module.exports = { CONVERTERS, COMPARE };

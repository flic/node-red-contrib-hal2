'use strict';
// Checks a tool call's arguments against the tool's inputSchema before the flow sees them. The
// schema was documentation for the model until 3.0.0, and flows built URLs and paths from
// arguments it declared as integers; a caller sending "../" where a number belongs now gets an
// error instead of a request.
//
// A deliberate subset of JSON Schema, the part tool schemas are written in: type, required,
// properties, additionalProperties, enum, const, minimum/maximum (and exclusive), minLength,
// maxLength, pattern, items, minItems, maxItems. Anything else is not checked — unsupportedKeywords
// names it, so the server can say so once rather than seem to check what it does not.

const SUPPORTED = new Set(['type', 'required', 'properties', 'additionalProperties', 'enum', 'const',
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern',
    'items', 'minItems', 'maxItems',
    // Annotations: carry no constraint.
    'description', 'title', 'default', 'examples', '$schema', '$id', '$comment']);

// The shape tools/list publishes: a bare properties map is accepted for an object schema.
function normalizeSchema(s) {
    return (s && typeof s === 'object' && s.type === 'object') ? s : { type: 'object', properties: s || {} };
}

function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;   // 'object' | 'string' | 'number' | 'boolean'
}

function matchesType(v, t) {
    if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
    if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
    return typeOf(v) === t;
}

const regexCache = new Map();
function regex(pattern) {
    if (!regexCache.has(pattern)) {
        let re = null;
        try { re = new RegExp(pattern, 'u'); } catch { /* reported as a schema problem below */ }
        regexCache.set(pattern, re);
    }
    return regexCache.get(pattern);
}

const at = path => path || 'arguments';
const show = v => { const s = JSON.stringify(v); return s && s.length > 60 ? s.slice(0, 60) + '…' : s; };

function check(schema, value, path, problems) {
    if (!schema || typeof schema !== 'object' || problems.length >= 10) return;

    if (schema.type !== undefined) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.some(t => matchesType(value, t))) {
            // A number or flag is its own description; a string says it is one, since "5" and 5
            // read alike; anything larger is named by its type alone.
            const got = typeof value === 'number' || typeof value === 'boolean' || value === null ? show(value)
                : typeof value === 'string' ? 'string ' + show(value) : typeOf(value);
            problems.push(at(path) + ' must be ' + types.map(t => (/^[aeiou]/.test(t) ? 'an ' : 'a ') + t).join(' or ')
                + ', got ' + got);
            return;   // nothing below means anything for the wrong type
        }
    }
    if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
        problems.push(at(path) + ' must be ' + show(schema.const));
    }
    if (Array.isArray(schema.enum) && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) {
        problems.push(at(path) + ' must be one of ' + schema.enum.map(show).join(', ') + ', got ' + show(value));
    }

    if (typeof value === 'number') {
        if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push(at(path) + ' must be at least ' + schema.minimum);
        if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push(at(path) + ' must be at most ' + schema.maximum);
        if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) problems.push(at(path) + ' must be more than ' + schema.exclusiveMinimum);
        if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) problems.push(at(path) + ' must be less than ' + schema.exclusiveMaximum);
    }

    if (typeof value === 'string') {
        if (typeof schema.minLength === 'number' && [...value].length < schema.minLength) problems.push(at(path) + ' must be at least ' + schema.minLength + ' characters');
        if (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) problems.push(at(path) + ' must be at most ' + schema.maxLength + ' characters');
        if (typeof schema.pattern === 'string') {
            const re = regex(schema.pattern);
            if (!re) problems.push('the schema\'s pattern for ' + at(path) + ' is not a valid regular expression');
            else if (!re.test(value)) problems.push(at(path) + ' must match ' + schema.pattern);
        }
    }

    if (Array.isArray(value)) {
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) problems.push(at(path) + ' must have at least ' + schema.minItems + ' items');
        if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) problems.push(at(path) + ' must have at most ' + schema.maxItems + ' items');
        if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
            value.forEach((v, i) => check(schema.items, v, at(path) + '[' + i + ']', problems));
        }
    }

    if (typeOf(value) === 'object') {
        const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
        for (const name of Array.isArray(schema.required) ? schema.required : []) {
            if (!Object.prototype.hasOwnProperty.call(value, name) || value[name] === undefined) {
                problems.push((path ? path + '.' : '') + name + ' is required');
            }
        }
        for (const [name, v] of Object.entries(value)) {
            const sub = (path ? path + '.' : '') + name;
            if (Object.prototype.hasOwnProperty.call(props, name)) check(props[name], v, sub, problems);
            else if (schema.additionalProperties === false) problems.push(sub + ' is not a known argument');
            else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') check(schema.additionalProperties, v, sub, problems);
        }
    }
}

// validateArgs(schema, args) → [] when valid, else up to ten human-readable problems.
function validateArgs(schema, args) {
    const problems = [];
    check(normalizeSchema(schema), args === undefined ? {} : args, '', problems);
    // Ten say what is wrong; more only bury it.
    return problems.slice(0, 10);
}

// Keywords in a schema this validator does not check, so a server can say so once per tool.
function unsupportedKeywords(schema) {
    const found = new Set();
    (function walk(s, depth) {
        if (!s || typeof s !== 'object' || Array.isArray(s) || depth > 20) return;
        for (const [k, v] of Object.entries(s)) {
            if (!SUPPORTED.has(k)) found.add(k);
            if (k === 'properties' && v && typeof v === 'object') Object.values(v).forEach(p => walk(p, depth + 1));
            if ((k === 'items' || k === 'additionalProperties') && v && typeof v === 'object') walk(v, depth + 1);
        }
    })(normalizeSchema(schema), 0);
    return [...found];
}

module.exports = { validateArgs, unsupportedKeywords, normalizeSchema };

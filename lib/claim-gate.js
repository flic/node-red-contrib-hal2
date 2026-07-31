'use strict';
// Claim-based access gates for the mcp-server config node. One claim name is configured on
// the server (default `groups`, or a dotted path such as `realm_access.roles` for providers
// that nest); every other authorization field is a comma-separated list of
// values matched any-of against that claim. Gates compose with AND: reaching a tool means
// clearing the server's list and that tool's own list. An empty list is no constraint at all.
//
// Pure and dependency-free, so the whole authorization model is unit-testable in isolation —
// the node's request handler is thin glue that builds a gate from the verified claims and asks
// it yes/no questions.

// Split a configured value into its individual values. Comma only, deliberately: group names
// may legitimately contain spaces, and the single-value fields this generalizes always matched
// the raw (trimmed) string.
function parseList(list) {
    if (typeof list !== 'string') return [];
    return list.split(',').map(s => s.trim()).filter(Boolean);
}

// Read the configured claim out of a token payload. A literal key always wins, so any claim
// name that resolves today keeps resolving to exactly the same value; only a dotted name with
// no matching literal key is walked as a path. That covers providers that nest their roles —
// Keycloak's `realm_access.roles`, Auth0's namespaced objects — without hard-coding any.
//
// Note what this can change: a dotted name previously matched nothing and therefore denied
// everyone. Such a gate now starts resolving, which is the point of the change but does mean
// a config that was failing closed by accident becomes permissive as its author intended.
//
// Traversal stops at anything that is not a plain object, so `a.b` against `{ a: ['x'] }`
// yields undefined rather than reaching into array indices, and `hasOwnProperty` at each step
// keeps a name like `constructor.name` from walking the prototype chain.
function readClaim(claims, claimName) {
    if (!claims || typeof claimName !== 'string' || !claimName) return undefined;
    if (Object.prototype.hasOwnProperty.call(claims, claimName)) return claims[claimName];
    if (claimName.indexOf('.') === -1) return undefined;
    let node = claims;
    for (const part of claimName.split('.')) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
        if (!Object.prototype.hasOwnProperty.call(node, part)) return undefined;
        node = node[part];
    }
    return node;
}

// Does `list` actively grant access? An empty list grants nothing — treating empty as "allow"
// is a policy decision belonging to the caller (see claimAllows), not to the matching itself.
//
// Only strings and arrays of them match. Strict equality already excluded numbers and booleans;
// the explicit check states the rule and keeps an object-valued claim — which a dotted path can
// now easily produce, e.g. the `realm_access` container itself — from being compared at all.
function grants(claims, claimName, list) {
    const wanted = parseList(list);
    if (!wanted.length) return false;
    if (!claims) return false;
    const v = readClaim(claims, claimName);
    if (Array.isArray(v)) return wanted.some(w => v.includes(w));
    if (typeof v !== 'string') return false;
    return wanted.some(w => v === w);
}

// A single gate field: an empty list imposes no constraint, otherwise the claim must match it.
function claimAllows(claims, claimName, list) {
    if (!parseList(list).length) return true;
    return grants(claims, claimName, list);
}

// Bundles the per-request decision: the server-wide field, plus `allows()` for any additional
// per-tool field. Every tool — dynamic or admin — goes through `allows`, so the server gate can
// never be bypassed by a tool's own list.
function createToolGate({ claims, claimName, serverValue }) {
    const serverGranted = claimAllows(claims, claimName, serverValue);
    return {
        serverGranted,
        allows: list => serverGranted && claimAllows(claims, claimName, list)
    };
}

// The `tools/list` payload for one caller: registered tools the gate permits, with their schema
// normalized to a JSON-Schema object (a bare properties map is accepted as a convenience).
function visibleTools(registeredTools, gate) {
    const tools = [];
    for (const [name, t] of Object.entries(registeredTools || {})) {
        if (!gate.allows(t.requiredValue)) continue;
        const s = t.schema;
        const inputSchema = (s && s.type === 'object') ? s : { type: 'object', properties: s || {} };
        tools.push({ name, description: t.description, inputSchema });
    }
    return tools;
}

module.exports = { readClaim, grants, claimAllows, createToolGate, visibleTools };

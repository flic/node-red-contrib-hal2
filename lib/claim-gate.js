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

// The scopes a token carries, as a list. The claim name is not configurable because it is
// standardised: RFC 9068 defines `scope` for JWT access tokens, and RFC 7662 uses the same name
// in an introspection response. The one deviation that exists in the wild is `scp` — Microsoft
// Entra, and Okta, which sends it as an array — so that is read when `scope` is absent, and
// `scope` wins when both are present. A present-but-unusable `scope` yields nothing rather than
// falling through, so the answer never depends on which of two claims looked better.
//
// OAuth defines the value as a space-delimited string (RFC 6749 3.3); an array is accepted too
// because providers send one.
function tokenScopes(claims) {
    const raw = readClaim(claims, 'scope');
    const v = (raw === undefined) ? readClaim(claims, 'scp') : raw;
    if (Array.isArray(v)) return v.filter(x => typeof x === 'string');
    if (typeof v !== 'string') return [];
    return v.split(/\s+/).filter(Boolean);
}

// Does the token's scope satisfy this field? An empty field is no constraint; a configured one
// must be met, so a token with no scope claim at all is refused rather than waved through.
function scopeAllows(claims, list) {
    const wanted = parseList(list);
    if (!wanted.length) return true;
    const held = tokenScopes(claims);
    return wanted.some(w => held.includes(w));
}

// A single gate field: an empty list imposes no constraint, otherwise the claim must match it.
function claimAllows(claims, claimName, list) {
    if (!parseList(list).length) return true;
    return grants(claims, claimName, list);
}

// Bundles the per-request decision: the server-wide field, plus `allows()` for any additional
// per-tool field. Every tool — dynamic or admin — goes through `allows`, so the server gate can
// never be bypassed by a tool's own list.
//
// Two independent axes, composed with AND. The claim axis asks what the *user* may do; the scope
// axis asks what the *client* was authorized to do on their behalf. Collapsing them into one
// field would mean consulting only one of them: a client granted read-only scope, driven by a
// user who may write, would write — the client's authority has to bound the user's, not be
// ignored. Delegation is what scopes are for.
function createToolGate({ claims, claimName, serverValue, serverScope }) {
    const serverGranted = claimAllows(claims, claimName, serverValue)
                       && scopeAllows(claims, serverScope);
    return {
        serverGranted,
        allows: (list, scopeList) => serverGranted
            && claimAllows(claims, claimName, list)
            && scopeAllows(claims, scopeList)
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

module.exports = { readClaim, grants, claimAllows, tokenScopes, scopeAllows,
                   createToolGate, visibleTools };

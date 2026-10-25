'use strict';

const assert = require('node:assert');
const { readClaim, grants, claimAllows, createToolGate, visibleTools, tokenScopes, scopeAllows, requiredScopeChallenge, advertisedScopes, gateReadsClaim } = require('../lib/claim-gate');

describe('lib/claim-gate grants', function () {
    it('grants nothing for an empty or absent list', function () {
        assert.strictEqual(grants({ groups: ['admin'] }, 'groups', ''), false);
        assert.strictEqual(grants({ groups: ['admin'] }, 'groups', undefined), false);
        assert.strictEqual(grants({ groups: ['admin'] }, 'groups', '  ,  '), false);
    });

    it('denies when claims are missing entirely', function () {
        assert.strictEqual(grants(null, 'groups', 'admin'), false);
        assert.strictEqual(grants(undefined, 'groups', 'admin'), false);
    });

    it('matches a scalar claim value', function () {
        assert.strictEqual(grants({ role: 'admin' }, 'role', 'admin'), true);
        assert.strictEqual(grants({ role: 'user' }, 'role', 'admin'), false);
    });

    it('matches an array claim value', function () {
        assert.strictEqual(grants({ groups: ['user', 'admin'] }, 'groups', 'admin'), true);
        assert.strictEqual(grants({ groups: ['user'] }, 'groups', 'admin'), false);
    });

    it('denies when the claim is missing from an otherwise valid claims object', function () {
        assert.strictEqual(grants({ sub: 'x' }, 'groups', 'admin'), false);
    });

    it('treats a comma-separated list as any-of', function () {
        assert.strictEqual(grants({ groups: ['media'] }, 'groups', 'media,ops'), true);
        assert.strictEqual(grants({ groups: ['ops'] }, 'groups', 'media,ops'), true);
        assert.strictEqual(grants({ groups: ['guest'] }, 'groups', 'media,ops'), false);
        assert.strictEqual(grants({ role: 'ops' }, 'role', 'media,ops'), true);
    });

    it('trims whitespace around list items and ignores empty ones', function () {
        assert.strictEqual(grants({ groups: ['ops'] }, 'groups', ' media , ops '), true);
        assert.strictEqual(grants({ groups: ['ops'] }, 'groups', 'media,,ops'), true);
        assert.strictEqual(grants({ groups: [''] }, 'groups', 'a,,b'), false);
    });

    it('matches a nested claim addressed by a dotted path', function () {
        const keycloak = { realm_access: { roles: ['ops'] } };
        assert.strictEqual(grants(keycloak, 'realm_access.roles', 'ops'), true);
        assert.strictEqual(grants(keycloak, 'realm_access.roles', 'admin'), false);
        assert.strictEqual(grants({ nested: { role: 'ops' } }, 'nested.role', 'ops'), true);
        // The container object itself is not a match for anything.
        assert.strictEqual(grants(keycloak, 'realm_access', 'ops'), false);
    });

    it('grants nothing for a claim that is neither string nor array', function () {
        assert.strictEqual(grants({ n: 5 }, 'n', '5'), false);
        assert.strictEqual(grants({ b: true }, 'b', 'true'), false);
        assert.strictEqual(grants({ o: { a: 1 } }, 'o', '[object Object]'), false);
    });

    it('keeps values containing spaces intact — only commas separate', function () {
        assert.strictEqual(grants({ groups: ['power users'] }, 'groups', 'power users'), true);
        assert.strictEqual(grants({ groups: ['power'] }, 'groups', 'power users'), false);
    });
});

describe('lib/claim-gate readClaim', function () {
    const KEYCLOAK = { sub: 'x', realm_access: { roles: ['ops', 'default-roles'] } };

    it('reads a top-level claim', function () {
        assert.deepStrictEqual(readClaim({ groups: ['a'] }, 'groups'), ['a']);
        assert.strictEqual(readClaim({ role: 'admin' }, 'role'), 'admin');
    });

    it('walks a dotted path when there is no literal key', function () {
        assert.deepStrictEqual(readClaim(KEYCLOAK, 'realm_access.roles'), ['ops', 'default-roles']);
        assert.strictEqual(readClaim({ a: { b: { c: 'deep' } } }, 'a.b.c'), 'deep');
    });

    it('prefers a literal key over the path reading of the same name', function () {
        // A provider that really does emit a key with a dot in it must keep working, and an
        // existing gate configured against one must not start resolving somewhere else.
        const both = { 'realm_access.roles': ['literal'], realm_access: { roles: ['nested'] } };
        assert.deepStrictEqual(readClaim(both, 'realm_access.roles'), ['literal']);
    });

    it('returns undefined for a path that goes nowhere', function () {
        assert.strictEqual(readClaim(KEYCLOAK, 'realm_access.missing'), undefined);
        assert.strictEqual(readClaim(KEYCLOAK, 'missing.roles'), undefined);
        assert.strictEqual(readClaim({ a: ['x'] }, 'a.b'), undefined);       // no array indexing
        assert.strictEqual(readClaim({ a: 'str' }, 'a.length'), undefined);  // no string props
    });

    it('does not walk the prototype chain', function () {
        assert.strictEqual(readClaim({}, 'constructor.name'), undefined);
        assert.strictEqual(readClaim({ a: {} }, 'a.__proto__'), undefined);
        assert.strictEqual(readClaim({}, 'toString'), undefined);
    });

    it('handles absent claims and empty names', function () {
        assert.strictEqual(readClaim(null, 'groups'), undefined);
        assert.strictEqual(readClaim({ groups: [] }, ''), undefined);
        assert.strictEqual(readClaim({ groups: [] }, null), undefined);
    });
});

describe('lib/claim-gate claimAllows', function () {
    it('allows any caller when the list is empty', function () {
        assert.strictEqual(claimAllows({ sub: 'x' }, 'groups', ''), true);
        assert.strictEqual(claimAllows(null, 'groups', ''), true);
        assert.strictEqual(claimAllows({ sub: 'x' }, 'groups', ' , '), true);
    });

    it('otherwise defers to grants', function () {
        assert.strictEqual(claimAllows({ groups: ['admin'] }, 'groups', 'admin'), true);
        assert.strictEqual(claimAllows({ groups: ['user'] }, 'groups', 'admin'), false);
        assert.strictEqual(claimAllows(null, 'groups', 'admin'), false);
    });
});

describe('lib/claim-gate createToolGate', function () {
    const build = groups => createToolGate({
        claims      : { groups },
        claimName   : 'groups',
        serverValue : 'staff'
    });

    it('reports the whole-server list as serverGranted', function () {
        assert.strictEqual(build(['staff']).serverGranted, true);
        assert.strictEqual(build(['media']).serverGranted, false);
    });

    it('requires both the server list and the tool list', function () {
        // server: staff, tool B: media, admin: admin — the worked example from the plan.
        const staff = build(['staff']);
        assert.strictEqual(staff.allows(''), true);          // tool A, unconstrained
        assert.strictEqual(staff.allows('media'), false);    // tool B
        assert.strictEqual(staff.allows('admin'), false);    // admin tools

        const both = build(['staff', 'media']);
        assert.strictEqual(both.allows(''), true);
        assert.strictEqual(both.allows('media'), true);

        const admin = build(['staff', 'admin']);
        assert.strictEqual(admin.allows(''), true);
        assert.strictEqual(admin.allows('admin'), true);
    });

    it('denies everything when the server list is not cleared, however open the tool', function () {
        const media = build(['media']);
        assert.strictEqual(media.allows(''), false);
        assert.strictEqual(media.allows('media'), false);
        assert.strictEqual(build(['guest']).allows(''), false);
    });

    it('applies only the tool list when the server list is empty', function () {
        const gate = claims => createToolGate({ claims, claimName: 'groups', serverValue: '' });
        assert.strictEqual(gate({ groups: ['media'] }).serverGranted, true);
        assert.strictEqual(gate({ groups: ['media'] }).allows(''), true);
        assert.strictEqual(gate({ groups: ['media'] }).allows('media'), true);
        assert.strictEqual(gate({ groups: ['guest'] }).allows(''), true);
        assert.strictEqual(gate({ groups: ['guest'] }).allows('media'), false);
    });

    it('opens everything when both lists are empty, even without claims', function () {
        const gate = createToolGate({ claims: null, claimName: 'groups', serverValue: '' });
        assert.strictEqual(gate.serverGranted, true);
        assert.strictEqual(gate.allows(''), true);
        assert.strictEqual(gate.allows('media'), false);
    });
});

describe('lib/claim-gate visibleTools', function () {
    const registry = {
        open   : { description: 'open tool',   schema: { type: 'object', properties: { a: { type: 'string' } } }, requiredValue: '' },
        gated  : { description: 'gated tool',  schema: { b: { type: 'number' } },                                 requiredValue: 'media' },
        hidden : { description: 'hidden tool', schema: null,                                                      requiredValue: 'nope' }
    };
    const gate = claims => createToolGate({ claims, claimName: 'groups', serverValue: '' });

    it('lists only the tools the gate permits', function () {
        assert.deepStrictEqual(visibleTools(registry, gate({ groups: ['media'] })).map(t => t.name),
            ['open', 'gated']);
        assert.deepStrictEqual(visibleTools(registry, gate({ groups: ['guest'] })).map(t => t.name),
            ['open']);
    });

    it('passes an object schema through untouched', function () {
        const [open] = visibleTools(registry, gate({ groups: ['guest'] }));
        assert.deepStrictEqual(open.inputSchema, { type: 'object', properties: { a: { type: 'string' } } });
        assert.strictEqual(open.description, 'open tool');
    });

    it('wraps a bare properties map, and a missing schema, into an object schema', function () {
        const tools = visibleTools(registry, gate({ groups: ['media', 'nope'] }));
        const byName = Object.fromEntries(tools.map(t => [t.name, t]));
        assert.deepStrictEqual(byName.gated.inputSchema, { type: 'object', properties: { b: { type: 'number' } } });
        assert.deepStrictEqual(byName.hidden.inputSchema, { type: 'object', properties: {} });
    });

    it('tolerates an empty registry', function () {
        assert.deepStrictEqual(visibleTools({}, gate({ groups: [] })), []);
        assert.deepStrictEqual(visibleTools(undefined, gate({ groups: [] })), []);
    });
});


describe('claim-gate scope axis', function () {
    it('reads a space-delimited scope string, as OAuth defines it', function () {
        assert.deepStrictEqual(tokenScopes({ scope: 'openid  mcp:read ' }), ['openid', 'mcp:read']);
        assert.deepStrictEqual(tokenScopes({ scope: ['a', 'b'] }), ['a', 'b']);
    });

    it('falls back to scp only when scope is absent, as Entra and Okta name it', function () {
        // Deterministic on purpose: the answer never depends on which of two claims looked better.
        assert.deepStrictEqual(tokenScopes({ scp: ['a', 'b'] }), ['a', 'b']);
        assert.deepStrictEqual(tokenScopes({ scope: 'a', scp: 'b' }), ['a']);
        assert.deepStrictEqual(tokenScopes({ scope: 42, scp: 'b' }), []);
    });

    it('is empty for a missing or non-string claim', function () {
        assert.deepStrictEqual(tokenScopes({}), []);
        assert.deepStrictEqual(tokenScopes({ scope: 42 }), []);
    });

    it('imposes nothing when the field is empty, and fails closed when it is not', function () {
        assert.strictEqual(scopeAllows({ scope: 'x' }, ''), true);
        assert.strictEqual(scopeAllows({}, ''), true);
        assert.strictEqual(scopeAllows({}, 'mcp:read'), false);
    });

    it('matches any-of against a comma-separated field', function () {
        assert.strictEqual(scopeAllows({ scope: 'openid mcp:read' }, 'mcp:write, mcp:read'), true);
        assert.strictEqual(scopeAllows({ scope: 'openid' }, 'mcp:write, mcp:read'), false);
    });

    it('does not split a group claim on whitespace', function () {
        // The reason scopes got their own matcher: a group name may contain spaces, and the
        // claim axis must keep comparing it whole.
        assert.strictEqual(grants({ groups: 'Home Admins' }, 'groups', 'Home Admins'), true);
        assert.strictEqual(grants({ groups: 'Home Admins' }, 'groups', 'Home'), false);
    });
});

describe('claim-gate two axes compose with AND', function () {
    const gate = (claims, serverValue, serverScope) =>
        createToolGate({ claims, claimName: 'groups', serverValue, serverScope });

    it('needs both to pass', function () {
        const claims = { groups: ['ops'], scope: 'mcp:read' };
        assert.strictEqual(gate(claims, 'ops', 'mcp:read').serverGranted, true);
        assert.strictEqual(gate(claims, 'ops', 'mcp:write').serverGranted, false);
        assert.strictEqual(gate(claims, 'admin', 'mcp:read').serverGranted, false);
    });

    it('applies both to a per-tool list as well', function () {
        const g = gate({ groups: ['ops'], scope: 'mcp:read' }, 'ops', 'mcp:read');
        assert.strictEqual(g.allows('ops', 'mcp:read'), true);
        assert.strictEqual(g.allows('ops', 'mcp:write'), false);
        assert.strictEqual(g.allows('admin', 'mcp:read'), false);
    });
});

describe('requiredScopeChallenge', function () {
    it('joins the gate fields into the header\'s space-delimited grammar', function () {
        assert.strictEqual(requiredScopeChallenge(['read:ha', 'write:ha']), 'read:ha write:ha');
    });

    it('flattens any-of fields and drops duplicates, keeping configured order', function () {
        assert.strictEqual(requiredScopeChallenge(['a, b', 'b, c']), 'a b c');
    });

    it('is empty when nothing is required, so no scope parameter is sent at all', function () {
        assert.strictEqual(requiredScopeChallenge(['', '']), '');
        assert.strictEqual(requiredScopeChallenge([]), '');
        assert.strictEqual(requiredScopeChallenge(undefined), '');
    });
});

describe('advertisedScopes', function () {
    it('adds the required scopes to the configured ones', function () {
        // RFC 9728: scopes_supported is what a client should request for this resource, and a
        // scope the gate requires is one of those by definition. Deriving it removes the state
        // where a server demands a scope no client is ever told to ask for.
        assert.deepStrictEqual(
            advertisedScopes(['openid', 'profile'], 'read:ha write:ha'),
            ['openid', 'profile', 'read:ha', 'write:ha']);
    });

    it('does not duplicate one that was already configured', function () {
        assert.deepStrictEqual(advertisedScopes(['openid', 'read:ha'], 'read:ha'),
                               ['openid', 'read:ha']);
    });

    it('is unchanged when no scope is required', function () {
        assert.deepStrictEqual(advertisedScopes(['openid'], ''), ['openid']);
        assert.deepStrictEqual(advertisedScopes(['openid'], undefined), ['openid']);
    });

    it('survives an empty or missing configured list', function () {
        assert.deepStrictEqual(advertisedScopes([], 'read:ha'), ['read:ha']);
        assert.deepStrictEqual(advertisedScopes(undefined, 'read:ha'), ['read:ha']);
    });
});

describe('lib/claim-gate gateReadsClaim', function () {
    // Decides whether a token without the claim is worth a warning. Every gate that reads the
    // claim counts, not just the whole-server list: with that list empty, a token without the
    // claim would hide every tool with a list of its own, with nothing in the log.
    const none = { serverValue: '', tools: {} };

    it('is false when no gate has a list', function () {
        assert.strictEqual(gateReadsClaim(none), false);
        assert.strictEqual(gateReadsClaim(Object.assign({}, none, { serverValue: ' , ' })), false);
    });

    it('counts the whole-server list', function () {
        assert.strictEqual(gateReadsClaim(Object.assign({}, none, { serverValue: 'ops' })), true);
    });

    it('counts a registered tool with its own list', function () {
        const tools = { a: { requiredValue: '' }, b: { requiredValue: 'ops' } };
        assert.strictEqual(gateReadsClaim(Object.assign({}, none, { tools })), true);
        assert.strictEqual(gateReadsClaim(Object.assign({}, none, { tools: { a: { requiredValue: '' } } })), false);
        assert.strictEqual(gateReadsClaim(Object.assign({}, none, { tools: undefined })), false);
    });
});

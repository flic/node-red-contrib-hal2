'use strict';
// The read/write gate as the Event handler builds it. buildGate() itself lives inside the
// node constructor and needs a running Node-RED, so the composition is reproduced here from
// the same two primitives it uses — claim-gate and toolClass. What is being pinned is the
// policy: which tool classes clear which value list, and what the empty defaults mean.

const assert = require('node:assert');
const { createToolGate, grants, tokenScopes, scopeAllows,
        requiredScopeChallenge, advertisedScopes } = require('../lib/claim-gate');
const { toolClass, MCP_TOOLS } = require('../core/mcp-tools');

// Mirrors buildGate() in core/eventhandler.js.
function buildGate(claims, { claimName = 'groups', readValue = '', writeValue = '',
                            readScope = '', writeScope = '' } = {}) {
    const gate = createToolGate({ claims, claimName, serverValue: readValue,
                                  serverScope: readScope });
    return {
        allows(toolName) {
            if (!gate.serverGranted) { return false; }
            return toolClass(toolName) === 'write'
                ? gate.allows(writeValue, writeScope) : true;
        },
        allowsValue: list => gate.allows(list)
    };
}

const READER  = { groups: ['family'] };
const WRITER  = { groups: ['family', 'ops'] };
const OUTSIDE = { groups: ['guest'] };

describe('read/write tool gate', function () {
    const opts = { readValue: 'family', writeValue: 'ops' };

    it('lets a read-only token read but not write', function () {
        const g = buildGate(READER, opts);
        assert.strictEqual(g.allows('get_state'), true);
        assert.strictEqual(g.allows('get_all_states'), true);
        assert.strictEqual(g.allows('set_light'), false);
        assert.strictEqual(g.allows('activate_scene'), false);
    });

    it('lets a token holding both lists do everything', function () {
        const g = buildGate(WRITER, opts);
        assert.strictEqual(g.allows('get_state'), true);
        assert.strictEqual(g.allows('set_light'), true);
    });

    it('refuses everything to a token that clears neither', function () {
        const g = buildGate(OUTSIDE, opts);
        assert.strictEqual(g.allows('get_state'), false);
        assert.strictEqual(g.allows('set_light'), false);
    });

    it('closes the write gate against the control_light alias', function () {
        // The alias the dispatcher accepts but the catalog does not list. If the gate let it
        // through, a read-only token could switch lights by asking for it by the other name.
        const g = buildGate(READER, opts);
        assert.strictEqual(g.allows('control_light'), false);
        assert.strictEqual(buildGate(WRITER, opts).allows('control_light'), true);
    });

    it('treats an unknown tool as a write', function () {
        assert.strictEqual(buildGate(READER, opts).allows('some_future_tool'), false);
        assert.strictEqual(buildGate(WRITER, opts).allows('some_future_tool'), true);
    });

    it('keeps read tools that live in the control dispatcher on the read side', function () {
        // get_scenes and get_alerts are handled by dispatchControlTools but only observe.
        const g = buildGate(READER, opts);
        assert.strictEqual(g.allows('get_scenes'), true);
        assert.strictEqual(g.allows('get_alerts'), true);
    });

    it('empty defaults leave every catalog tool reachable', function () {
        // The upgrade path: an existing install has neither field set and must behave
        // exactly as it did before the gates existed.
        const g = buildGate(READER);
        for (const t of MCP_TOOLS) {
            assert.strictEqual(g.allows(t.name), true, t.name + ' should be reachable');
        }
        // …and so should a caller with no claims at all.
        assert.strictEqual(buildGate(null).allows('set_light'), true);
    });

    it('a write list alone still gates writes while reads stay open', function () {
        const g = buildGate(READER, { writeValue: 'ops' });
        assert.strictEqual(g.allows('get_state'), true);
        assert.strictEqual(g.allows('set_light'), false);
        assert.strictEqual(buildGate(WRITER, { writeValue: 'ops' }).allows('set_light'), true);
    });

    it('accepts comma-separated any-of lists', function () {
        const g = buildGate({ groups: ['ops'] }, { readValue: 'family,ops', writeValue: 'ops,admin' });
        assert.strictEqual(g.allows('get_state'), true);
        assert.strictEqual(g.allows('set_light'), true);
        // A single configured value keeps behaving as it did before lists existed.
        assert.strictEqual(buildGate({ groups: ['ops'] }, { readValue: 'ops' }).allows('get_state'), true);
        assert.strictEqual(buildGate({ groups: ['x'] }, { readValue: 'ops' }).allows('get_state'), false);
    });

    it('gates dynamic tools on their own value, on top of the read list', function () {
        const g = buildGate(READER, opts);
        assert.strictEqual(g.allowsValue(''), true);          // no constraint of its own
        assert.strictEqual(g.allowsValue('family'), true);
        assert.strictEqual(g.allowsValue('ops'), false);      // reader lacks it
        assert.strictEqual(buildGate(WRITER, opts).allowsValue('ops'), true);
        // The server list still applies even when the tool asks for nothing.
        assert.strictEqual(buildGate(OUTSIDE, opts).allowsValue(''), false);
    });
});


describe('client scope gate', function () {
    // The user axis is satisfied throughout, so every result below is the scope axis speaking.
    const opts = { readValue: 'family', writeValue: 'ops',
                   readScope: 'mcp:read', writeScope: 'mcp:write' };
    const withScope = scope => Object.assign({ groups: ['family', 'ops'] }, { scope });

    it('bounds a privileged user by a read-only client', function () {
        // The whole point: this user may write, and still cannot, because the client holding
        // the token was never granted the scope to. Delegation, not impersonation.
        const g = buildGate(withScope('openid mcp:read'), opts);
        assert.strictEqual(g.allows('get_state'), true);
        assert.strictEqual(g.allows('set_light'), false);
    });

    it('lets a client holding both scopes do what its user may', function () {
        const g = buildGate(withScope('openid mcp:read mcp:write'), opts);
        assert.strictEqual(g.allows('get_state'), true);
        assert.strictEqual(g.allows('set_light'), true);
    });

    it('refuses everything to a client with neither scope', function () {
        const g = buildGate(withScope('openid profile'), opts);
        assert.strictEqual(g.allows('get_state'), false);
        assert.strictEqual(g.allows('set_light'), false);
    });

    it('refuses a token carrying no scope claim at all once a scope is required', function () {
        // Fail closed: a missing claim is not an empty constraint.
        const g = buildGate({ groups: ['family', 'ops'] }, opts);
        assert.strictEqual(g.allows('get_state'), false);
    });

    it('reads a scope claim sent as an array', function () {
        const g = buildGate({ groups: ['family', 'ops'], scope: ['mcp:read', 'mcp:write'] }, opts);
        assert.strictEqual(g.allows('set_light'), true);
    });

    it('falls back to scp, as Entra and Okta name it', function () {
        const g = buildGate({ groups: ['family', 'ops'], scp: 'mcp:read mcp:write' }, opts);
        assert.strictEqual(g.allows('set_light'), true);
    });

    it('is no constraint when the scope fields are empty', function () {
        // What every install that never fills these in must keep doing.
        const g = buildGate({ groups: ['family', 'ops'], scope: 'openid' },
                            { readValue: 'family', writeValue: 'ops' });
        assert.strictEqual(g.allows('get_state'), true);
        assert.strictEqual(g.allows('set_light'), true);
    });

    it('still denies a user who fails the claim axis, whatever the client holds', function () {
        // AND, not OR: a fully scoped client cannot lift a user over the group gate.
        const g = buildGate({ groups: ['guest'], scope: 'mcp:read mcp:write' }, opts);
        assert.strictEqual(g.allows('get_state'), false);
    });
});


describe('scope matching', function () {
    it('reads a space-delimited scope string, as OAuth defines it', function () {
        assert.deepStrictEqual(tokenScopes({ scope: 'openid  mcp:read ' }), ['openid', 'mcp:read']);
        assert.deepStrictEqual(tokenScopes({ scope: 42 }), []);
    });

    it('reads scp only when scope is absent, so the answer never depends on which looked better',
       function () {
        assert.deepStrictEqual(tokenScopes({ scp: ['a', 'b'] }), ['a', 'b']);
        assert.deepStrictEqual(tokenScopes({ scope: 'a', scp: 'b' }), ['a']);
        assert.deepStrictEqual(tokenScopes({ scope: 42, scp: 'b' }), []);
    });

    it('matches any-of against a comma-separated field', function () {
        assert.strictEqual(scopeAllows({ scope: 'openid mcp:read' }, 'mcp:write, mcp:read'), true);
        assert.strictEqual(scopeAllows({ scope: 'openid' }, 'mcp:write, mcp:read'), false);
    });

    it('does not split a group claim on whitespace', function () {
        // The reason scopes got their own matcher rather than a change to grants(): a group
        // name may contain spaces, and the claim axis must keep comparing it whole.
        assert.strictEqual(grants({ groups: 'Home Admins' }, 'groups', 'Home Admins'), true);
        assert.strictEqual(grants({ groups: 'Home Admins' }, 'groups', 'Home'), false);
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

'use strict';

const assert = require('node:assert');
const { readClaim, grants, claimAllows, createToolGate, visibleTools } = require('../lib/claim-gate');

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

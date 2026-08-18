'use strict';

const assert = require('node:assert');
const { createMcpAuth, secretEqual, acceptsAudience, cimdClientId,
        describeIntrospection } = require('../core/mcp-auth');

const DISCOVERY = {
    status: 200,
    body: {
        issuer: 'https://idp.example.com',
        jwks_uri: 'https://idp.example.com/jwks',
        userinfo_endpoint: 'https://idp.example.com/userinfo'
    }
};

const cimdHttpGet = async (url) => {
    if (url.includes('openid-configuration')) {
        return { status: 200,
                 body: Object.assign({ client_id_metadata_document_supported: true },
                                     DISCOVERY.body) };
    }
    if (url.includes('userinfo')) return { status: 200, body: { groups: ['admin'] } };
    return { status: 404, body: {} };
};

function build(overrides = {}, payload = {}) {
    const state = { verifyOpts: null, verifyCalls: 0, logs: [] };
    const httpGet = async (url) => {
        if (url.includes('openid-configuration')) return DISCOVERY;
        if (url.includes('userinfo')) return { status: 200, body: { email: 'u@example.com', groups: ['admin'] } };
        return { status: 404, body: {} };
    };
    const auth = createMcpAuth(Object.assign({
        issuerUrl: 'https://idp.example.com',
        tokenTTL: 300000,
        httpGet,
        log: msg => state.logs.push(msg),
        createRemoteJWKSet: () => ({}),
        jwtVerify: async (token, jwks, opts) => {
            state.verifyOpts = opts;
            state.verifyCalls += 1;
            if (token === 'bad') throw new Error('invalid signature');
            return { payload: Object.assign(
                { sub: 'abc', exp: Math.floor(Date.now() / 1000) + 3600 }, payload) };
        }
    }, overrides));
    return { auth, state };
}

describe('core/mcp-auth secretEqual', function () {
    it('is true for equal strings and false for different ones', function () {
        assert.strictEqual(secretEqual('hunter2', 'hunter2'), true);
        assert.strictEqual(secretEqual('hunter2', 'hunter3'), false);
    });
    it('handles different lengths without throwing', function () {
        assert.doesNotThrow(() => secretEqual('short', 'a-much-longer-secret'));
        assert.strictEqual(secretEqual('short', 'a-much-longer-secret'), false);
    });
});

describe('core/mcp-auth acceptsAudience', function () {
    const CIMD = 'https://claude.ai/api/mcp/client-metadata.json';
    const opts = o => Object.assign({ expected: 'pre-registered-id' }, o);

    it('still requires the resource when only the audience is unset', function () {
        // The Client ID field is otherwise vestigial, so clearing it looks harmless — and used
        // to switch the whole check off. A token for another app at the same provider must not
        // become acceptable just because this server no longer names a client.
        const R = 'https://mcp.example.com/mcp';
        assert.strictEqual(acceptsAudience({ aud: 'https://other.example.com' },
                                           { expected: '', resourceUrl: R }), false);
        assert.strictEqual(acceptsAudience({ aud: R }, { expected: '', resourceUrl: R }), true);
    });

    it('accepts anything only when neither audience nor resource is known', function () {
        // What this server did before an audience check existed, and still does for an
        // install that never filled the field in.
        assert.strictEqual(acceptsAudience({ aud: 'whatever' }, { expected: '', resourceUrl: '' }), true);
        assert.strictEqual(acceptsAudience({}, {}), true);
    });

    it('accepts the configured audience and rejects another', function () {
        // The DCR path, unchanged: this is the isolation that stops a token issued to some
        // other application on the same IdP from being usable here.
        assert.strictEqual(acceptsAudience({ aud: 'pre-registered-id' }, opts()), true);
        assert.strictEqual(acceptsAudience({ aud: 'another-app' }, opts()), false);
    });

    it('accepts an aud array containing the configured audience', function () {
        assert.strictEqual(acceptsAudience({ aud: ['x', 'pre-registered-id'] }, opts()), true);
        assert.strictEqual(acceptsAudience({ aud: ['x', 'y'] }, opts()), false);
    });

    it('accepts a CIMD client id only when the IdP advertises CIMD', function () {
        assert.strictEqual(acceptsAudience({ aud: CIMD }, opts({ allowCimd: false })), false);
        assert.strictEqual(acceptsAudience({ aud: CIMD }, opts({ allowCimd: true })), true);
    });

    it('reads azp as well as aud', function () {
        // Which of the two carries a CIMD client id is provider-specific and unpinned by any
        // spec, so both are consulted.
        assert.strictEqual(acceptsAudience({ aud: 'other', azp: CIMD }, opts({ allowCimd: true })), true);
        assert.strictEqual(acceptsAudience({ aud: 'other', azp: 'pre-registered-id' }, opts()), true);
    });

    it('rejects values that only look like a CIMD client id', function () {
        const bad = [
            'http://claude.ai/client.json',          // not https
            'https://claude.ai',                     // no path component
            'https://claude.ai/',                    // ditto
            'https://claude.ai/c.json#x',            // fragment
            'https://user:pw@claude.ai/c.json',      // userinfo
            'not a url', 42, null
        ];
        for (const v of bad) {
            assert.strictEqual(acceptsAudience({ aud: v }, opts({ allowCimd: true })), false,
                               String(v));
        }
    });

    it('accepts the resource identifier itself', function () {
        // RFC 8707: clients MUST send resource=<canonical MCP URI>. If the IdP ever honours
        // it the audience becomes the resource, and this is what keeps working then.
        const o = opts({ resourceUrl: 'https://mcp.example.com/mcp' });
        assert.strictEqual(acceptsAudience({ aud: 'https://mcp.example.com/mcp' }, o), true);
        assert.strictEqual(acceptsAudience({ aud: 'https://mcp.example.com/other' }, o), false);
    });
});

describe('core/mcp-auth cimdClientId', function () {
    const CIMD = 'https://claude.ai/oauth/claude-code-client-metadata';

    it('finds the client id in aud or in azp', function () {
        assert.strictEqual(cimdClientId({ aud: CIMD }), CIMD);
        assert.strictEqual(cimdClientId({ aud: ['other', CIMD] }), CIMD);
        assert.strictEqual(cimdClientId({ aud: 'other', azp: CIMD }), CIMD);
    });

    it('is empty for a token that is not from a CIMD client', function () {
        assert.strictEqual(cimdClientId({ aud: 'pre-registered-id' }), '');
        assert.strictEqual(cimdClientId({}), '');
        assert.strictEqual(cimdClientId(null), '');
    });

    it('does not mistake the resource identifier for a client', function () {
        // An IdP that honours RFC 8707 binds the token to the resource, so `aud` is the MCP
        // endpoint URL — CIMD-shaped, and first in the list. Reporting that as the client is
        // what the first real token actually did.
        const R = 'https://mcp.example.com/mcp';
        assert.strictEqual(cimdClientId({ aud: R }, { resourceUrl: R }), '');
        assert.strictEqual(cimdClientId({ aud: [R], azp: CIMD }, { resourceUrl: R }), CIMD);
    });

    it('does not mistake a URL-shaped configured audience for a client', function () {
        const A = 'https://mcp.example.com/mcp';
        assert.strictEqual(cimdClientId({ aud: A }, { expected: A }), '');
    });
});

describe('core/mcp-auth CIMD client logging', function () {
    const CIMD = 'https://claude.ai/oauth/claude-code-client-metadata';
    const cimdLines = state => state.logs.filter(l => l.startsWith('MCP CIMD client authenticated'));

    it('announces a CIMD client once, not once per token', async function () {
        // The counterpart to the DCR fallback line. Two distinct tokens so the token cache is
        // not what makes this pass — the point is one line per client, not per credential.
        const { auth, state } = build({ httpGet: cimdHttpGet, tokenAudience: 'pre-registered-id',
                                        resourceUrl: 'https://mcp.example.com/mcp' },
                                      { aud: ['https://mcp.example.com/mcp'], azp: CIMD });
        await auth.validateToken('token-one');
        await auth.validateToken('token-two');
        assert.deepStrictEqual(cimdLines(state), ['MCP CIMD client authenticated: ' + CIMD]);
    });

    it('says nothing for a client using the pre-registered id', async function () {
        // That client announces itself at /oauth/register instead; logging it here too would
        // double-count it.
        const { auth, state } = build({ httpGet: cimdHttpGet, tokenAudience: 'pre-registered-id' },
                                      { aud: 'pre-registered-id' });
        await auth.validateToken('good');
        assert.deepStrictEqual(cimdLines(state), []);
    });

    it('says nothing when the IdP does not advertise CIMD', async function () {
        // Such a token would have been rejected anyway; the log must not imply it got in.
        const { auth, state } = build({ tokenAudience: 'pre-registered-id' }, { aud: CIMD });
        assert.strictEqual(await auth.validateToken('good'), null);
        assert.deepStrictEqual(cimdLines(state), []);
    });
});

describe('core/mcp-auth validateToken', function () {
    it('rejects a token that fails signature verification', async function () {
        const { auth } = build();
        assert.strictEqual(await auth.validateToken('bad'), null);
    });

    it('returns merged JWT + userinfo claims for a valid token', async function () {
        const { auth } = build();
        const claims = await auth.validateToken('good');
        assert.strictEqual(claims.sub, 'abc');           // from JWT payload
        assert.deepStrictEqual(claims.groups, ['admin']); // from userinfo
    });

    it('pins the discovered issuer on jwtVerify', async function () {
        const { auth, state } = build();
        await auth.validateToken('good');
        assert.strictEqual(state.verifyOpts.issuer, 'https://idp.example.com');
        assert.strictEqual(state.verifyOpts.audience, undefined); // not set when unconfigured
    });

    // Audience is no longer jose's job — it is checked after verification so a CIMD client id
    // can be accepted too (see acceptsAudience). These two pin that the move did not weaken it.
    it('accepts a token whose audience matches the configured one', async function () {
        const { auth } = build({ tokenAudience: 'my-mcp-resource' }, { aud: 'my-mcp-resource' });
        assert.ok(await auth.validateToken('good'));
    });

    it('rejects a signature-valid token issued for someone else', async function () {
        const { auth } = build({ tokenAudience: 'my-mcp-resource' }, { aud: 'another-app' });
        assert.strictEqual(await auth.validateToken('good'), null);
    });

    it('leaves the audience to acceptsAudience rather than jose', async function () {
        const { auth, state } = build({ tokenAudience: 'my-mcp-resource' },
                                      { aud: 'my-mcp-resource' });
        await auth.validateToken('good');
        assert.strictEqual(state.verifyOpts.audience, undefined);
        assert.strictEqual(state.verifyOpts.issuer, 'https://idp.example.com');
    });

    it('caches the result so a repeat call does not re-verify', async function () {
        const { auth, state } = build();
        await auth.validateToken('good');
        await auth.validateToken('good');
        assert.strictEqual(state.verifyCalls, 1);
        assert.strictEqual(auth.cacheSize(), 1);
    });

    it('isolates callers from the cache — mutating returned claims cannot poison later requests', async function () {
        const { auth } = build();
        const first = await auth.validateToken('good');
        // A flow receiving msg.jwtClaims does exactly this kind of damage, deliberately or not.
        first.groups.push('root');
        first.sub = 'evil';
        const second = await auth.validateToken('good');
        assert.deepStrictEqual(second.groups, ['admin']);
        assert.strictEqual(second.sub, 'abc');
    });

    it('bypasses the IdP for the local debug token', async function () {
        const { auth, state } = build({ localDebugToken: 'dbg-secret' });
        const claims = await auth.validateToken('dbg-secret');
        assert.deepStrictEqual(claims.groups, ['admin']);
        assert.strictEqual(state.verifyCalls, 0); // never touched jose
    });

    it('clearCache empties the cache', async function () {
        const { auth } = build();
        await auth.validateToken('good');
        assert.strictEqual(auth.cacheSize(), 1);
        auth.clearCache();
        assert.strictEqual(auth.cacheSize(), 0);
    });
});

describe('core/mcp-auth OIDC discovery retry', function () {
    function buildFlaky(discoveryRetryMs) {
        const state = { discoveryCalls: 0, fail: true };
        const httpGet = async (url) => {
            if (url.includes('openid-configuration')) {
                state.discoveryCalls += 1;
                if (state.fail) throw new Error('ECONNREFUSED');
                return DISCOVERY;
            }
            return { status: 404, body: {} };
        };
        const auth = createMcpAuth({
            issuerUrl: 'https://idp.example.com',
            httpGet,
            discoveryRetryMs,
            createRemoteJWKSet: () => ({}),
            jwtVerify: async () => ({ payload: { sub: 'abc' } })
        });
        return { auth, state };
    }

    it('does not cache a failed discovery — retries once the window has passed', async function () {
        const { auth, state } = buildFlaky(0);
        const first = await auth.getOidcConfig();
        assert.strictEqual(first.jwks_uri, 'https://idp.example.com/.well-known/jwks.json'); // fallback paths
        state.fail = false;
        const second = await auth.getOidcConfig();
        assert.strictEqual(second.jwks_uri, 'https://idp.example.com/jwks'); // discovered
        assert.strictEqual(state.discoveryCalls, 2);
    });

    it('serves the fallback without re-probing inside the retry window', async function () {
        const { auth, state } = buildFlaky(60000);
        await auth.getOidcConfig();
        const cfg = await auth.getOidcConfig();
        assert.strictEqual(state.discoveryCalls, 1); // no second probe
        assert.strictEqual(cfg.jwks_uri, 'https://idp.example.com/.well-known/jwks.json');
    });

    it('caches a successful discovery permanently', async function () {
        const { auth, state } = buildFlaky(0);
        state.fail = false;
        await auth.getOidcConfig();
        await auth.getOidcConfig();
        assert.strictEqual(state.discoveryCalls, 1);
    });
});

describe('core/mcp-auth userinfo failure reporting', function () {
    // An anonymous recurring warning cannot be acted on: one client always refused looks the
    // same as every client refused sometimes, and those need opposite responses.
    it('names the client and subject a refusal belongs to', async function () {
        const state = { warns: [] };
        const auth = createMcpAuth({
            issuerUrl: 'https://idp.example.com', tokenTTL: 300000,
            httpGet: async (url) => url.includes('openid-configuration') ? DISCOVERY
                                 : { status: 401, body: {} },
            createRemoteJWKSet: () => ({}), warn: m => state.warns.push(m),
            jwtVerify: async () => ({ payload: {
                sub: 'user-1', azp: 'client-a', exp: Math.floor(Date.now() / 1000) + 3600 } })
        });
        await auth.validateToken('t');
        assert.ok(state.warns[0].includes('client=client-a'), state.warns[0]);
        assert.ok(state.warns[0].includes('sub=user-1'), state.warns[0]);
    });

    it('falls back to client_id, and to ? when the token names neither', async function () {
        for (const [payload, expected] of [
            [{ client_id: 'client-b' }, 'client=client-b'],
            [{}, 'client=?']
        ]) {
            const state = { warns: [] };
            const auth = createMcpAuth({
                issuerUrl: 'https://idp.example.com', tokenTTL: 300000,
                httpGet: async (url) => url.includes('openid-configuration') ? DISCOVERY
                                     : { status: 401, body: {} },
                createRemoteJWKSet: () => ({}), warn: m => state.warns.push(m),
                jwtVerify: async () => ({ payload: Object.assign(
                    { exp: Math.floor(Date.now() / 1000) + 3600 }, payload) })
            });
            await auth.validateToken('t' + expected);
            assert.ok(state.warns[0].includes(expected), state.warns[0]);
        }
    });
});

describe('core/mcp-auth describeIntrospection', function () {
    const token = { sub: 'u', aud: ['r'], scope: 'openid groups', exp: 1 };

    it('reports the identity claims introspection carries and the token does not', function () {
        // The whole question: RFC 7662 is only worth building on if it fills the gap the
        // access token leaves.
        const line = describeIntrospection(token,
            { active: true, sub: 'u', scope: 'openid groups', client_id: 'c',
              groups: ['ops'], email: 'u@example.com' });
        assert.ok(line.includes('usable as an identity source'), line);
        assert.ok(line.includes('groups'), line);
    });

    it('says so plainly when it returns only RFC 7662 fields', function () {
        const line = describeIntrospection(token,
            { active: true, sub: 'u', scope: 'openid groups', client_id: 'c', iss: 'p' });
        assert.ok(line.includes('NOT usable as an identity source'), line);
    });

    it('does not count a claim the token already carries', function () {
        // `scope` is in both; reporting it as something introspection adds would overstate it.
        const line = describeIntrospection({ groups: ['ops'], scope: 'x' },
                                           { active: true, groups: ['ops'], scope: 'x' });
        // `active` is genuinely new; groups and scope are not, and counting them would overstate
        // what introspection is worth — the token already had them.
        assert.strictEqual(line.indexOf('groups'), -1, line);
        assert.strictEqual(line.indexOf('scope'), -1, line);
        assert.ok(line.includes('NOT usable as an identity source'), line);
    });

    it('reports an inactive token rather than comparing it', function () {
        assert.ok(describeIntrospection(token, { active: false }).includes('inactive'));
        assert.ok(describeIntrospection(token, {}).includes('inactive'));
    });
});

describe('core/mcp-auth introspection probe', function () {
    function build(overrides) {
        const state = { posts: [], logs: [], warns: [] };
        const auth = createMcpAuth(Object.assign({
            issuerUrl: 'https://idp.example.com', tokenTTL: 300000,
            httpGet: async (url) => url.includes('openid-configuration')
                ? { status: 200, body: Object.assign({ introspection_endpoint: 'https://idp.example.com/introspect' }, DISCOVERY.body) }
                : { status: 200, body: {} },
            httpPost: async (url, headers, form) => {
                state.posts.push({ url, headers, form });
                return { status: 200, body: { active: true, groups: ['ops'] } };
            },
            createRemoteJWKSet: () => ({}),
            log: m => state.logs.push(m), warn: m => state.warns.push(m),
            jwtVerify: async (tok) => ({ payload: { sub: 'abc', azp: 'client-' + String(tok).slice(-1),
                                                    exp: Math.floor(Date.now() / 1000) + 3600 } })
        }, overrides));
        return { auth, state };
    }
    const settle = () => new Promise(r => setImmediate(r));

    it('probes once, with the token and basic auth, and reports the answer', async function () {
        const { auth, state } = build({ clientId: 'cid', clientSecret: 'sec' });
        await auth.validateToken('t1');
        await settle();
        assert.strictEqual(state.posts.length, 1);
        assert.strictEqual(state.posts[0].form.token, 't1');
        assert.strictEqual(state.posts[0].headers.Authorization,
                           'Basic ' + Buffer.from('cid:sec').toString('base64'));
        assert.ok(state.logs.some(l => l.includes('introspection probe for client=client-1: adds')),
                  state.logs.join('|'));
    });

    it('probes once per client, not once per token', async function () {
        // A diagnostic must not become a per-request round-trip on the auth path — but one
        // sample for the whole node cannot distinguish a dead token from one this caller may
        // not ask about, and that difference is the point of the probe.
        const { auth, state } = build({ clientId: 'cid', clientSecret: 'sec' });
        await auth.validateToken('a1'); await settle();
        await auth.validateToken('b1'); await settle();   // same azp as a1
        await auth.validateToken('c2'); await settle();   // different azp
        assert.strictEqual(state.posts.length, 2);
    });

    it('logs the whole response when active is false, since that answer is ambiguous', async function () {
        const { auth, state } = build({
            clientId: 'cid', clientSecret: 'sec',
            httpPost: async () => ({ status: 200, body: { active: false } })
        });
        await auth.validateToken('t1');
        await settle();
        const line = state.logs.find(l => l.includes('introspection probe'));
        assert.ok(line.includes('raw='), line);
        assert.ok(line.includes('client=client-1'), line);
    });

    it('does nothing without a secret', async function () {
        const { auth, state } = build({ clientId: 'cid' });
        await auth.validateToken('t1');
        await settle();
        assert.strictEqual(state.posts.length, 0);
    });

    it('never fails an authentication that already succeeded', async function () {
        const { auth, state } = build({
            clientId: 'cid', clientSecret: 'sec',
            httpPost: async () => { throw new Error('connection refused'); }
        });
        const claims = await auth.validateToken('t1');
        await settle();
        assert.strictEqual(claims.sub, 'abc');
        assert.ok(state.warns.some(w => w.includes('introspection probe failed')), state.warns.join('|'));
    });
});

describe('core/mcp-auth WWW-Authenticate scope challenge', function () {
    // MCP clients treat a challenged scope as authoritative, ahead of the scopes_supported
    // they would otherwise fall back to. Without this a scope the gate requires but the
    // server never advertises hides every tool, with nothing logged anywhere.
    const chal = async (opts) => {
        const { auth } = build(opts);
        let header = null;
        const res = { set: (k, v) => { if (k === 'WWW-Authenticate') { header = v; } },
                      status: () => res, json: () => res };
        await auth.requireBearer({ headers: {} }, res);
        return header;
    };

    it('names the whole advertised set, not just what the gate requires', async function () {
        // A client treats this as authoritative and requests it instead of scopes_supported,
        // so anything left out here is a scope it will never ask for — including openid.
        const h = await chal({ advertisedScopes: 'openid groups read:ha write:ha' });
        assert.ok(h.includes('scope="openid groups read:ha write:ha"'), h);
        assert.ok(h.includes('resource_metadata='), h);
    });

    it('omits the parameter entirely when nothing is required', async function () {
        const h = await chal({});
        assert.strictEqual(h.indexOf('scope='), -1, h);
    });

    it('carries both the error and the scope on an invalid token', async function () {
        const { auth } = build({ advertisedScopes: 'openid read:ha' });
        let header = null;
        const res = { set: (k, v) => { if (k === 'WWW-Authenticate') { header = v; } },
                      status: () => res, json: () => res };
        await auth.requireBearer({ headers: { authorization: 'Bearer bad' } }, res);
        assert.ok(header.includes('error="invalid_token"'), header);
        assert.ok(header.includes('scope="openid read:ha"'), header);
    });
});

describe('core/mcp-auth requireBearer', function () {
    function mockRes() {
        return {
            statusCode: null, body: null, headers: {},
            set(k, v) { this.headers[k] = v; return this; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; return this; }
        };
    }

    it('401s when the Authorization header is missing', async function () {
        const { auth } = build();
        const res = mockRes();
        const claims = await auth.requireBearer({ headers: {} }, res);
        assert.strictEqual(claims, null);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.body.error, 'unauthorized');
    });

    it('401s with invalid_token when the token is bad', async function () {
        const { auth } = build();
        const res = mockRes();
        const claims = await auth.requireBearer({ headers: { authorization: 'Bearer bad' } }, res);
        assert.strictEqual(claims, null);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.body.error, 'invalid_token');
    });

    it('returns claims for a valid Bearer token', async function () {
        const { auth } = build();
        const res = mockRes();
        const claims = await auth.requireBearer({ headers: { authorization: 'Bearer good' } }, res);
        assert.ok(claims);
        assert.strictEqual(claims.sub, 'abc');
        assert.strictEqual(res.statusCode, null); // no error response written
    });

    it('matches the Bearer scheme case-insensitively (RFC 7235)', async function () {
        const { auth } = build();
        const claims = await auth.requireBearer({ headers: { authorization: 'bearer good' } }, mockRes());
        assert.ok(claims);
        assert.strictEqual(claims.sub, 'abc');
    });
});

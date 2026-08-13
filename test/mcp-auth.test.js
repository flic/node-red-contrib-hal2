'use strict';

const assert = require('node:assert');
const { createMcpAuth, secretEqual, acceptsAudience, cimdClientId } = require('../core/mcp-auth');

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

    it('accepts anything when no audience is configured', function () {
        // What this server did before an audience check existed, and still does for an
        // install that never filled the field in.
        assert.strictEqual(acceptsAudience({ aud: 'whatever' }, { expected: '' }), true);
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
});

describe('core/mcp-auth CIMD client logging', function () {
    const CIMD = 'https://claude.ai/oauth/claude-code-client-metadata';
    const cimdLines = state => state.logs.filter(l => l.startsWith('MCP CIMD client authenticated'));

    it('announces a CIMD client once, not once per token', async function () {
        // The counterpart to the DCR fallback line. Two distinct tokens so the token cache is
        // not what makes this pass — the point is one line per client, not per credential.
        const { auth, state } = build({ httpGet: cimdHttpGet, tokenAudience: 'pre-registered-id' },
                                      { aud: CIMD });
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

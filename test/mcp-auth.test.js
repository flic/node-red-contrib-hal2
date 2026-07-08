'use strict';

const assert = require('node:assert');
const { createMcpAuth, secretEqual } = require('../core/mcp-auth');

const DISCOVERY = {
    status: 200,
    body: {
        issuer: 'https://idp.example.com',
        jwks_uri: 'https://idp.example.com/jwks',
        userinfo_endpoint: 'https://idp.example.com/userinfo'
    }
};

function build(overrides = {}) {
    const state = { verifyOpts: null, verifyCalls: 0 };
    const httpGet = async (url) => {
        if (url.includes('openid-configuration')) return DISCOVERY;
        if (url.includes('userinfo')) return { status: 200, body: { email: 'u@example.com', groups: ['admin'] } };
        return { status: 404, body: {} };
    };
    const auth = createMcpAuth(Object.assign({
        issuerUrl: 'https://idp.example.com',
        tokenTTL: 300000,
        httpGet,
        createRemoteJWKSet: () => ({}),
        jwtVerify: async (token, jwks, opts) => {
            state.verifyOpts = opts;
            state.verifyCalls += 1;
            if (token === 'bad') throw new Error('invalid signature');
            return { payload: { sub: 'abc', exp: Math.floor(Date.now() / 1000) + 3600 } };
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

    it('enforces audience only when configured', async function () {
        const { auth, state } = build({ tokenAudience: 'my-mcp-resource' });
        await auth.validateToken('good');
        assert.strictEqual(state.verifyOpts.audience, 'my-mcp-resource');
    });

    it('caches the result so a repeat call does not re-verify', async function () {
        const { auth, state } = build();
        await auth.validateToken('good');
        await auth.validateToken('good');
        assert.strictEqual(state.verifyCalls, 1);
        assert.strictEqual(auth.cacheSize(), 1);
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
});

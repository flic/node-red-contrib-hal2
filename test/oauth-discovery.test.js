'use strict';
// Deliberately the same tests, in the same order and under the same names, as
// node-red-contrib-mcp-server's test/oauth-discovery.test.js. The two packages duplicate this
// logic on purpose — matching test names are what make a future divergence between them visible.
//
// Most of what is pinned here is shape rather than arithmetic, and that is the point: the two
// cases that read like tautologies ("only ever advertises public-client token auth", "never a
// client_secret") are the security decisions 2.17.7 was a breaking change to establish, and the
// resolveRedirectUris cases pin that this shim echoes what a client asked for rather than
// keeping an allowlist of its own.

const assert = require('node:assert');
const {
    buildProtectedResourceMetadata,
    buildAuthorizationServerMetadata,
    resolveRedirectUris,
    buildDcrRegistration
} = require('../lib/oauth-discovery');

describe('lib/oauth-discovery buildProtectedResourceMetadata', function () {
    it('produces the RFC 9728 shape', function () {
        const meta = buildProtectedResourceMetadata({
            resourceUrl: 'https://nodered.example.com/mcp/docker',
            authServerUrl: 'https://nodered.example.com/mcp/docker',
            scopes: ['openid', 'profile']
        });
        assert.deepStrictEqual(meta, {
            resource: 'https://nodered.example.com/mcp/docker',
            authorization_servers: ['https://nodered.example.com/mcp/docker'],
            bearer_methods_supported: ['header'],
            scopes_supported: ['openid', 'profile']
        });
    });
});

describe('lib/oauth-discovery buildAuthorizationServerMetadata', function () {
    it('produces the RFC 8414 shape and proxies OIDC endpoints under its own issuer', function () {
        const meta = buildAuthorizationServerMetadata({
            issuerBase: 'https://nodered.example.com/mcp/docker',
            oidc: {
                authorization_endpoint: 'https://idp.example.com/authorize',
                token_endpoint: 'https://idp.example.com/token',
                userinfo_endpoint: 'https://idp.example.com/userinfo',
                jwks_uri: 'https://idp.example.com/jwks'
            },
            registrationEndpoint: 'https://nodered.example.com/mcp/docker/oauth/register',
            scopes: ['openid']
        });
        assert.strictEqual(meta.issuer, 'https://nodered.example.com/mcp/docker');
        assert.strictEqual(meta.authorization_endpoint, 'https://idp.example.com/authorize');
        assert.strictEqual(meta.registration_endpoint, 'https://nodered.example.com/mcp/docker/oauth/register');
    });

    it('only ever advertises public-client token auth', function () {
        const meta = buildAuthorizationServerMetadata({
            issuerBase: 'https://x', oidc: {}, registrationEndpoint: 'https://x/oauth/register',
            scopes: []
        });
        assert.deepStrictEqual(meta.token_endpoint_auth_methods_supported, ['none']);
    });
});

describe('lib/oauth-discovery resolveRedirectUris', function () {
    const defaults = ['https://claude.ai/api/mcp/auth_callback'];

    it('echoes the requested URIs', function () {
        const uris = resolveRedirectUris(['https://other.example.com/cb'], defaults);
        assert.deepStrictEqual(uris, ['https://other.example.com/cb']);
    });

    it('falls back to the defaults when no URIs were requested', function () {
        assert.deepStrictEqual(resolveRedirectUris([], defaults), defaults);
    });

    it('falls back to the defaults when redirect_uris is missing/not an array', function () {
        assert.deepStrictEqual(resolveRedirectUris(undefined, defaults), defaults);
        assert.deepStrictEqual(resolveRedirectUris('https://x/cb', defaults), defaults);
    });

    it('drops non-string and empty entries, keeping the rest', function () {
        const uris = resolveRedirectUris([42, '', '  ', null, 'https://x/cb'], defaults);
        assert.deepStrictEqual(uris, ['https://x/cb']);
    });

    it('falls back to the defaults when only invalid entries were requested', function () {
        assert.deepStrictEqual(resolveRedirectUris([null, ''], defaults), defaults);
    });
});

describe('lib/oauth-discovery buildDcrRegistration', function () {
    it('always registers a public client, never a client_secret', function () {
        const reg = buildDcrRegistration({
            clientId: 'cid', redirectUris: ['https://x/cb'], scopeStr: 'openid profile'
        });
        assert.strictEqual(reg.client_id, 'cid');
        assert.deepStrictEqual(reg.redirect_uris, ['https://x/cb']);
        assert.strictEqual(reg.token_endpoint_auth_method, 'none');
        assert.ok(!('client_secret' in reg));
    });
});

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
    buildDcrRegistration,
    describeDcrClient
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

    // CIMD is resolved by the IdP, so this server may only report what the IdP told it. A
    // client that sees the flag prefers CIMD over the DCR endpoint, so claiming support the
    // IdP does not have would strand it — hence false rather than undefined when unknown.
    const cimd = oidc => buildAuthorizationServerMetadata({
        issuerBase: 'https://x', oidc, registrationEndpoint: 'https://x/oauth/register', scopes: []
    }).client_id_metadata_document_supported;

    it('advertises CIMD when the IdP does', function () {
        assert.strictEqual(cimd({ client_id_metadata_document_supported: true }), true);
    });

    it('does not advertise CIMD when the IdP says false or omits it', function () {
        assert.strictEqual(cimd({ client_id_metadata_document_supported: false }), false);
        assert.strictEqual(cimd({}), false);
    });

    it('keeps advertising the registration endpoint alongside CIMD', function () {
        // DCR stays a valid fallback: a client without CIMD support skips it in the spec's
        // priority order and lands here. Dropping the endpoint would break those clients.
        const meta = buildAuthorizationServerMetadata({
            issuerBase: 'https://x', oidc: { client_id_metadata_document_supported: true },
            registrationEndpoint: 'https://x/oauth/register', scopes: []
        });
        assert.strictEqual(meta.registration_endpoint, 'https://x/oauth/register');
    });
});

describe('lib/oauth-discovery describeDcrClient', function () {
    it('names the client and what it asked for', function () {
        const line = describeDcrClient(
            { client_name: 'Hermes', software_id: 'hermes-1', redirect_uris: ['https://h/cb'] },
            { 'user-agent': 'hermes/2.0' });
        assert.strictEqual(line,
            'client_name="Hermes" software_id="hermes-1" redirect_uris=[https://h/cb] ua="hermes/2.0"');
    });

    it('falls back to the User-Agent when the client sent no name', function () {
        assert.strictEqual(describeDcrClient({}, { 'user-agent': 'curl/8' }),
                           'client_name=(none) ua="curl/8"');
    });

    it('survives a missing or non-object body', function () {
        for (const body of [undefined, null, 'nope', 42, ['a']]) {
            assert.strictEqual(describeDcrClient(body, null), 'client_name=(none)', String(body));
        }
    });

    it('strips control characters so a name cannot forge a second log line', function () {
        // The body is unauthenticated: without this, any caller could write whatever it liked
        // into the log this change exists to be counted from.
        const line = describeDcrClient({ client_name: 'ok\nMCP DCR fallback: fake' }, {});
        assert.strictEqual(line.indexOf('\n'), -1);
        assert.strictEqual(line, 'client_name="ok MCP DCR fallback: fake"');
    });

    it('truncates an over-long field', function () {
        const line = describeDcrClient({ client_name: 'a'.repeat(500) }, {});
        assert.ok(line.length < 200, 'line was ' + line.length + ' chars');
        assert.ok(line.endsWith('\u2026"'));
    });

    it('caps how many redirect_uris are printed and drops junk entries', function () {
        const uris = ['https://a/1', 'https://a/2', 'https://a/3', 'https://a/4', 'https://a/5',
                      'https://a/6', null, 42, ''];
        const line = describeDcrClient({ redirect_uris: uris }, {});
        assert.ok(line.includes('https://a/5'));
        assert.ok(!line.includes('https://a/6'));
        assert.ok(line.includes('\u2026]'));
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

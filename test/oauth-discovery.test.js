'use strict';
// Deliberately the same test, under the same name, as node-red-contrib-mcp-server's
// test/oauth-discovery.test.js. The two packages duplicate this logic on purpose — matching
// test names are what make a future divergence between them visible.
//
// Everything else this file used to cover — authorization-server metadata, the DCR registration
// response and its redirect-URI handling — went with the shim in 3.0.0.

const assert = require('node:assert');
const { buildProtectedResourceMetadata } = require('../lib/oauth-discovery');

describe('lib/oauth-discovery buildProtectedResourceMetadata', function () {
    it('produces the RFC 9728 shape', function () {
        const meta = buildProtectedResourceMetadata({
            resourceUrl: 'https://nodered.example.com/mcp/docker',
            authServerUrl: 'https://idp.example.com',
            scopes: ['openid', 'profile']
        });
        assert.deepStrictEqual(meta, {
            resource: 'https://nodered.example.com/mcp/docker',
            authorization_servers: ['https://idp.example.com'],
            bearer_methods_supported: ['header'],
            scopes_supported: ['openid', 'profile']
        });
    });

    it('names the identity provider, not this server', function () {
        // The whole point of dropping the shim: a client that discovers the provider here can
        // compare the `iss` it gets back against the issuer it recorded (RFC 9207). While this
        // server named itself, those two disagreed by construction.
        const meta = buildProtectedResourceMetadata({
            resourceUrl: 'https://mcp.example.com/mcp',
            authServerUrl: 'https://idp.example.com',
            scopes: []
        });
        assert.deepStrictEqual(meta.authorization_servers, ['https://idp.example.com']);
    });
});

'use strict';
// The one piece of OAuth discovery this server owns: RFC 9728 protected-resource metadata,
// which tells a client where to go and what to ask for. Everything else that used to live here
// — authorization-server metadata, the dynamic client registration shim and its redirect-URI
// helpers — went with the shim in 3.0.0. This server is a resource server; it does not pretend
// to be an authorization server, and clients are pointed at the real one.
//
// Deliberately the same function name and shape as node-red-contrib-mcp-server's
// lib/oauth-discovery.js. The two packages are peers, so neither depends on the other and the
// code is duplicated on purpose — matching names are what make a future divergence visible by
// reading the two files side by side.

// RFC 9728: the resource identifier must equal the URL the client actually connects to (the
// MCP JSON-RPC endpoint), and authorization_servers must name the issuer that can mint tokens
// for it — the identity provider itself, since nothing here issues anything.
function buildProtectedResourceMetadata({ resourceUrl, authServerUrl, scopes }) {
    return {
        resource                 : resourceUrl,
        authorization_servers    : [authServerUrl],
        bearer_methods_supported : ['header'],
        scopes_supported         : scopes
    };
}

module.exports = { buildProtectedResourceMetadata };

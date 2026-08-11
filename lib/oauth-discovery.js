'use strict';
// Pure helpers for the hal2 event handler's MCP OAuth surface: protected-resource discovery
// (RFC 9728), authorization-server discovery (RFC 8414) and the dynamic client registration
// shim. No Express/HTTP dependency, so these are unit-testable in isolation — core/eventhandler.js
// keeps the route wiring, the host guard, the rate limits and the OIDC discovery fetch, and its
// handlers are thin glue that call one of these and res.json() the result.
//
// Deliberately the same function names, shapes and test names as node-red-contrib-mcp-server's
// lib/oauth-discovery.js. The two packages are peers, so neither depends on the other and the
// code is duplicated on purpose — matching names are what make a future divergence visible by
// reading the two files side by side.

// RFC 9728: the resource identifier must equal the URL the client actually connects to
// (the MCP JSON-RPC endpoint), and authorization_servers must list the server(s) that can
// issue tokens for it.
function buildProtectedResourceMetadata({ resourceUrl, authServerUrl, scopes }) {
    return {
        resource                 : resourceUrl,
        authorization_servers    : [authServerUrl],
        bearer_methods_supported : ['header'],
        scopes_supported         : scopes
    };
}

// RFC 8414 authorization server metadata. The MCP server proxies the real OIDC issuer's
// endpoints under its own `issuer` identity so MCP clients only ever need to trust one
// origin (this server) for discovery + DCR, while the actual authorize/token/userinfo
// traffic still goes straight to the real IdP. Always a public client: anything the DCR
// endpoint hands out is world-readable, so a client secret could never actually be secret.
function buildAuthorizationServerMetadata({ issuerBase, oidc, registrationEndpoint, scopes }) {
    return {
        issuer                                 : issuerBase,
        authorization_endpoint                 : oidc.authorization_endpoint,
        token_endpoint                         : oidc.token_endpoint,
        userinfo_endpoint                      : oidc.userinfo_endpoint,
        registration_endpoint                  : registrationEndpoint,
        jwks_uri                               : oidc.jwks_uri,
        scopes_supported                       : scopes,
        response_types_supported               : ['code'],
        grant_types_supported                  : ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported       : ['S256'],
        token_endpoint_auth_methods_supported  : ['none']
    };
}

// Echo the client's requested redirect_uris in the DCR response; the IdP validates the
// actual redirect URI at /authorize against its own client registration (which may use
// wildcards this shim couldn't express), and PKCE makes an intercepted code useless — so
// this shim doesn't maintain a parallel allowlist. Fall back to `defaultUris` when the
// client requested none, since the response field is required for the code grant.
function resolveRedirectUris(requestedUris, defaultUris) {
    const requested = (Array.isArray(requestedUris) ? requestedUris : [])
        .filter(u => typeof u === 'string' && u.trim() !== '');
    return requested.length ? requested : defaultUris;
}

function buildDcrRegistration({ clientId, redirectUris, scopeStr }) {
    return {
        client_id                  : clientId,
        client_id_issued_at        : Math.floor(Date.now() / 1000),
        redirect_uris              : redirectUris,
        grant_types                : ['authorization_code', 'refresh_token'],
        response_types             : ['code'],
        token_endpoint_auth_method : 'none',
        scope                      : scopeStr
    };
}

module.exports = {
    buildProtectedResourceMetadata,
    buildAuthorizationServerMetadata,
    resolveRedirectUris,
    buildDcrRegistration
};

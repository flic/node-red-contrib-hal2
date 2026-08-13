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
        token_endpoint_auth_methods_supported  : ['none'],
        // Mirrored from the IdP rather than configured. CIMD is resolved by the IdP — the
        // client_id URL goes to its authorize endpoint, not ours — so advertising it is only
        // ever a claim about the IdP, and one this server is in no position to make on its
        // own. Strict === true so an IdP that omits the field publishes false, not undefined:
        // clients pick CIMD over DCR when they see it, and a wrong true strands them.
        client_id_metadata_document_supported  : oidc.client_id_metadata_document_supported === true
    };
}

// Which URL this server names as its authorization server. The DCR shim is the whole
// authorization-server proxy, not merely the /oauth/register route: advertising ourselves as
// the `issuer` is what lets a client discover that route in the first place. One switch
// governs both, and this is where that coupling is written down.
//
// With the shim off, clients are sent straight to the IdP, which issues the authorization
// response under its own identity — so the `iss` a client receives matches the issuer it
// discovered (RFC 9207). With the shim on those two disagree by construction, and a client
// that enforces the check cannot finish the flow however correct everything else is.
//
// An unconfigured issuer falls back to this server whichever way the switch is set: pointing
// clients at an empty string leaves them nothing to discover, which is worse than a mismatch.
function resolveAuthServerUrl(dcrShim, publicBase, issuerUrl) {
    return (dcrShim || !issuerUrl) ? publicBase : issuerUrl;
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

// One-line description of whoever just called the DCR endpoint, for the log. Everything here
// is attacker-controlled: the body is unvalidated JSON and the User-Agent is a raw header, so
// each value is truncated and stripped of control characters — a newline in client_name would
// otherwise forge a second log line, and the whole point of this line is to be trusted later
// when counting which clients still cannot do CIMD.
const FIELD_MAX = 120;
const URI_MAX   = 5;

function logSafe(value) {
    if (typeof value !== 'string') { return ''; }
    // eslint-disable-next-line no-control-regex
    const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
    if (!clean) { return ''; }
    return clean.length > FIELD_MAX ? clean.slice(0, FIELD_MAX) + '…' : clean;
}

function describeDcrClient(body, headers) {
    const b = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
    const h = (headers && typeof headers === 'object') ? headers : {};
    const parts = [];

    const name = logSafe(b.client_name);
    // A client that sent no name is described by its User-Agent instead: with neither, the
    // only honest thing to report is that it identified itself not at all.
    parts.push(name ? 'client_name="' + name + '"' : 'client_name=(none)');

    const softwareId = logSafe(b.software_id);
    if (softwareId) { parts.push('software_id="' + softwareId + '"'); }

    const uris = (Array.isArray(b.redirect_uris) ? b.redirect_uris : [])
        .map(logSafe).filter(Boolean);
    if (uris.length) {
        const shown = uris.slice(0, URI_MAX).join(' ');
        parts.push('redirect_uris=[' + shown + (uris.length > URI_MAX ? ' …' : '') + ']');
    }

    const ua = logSafe(h['user-agent']);
    if (ua) { parts.push('ua="' + ua + '"'); }

    return parts.join(' ');
}

module.exports = {
    buildProtectedResourceMetadata,
    buildAuthorizationServerMetadata,
    resolveRedirectUris,
    buildDcrRegistration,
    describeDcrClient,
    resolveAuthServerUrl
};

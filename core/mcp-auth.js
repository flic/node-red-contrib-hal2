'use strict';
// MCP authentication surface: OIDC discovery, JWKS, token validation and the Bearer
// middleware. Extracted from eventhandler.js so it can be reasoned about and unit-tested
// in isolation. All external dependencies (HTTP, logging, and the jose primitives) are
// injectable, so tests need neither a live IdP nor a running Node-RED.

const crypto = require('crypto');
const jose   = require('jose');

const TOKEN_CACHE_MAX = 1000;

// Constant-time secret comparison that does not leak length. Both inputs are hashed to a
// fixed-width digest before timingSafeEqual, so mismatched lengths compare safely.
function secretEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// A CIMD client identifies itself with the https URL its metadata document is hosted at, per
// draft-ietf-oauth-client-id-metadata-document-01 §2: https scheme, a path component, no
// fragment and no userinfo. Anything else that merely looks URL-ish is not a client id.
function isCimdClientId(value) {
    if (typeof value !== 'string') { return false; }
    let u;
    try { u = new URL(value); } catch (e) { return false; }
    return u.protocol === 'https:' && u.hash === '' && u.username === '' && u.password === ''
        && u.pathname !== '' && u.pathname !== '/';
}

// Every value a token offers as its audience: `aud` (string or array) plus `azp`. Which of
// them carries what is provider-specific, so both are read as one list.
function audienceValues(payload) {
    const p = (payload && typeof payload === 'object') ? payload : {};
    const values = Array.isArray(p.aud) ? p.aud.slice() : (p.aud ? [p.aud] : []);
    // azp too: which of aud/azp carries a CIMD client id is provider-specific, and reading
    // only one of them would make this depend on a detail no spec pins down.
    if (typeof p.azp === 'string' && p.azp) { values.push(p.azp); }
    return values;
}

// The CIMD client id a token was issued to, or '' if it was not a CIMD client. Separate from
// acceptsAudience because the answer is worth logging, not only deciding on: a DCR fallback
// announces itself by hitting /oauth/register, and without this its opposite — a client that
// has moved to CIMD — would be the one case that leaves no trace anywhere.
//
// The resource identifier and a configured audience are excluded, because either can be an
// https URL with a path and so is CIMD-shaped too. An IdP that honours RFC 8707 binds the
// token to the resource, which then sits in `aud` ahead of anything else — reporting that as
// the client is how this first went wrong against a real token.
function cimdClientId(payload, { expected = '', resourceUrl = '' } = {}) {
    return audienceValues(payload)
        .find(v => v !== expected && v !== resourceUrl && isCimdClientId(v)) || '';
}

// Decides whether a signature-valid token was issued for this server. This replaces handing
// `audience` to jwtVerify, because a CIMD client's id is its document URL: the IdP issues the
// token to that URL, so `aud` never equals the pre-registered client id and jose would reject
// it before anything here could look.
//
// Accepting a CIMD audience is safe only because the IdP resolves such a client_id against its
// own allowlist of metadata documents before issuing anything — which is why it is gated on
// `allowCimd`, mirrored from the IdP's advertised support, rather than on the shape of the
// string alone. It does mean any CIMD client the IdP allowlists for any application can reach
// this server, with the claim gate as the remaining check; narrowing that later means passing
// a list of accepted client ids here instead of the boolean, and nothing else moves.
function acceptsAudience(payload, { expected = '', resourceUrl = '', allowCimd = false } = {}) {
    if (!expected) { return true; }        // unconfigured — unchanged from before this existed
    return audienceValues(payload).some(v =>
               v === expected
               || (!!resourceUrl && v === resourceUrl))   // RFC 8707: token bound to the resource
        || (allowCimd && !!cimdClientId(payload, { expected, resourceUrl }));
}

function createMcpAuth(opts) {
    const {
        issuerUrl          = '',
        tokenTTL           = 300000,
        tokenAudience      = '',
        localDebugToken    = '',
        localDebugGroups   = ['admin'],
        mcpServerUrl       = '',
        // The RFC 9728 resource identifier — the MCP endpoint clients connect to. Distinct
        // from mcpServerUrl, which is the base the WWW-Authenticate challenge points at.
        resourceUrl        = '',
        // The full space-delimited set this server advertises, named in the 401 challenge.
        // It must be the whole set, not just what the gate requires: MCP clients treat a
        // challenged scope as authoritative and request it *instead of* scopes_supported, so
        // naming only the gate's scopes strips openid and the claim the gate itself reads.
        // Empty leaves the challenge without a scope parameter.
        advertisedScopes   = '',
        discoveryRetryMs   = 30000,
        httpGet,
        log                = () => {},
        warn               = () => {},
        // Injectable for tests; default to the real jose primitives.
        jwtVerify          = jose.jwtVerify,
        createRemoteJWKSet = jose.createRemoteJWKSet
    } = opts || {};

    if (typeof httpGet !== 'function') {
        throw new Error('createMcpAuth requires an httpGet function');
    }

    let tokenCache = {};
    // Set once the provider refuses a token at userinfo; see validateToken. Reset by a
    // restart or redeploy, which is also when a provider's configuration would have changed.
    let userinfoRefused = false;
    // CIMD client ids already announced in the log, so the confirmation is one line per client
    // per restart rather than one per token or per cache miss. Capped for the same reason the
    // token cache is: the values come off tokens arriving at an internet-exposed endpoint. At
    // the cap it stops logging rather than stops working — a silent new client is a smaller
    // problem than unbounded growth, and 100 distinct CIMD clients is far past any real use.
    const seenCimdClients = new Set();
    const CIMD_LOG_MAX = 100;
    let oidcConfig = null, oidcConfigPromise = null, oidcRetryAt = 0;
    let jwks = null, jwksUri = null;

    // OIDC discovery with PocketID-style fallback paths. Discover the IdP's real endpoints
    // from /.well-known/openid-configuration so any spec-compliant OIDC provider works; fall
    // back to the PocketID path layout when discovery is unavailable.
    function fallbackEndpoints() {
        return {
            issuer                 : issuerUrl,
            authorization_endpoint : issuerUrl + '/authorize',
            token_endpoint         : issuerUrl + '/api/oidc/token',
            userinfo_endpoint      : issuerUrl + '/api/oidc/userinfo',
            jwks_uri               : issuerUrl + '/.well-known/jwks.json'
        };
    }

    function getOidcConfig() {
        if (oidcConfig) return Promise.resolve(oidcConfig);
        // Only successful discovery is cached. After a failure the fallback is served
        // without re-probing until the retry window has passed, so a transient IdP
        // outage (e.g. during deploy) neither pins the fallback forever nor turns every
        // request into a discovery attempt against a dead IdP.
        if (!oidcConfigPromise && Date.now() < oidcRetryAt) {
            return Promise.resolve(fallbackEndpoints());
        }
        if (!oidcConfigPromise) {
            oidcConfigPromise = (async () => {
                const fb = fallbackEndpoints();
                if (!issuerUrl) { oidcConfig = fb; return fb; }
                try {
                    const r = await httpGet(issuerUrl + '/.well-known/openid-configuration', {});
                    if (r.status === 200 && r.body && typeof r.body === 'object' && r.body.jwks_uri) {
                        oidcConfig = Object.assign(fb, r.body);   // discovered values win, per-field fallback
                        // Say which registration mechanisms are live. Without it, a client
                        // that cannot authenticate leaves no way to tell "the IdP has CIMD
                        // switched off" apart from "the client isn't using it".
                        log('MCP OIDC discovery ok: issuer=' + oidcConfig.issuer +
                            ', CIMD=' + (oidcConfig.client_id_metadata_document_supported === true
                                ? 'advertised by the IdP — CIMD client ids accepted as audience'
                                : 'not advertised by the IdP — DCR only'));
                        return oidcConfig;
                    }
                    warn('MCP OIDC discovery returned ' + r.status + ' — using fallback endpoint paths');
                } catch (e) {
                    warn('MCP OIDC discovery failed: ' + e.message + ' — using fallback endpoint paths');
                }
                oidcConfigPromise = null;
                oidcRetryAt = Date.now() + discoveryRetryMs;
                return fb;
            })();
        }
        return oidcConfigPromise;
    }

    // Lazy JWKS — built from the discovered jwks_uri on first real token validation, and
    // rebuilt if a later re-discovery changes the jwks_uri (fallback → discovered).
    async function getJwks() {
        const oidc = await getOidcConfig();
        if (!jwks || jwksUri !== oidc.jwks_uri) {
            jwksUri = oidc.jwks_uri;
            jwks = createRemoteJWKSet(new URL(jwksUri));
        }
        return jwks;
    }

    // Insert into the token cache with a hard size cap: drop expired entries first, then evict
    // the soonest-to-expire until back under the cap. Prevents unbounded growth (and OOM) from
    // a flood of unique tokens on an internet-exposed endpoint.
    function cacheToken(key, entry) {
        tokenCache[key] = entry;
        const keys = Object.keys(tokenCache);
        if (keys.length <= TOKEN_CACHE_MAX) return;
        const now = Date.now();
        for (const k of keys) { if (tokenCache[k].exp < now) delete tokenCache[k]; }
        let remaining = Object.keys(tokenCache);
        if (remaining.length > TOKEN_CACHE_MAX) {
            remaining.sort((x, y) => tokenCache[x].exp - tokenCache[y].exp);
            for (let i = 0; i < remaining.length - TOKEN_CACHE_MAX; i++) delete tokenCache[remaining[i]];
        }
    }

    async function validateToken(token) {
        // Local debug token bypass — skips the IdP entirely. Constant-time compare so the token
        // can't be recovered by timing the response. Groups are configurable so claim gates with
        // values other than 'admin' can be exercised locally too; sliced so a flow that mutates
        // msg.jwtClaims can't poison later requests.
        if (localDebugToken && secretEqual(token, localDebugToken)) {
            return { sub: 'debug', name: 'Local debug user', groups: localDebugGroups.slice() };
        }

        const cacheKey = 'auth_' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 20);
        if (Object.prototype.hasOwnProperty.call(tokenCache, cacheKey)
            && tokenCache[cacheKey].exp >= Date.now()) {
            // Cloned for the same reason the debug groups are sliced above: these claims are
            // handed to flows (msg.jwtClaims), and a flow that mutates them must not poison
            // the cached copy that later requests with the same token are authorized against.
            return structuredClone(tokenCache[cacheKey].claims);
        }
        try {
            const oidc = await getOidcConfig();
            // Always pin the issuer to the discovered IdP; enforce audience only when configured.
            // Without these, any signature-valid token from a provider that shares the JWKS would
            // be accepted.
            const verifyOpts = {};
            if (oidc.issuer) verifyOpts.issuer = oidc.issuer;
            const { payload } = await jwtVerify(token, await getJwks(), verifyOpts);
            // Audience is checked here rather than by jose so a CIMD client id can be accepted
            // as well — see acceptsAudience.
            if (!acceptsAudience(payload, {
                expected    : tokenAudience,
                resourceUrl : resourceUrl,
                allowCimd   : oidc.client_id_metadata_document_supported === true
            })) {
                warn('MCP token rejected: audience ' + JSON.stringify(payload.aud) +
                     ' is not this server');
                return null;
            }
            // The counterpart to the DCR fallback line: say which clients have moved to CIMD,
            // so the two logs together account for every client that reaches this server.
            if (oidc.client_id_metadata_document_supported === true) {
                const cimd = cimdClientId(payload, { expected: tokenAudience, resourceUrl });
                if (cimd && !seenCimdClients.has(cimd) && seenCimdClients.size < CIMD_LOG_MAX) {
                    seenCimdClients.add(cimd);
                    log('MCP CIMD client authenticated: ' + cimd);
                }
            }
            // Enrich with userinfo — access tokens are minimal by OIDC convention, and with many
            // providers the rich claims (email, name, groups) live only in that response. JWT
            // payload wins on collisions so verified fields stay authoritative.
            //
            // A 4xx here is not a hiccup, it is an answer: this provider does not accept this
            // server's tokens at its userinfo endpoint, and it will keep not accepting them.
            // That is the normal outcome once tokens are audience-bound to the MCP resource,
            // which every MCP client asks for by sending `resource` (RFC 8707). So the refusal
            // is recorded and the call is not made again — one line in the log instead of one
            // per cache miss forever, and one fewer round-trip on every token.
            //
            // Only 4xx. A network error or a 5xx is a provider that is unwell rather than one
            // that has decided, and disabling enrichment for the life of the node over a blip
            // would silently strip claims the gate may depend on.
            let claims = payload;
            if (!userinfoRefused) {
                try {
                    const r = await httpGet(oidc.userinfo_endpoint, { 'Authorization': 'Bearer ' + token });
                    if (r.status === 200 && r.body && typeof r.body === 'object') {
                        claims = Object.assign({}, r.body, payload);
                    } else if (r.status >= 400 && r.status < 500) {
                        userinfoRefused = true;
                        warn('MCP userinfo returned ' + r.status + ' — using JWT claims only, and ' +
                             'not asking again. Expected when the provider binds tokens to the ' +
                             'resource; the JWT carries the claims in that case.');
                    } else {
                        warn('MCP userinfo returned ' + r.status + ' — using JWT claims only');
                    }
                } catch (e) {
                    warn('MCP userinfo fetch failed: ' + e.message + ' — using JWT claims only');
                }
            }
            const tokenExpMs = (typeof payload.exp === 'number') ? payload.exp * 1000 : Infinity;
            const cacheExp = Math.min(Date.now() + tokenTTL, tokenExpMs);
            cacheToken(cacheKey, { claims, exp: cacheExp });
            return structuredClone(claims);   // same isolation as the cache-hit path
        } catch (e) {
            warn('MCP token verify failed: ' + e.message);
            return null;
        }
    }

    // RFC 6750 3: the challenge parameters, with `scope` only when there is one to name.
    const challenge = extra => 'Bearer ' + (extra ? extra + ', ' : '')
        + `resource_metadata="${mcpServerUrl}/.well-known/oauth-protected-resource"`
        + (advertisedScopes ? `, scope="${advertisedScopes}"` : '');

    async function requireBearer(req, res) {
        const authHeader = req.headers['authorization'] || '';
        // Scheme matched case-insensitively per RFC 7235 — "bearer x" is as valid as "Bearer x".
        const m = /^Bearer\s+(.+)$/i.exec(authHeader);
        if (!m) {
            res.set('WWW-Authenticate', challenge(''));
            res.status(401).json({ error: 'unauthorized' });
            return null;
        }
        const token  = m[1];
        const claims = await validateToken(token);
        if (!claims) {
            res.set('WWW-Authenticate', challenge('error="invalid_token"'));
            res.status(401).json({ error: 'invalid_token' });
            return null;
        }
        return claims;
    }

    return {
        validateToken,
        requireBearer,
        getOidcConfig,
        clearCache: () => { tokenCache = {}; },
        cacheSize:  () => Object.keys(tokenCache).length
    };
}

module.exports = { createMcpAuth, secretEqual, acceptsAudience, cimdClientId };

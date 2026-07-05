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

function createMcpAuth(opts) {
    const {
        issuerUrl          = '',
        tokenTTL           = 300000,
        tokenAudience      = '',
        localDebugToken    = '',
        mcpServerUrl       = '',
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
    let oidcConfig = null, oidcConfigPromise = null;
    let jwks = null;

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
        if (!oidcConfigPromise) {
            oidcConfigPromise = (async () => {
                const fb = fallbackEndpoints();
                if (!issuerUrl) { oidcConfig = fb; return fb; }
                try {
                    const r = await httpGet(issuerUrl + '/.well-known/openid-configuration', {});
                    if (r.status === 200 && r.body && typeof r.body === 'object' && r.body.jwks_uri) {
                        oidcConfig = Object.assign(fb, r.body);   // discovered values win, per-field fallback
                        log('MCP OIDC discovery ok: issuer=' + oidcConfig.issuer);
                    } else {
                        warn('MCP OIDC discovery returned ' + r.status + ' — using fallback endpoint paths');
                        oidcConfig = fb;
                    }
                } catch (e) {
                    warn('MCP OIDC discovery failed: ' + e.message + ' — using fallback endpoint paths');
                    oidcConfig = fb;
                }
                return oidcConfig;
            })();
        }
        return oidcConfigPromise;
    }

    // Lazy JWKS — built from the discovered jwks_uri on first real token validation.
    async function getJwks() {
        if (!jwks) {
            const oidc = await getOidcConfig();
            jwks = createRemoteJWKSet(new URL(oidc.jwks_uri));
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
        // can't be recovered by timing the response.
        if (localDebugToken && secretEqual(token, localDebugToken)) {
            return { sub: 'debug', name: 'Local debug user', groups: ['admin'] };
        }

        const cacheKey = 'auth_' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 20);
        if (Object.prototype.hasOwnProperty.call(tokenCache, cacheKey)
            && tokenCache[cacheKey].exp >= Date.now()) {
            return tokenCache[cacheKey].claims;
        }
        try {
            const oidc = await getOidcConfig();
            // Always pin the issuer to the discovered IdP; enforce audience only when configured.
            // Without these, any signature-valid token from a provider that shares the JWKS would
            // be accepted.
            const verifyOpts = {};
            if (oidc.issuer) verifyOpts.issuer = oidc.issuer;
            if (tokenAudience) verifyOpts.audience = tokenAudience;
            const { payload } = await jwtVerify(token, await getJwks(), verifyOpts);
            // Enrich with userinfo — access tokens are minimal by OIDC convention, rich claims
            // (email, name, groups) live in the userinfo response. JWT payload wins on collisions
            // so verified fields stay authoritative.
            let claims = payload;
            try {
                const r = await httpGet(oidc.userinfo_endpoint, { 'Authorization': 'Bearer ' + token });
                if (r.status === 200 && r.body && typeof r.body === 'object') {
                    claims = Object.assign({}, r.body, payload);
                } else {
                    warn('MCP userinfo returned ' + r.status + ' — using JWT claims only');
                }
            } catch (e) {
                warn('MCP userinfo fetch failed: ' + e.message + ' — using JWT claims only');
            }
            const tokenExpMs = (typeof payload.exp === 'number') ? payload.exp * 1000 : Infinity;
            const cacheExp = Math.min(Date.now() + tokenTTL, tokenExpMs);
            cacheToken(cacheKey, { claims, exp: cacheExp });
            return claims;
        } catch (e) {
            warn('MCP token verify failed: ' + e.message);
            return null;
        }
    }

    async function requireBearer(req, res) {
        const authHeader = req.headers['authorization'] || '';
        if (!authHeader.startsWith('Bearer ')) {
            res.set('WWW-Authenticate',
                `Bearer resource_metadata="${mcpServerUrl}/.well-known/oauth-protected-resource"`);
            res.status(401).json({ error: 'unauthorized' });
            return null;
        }
        const token  = authHeader.slice(7);
        const claims = await validateToken(token);
        if (!claims) {
            res.set('WWW-Authenticate',
                `Bearer error="invalid_token", resource_metadata="${mcpServerUrl}/.well-known/oauth-protected-resource"`);
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

module.exports = { createMcpAuth, secretEqual };

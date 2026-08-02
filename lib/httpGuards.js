'use strict';
// HTTP hardening middleware for internet-exposed MCP routes: per-IP rate limiting
// (sliding 60s window) and a Content-Length cap. Express-style (req, res, next)
// middlewares, shared by hal2EventHandler and hal2MCPServer and unit-testable without
// Node-RED. Node-RED's own body parser still applies; these are cheap early guards.

// createHttpGuards({ warn }) → { rateLimit(bucket, perMinute), maxBody(bytes) }.
// One hit store per factory instance, shared across that instance's buckets.
function createHttpGuards(opts) {
    const warn  = (opts && opts.warn) || (() => {});
    const store = {};
    let proxyWarned = false;

    function rateLimit(bucket, perMinute) {
        return (req, res, next) => {
            const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
            // Behind a reverse proxy Express only honours X-Forwarded-For when its
            // 'trust proxy' setting is on — otherwise every client shares the proxy's
            // IP and one abuser rate-limits everybody. Warn once when that's detected.
            if (!proxyWarned && req.headers && req.headers['x-forwarded-for']
                && req.app && typeof req.app.get === 'function' && !req.app.get('trust proxy')) {
                proxyWarned = true;
                warn('Rate limiting sees the reverse proxy\'s IP for every client (X-Forwarded-For is ignored). ' +
                     'Set "trust proxy" in Node-RED\'s httpServerOptions so limits apply per real client.');
            }
            const key = bucket + '|' + ip;
            const now = Date.now();
            const win = now - 60000;
            const hits = (store[key] || []).filter(t => t > win);
            if (hits.length >= perMinute) {
                res.set('Retry-After', '60');
                return res.status(429).json({ error: 'rate_limited' });
            }
            hits.push(now);
            store[key] = hits;
            if (Object.keys(store).length > 5000) {            // bound memory
                for (const k of Object.keys(store)) {
                    if (!store[k].some(t => t > win)) delete store[k];
                }
            }
            next();
        };
    }

    function maxBody(bytes) {
        return (req, res, next) => {
            if (Number(req.headers['content-length'] || 0) > bytes) {
                return res.status(413).json({ error: 'payload_too_large' });
            }
            next();
        };
    }

    return { rateLimit, maxBody };
}

// hostFilter(expectedHost) → middleware that only lets requests whose Host header matches
// expectedHost run this route's handler. On a mismatch it calls next('route'), skipping the
// rest of *this* route so another route on the shared router (same path, different hostname —
// e.g. a second EventHandler) gets its turn. This is what makes hostname-based splitting work:
// several nodes can register the identical path (/mcp, /.well-known/…) and be told apart by Host.
//
// expectedHost falsy → the feature is off: every request passes through and matching stays
// path-only, so single-server setups (and anyone behind a proxy that rewrites Host) are untouched.
// Compared case-insensitively; the port is part of the Host header so keep it in expectedHost
// if the public URL carries a non-default port. Put this first in the chain so mismatches skip
// before consuming the rate-limit budget.
function hostFilter(expectedHost) {
    const want = expectedHost ? String(expectedHost).toLowerCase() : '';
    return (req, res, next) => {
        if (!want) return next();
        const got = String((req.headers && req.headers.host) || '').toLowerCase();
        if (got !== want) return next('route');
        return next();
    };
}

// removeOwnedRoutes(router, method, path, ownerId) → remove only the routes THIS owner
// registered for (method, path). Several nodes may share a path when hostname filtering
// splits them by Host header, so matching on path alone would let a partial deploy of one
// node silently strip its siblings' routes. Ownership is read off a middleware in the
// route's chain tagged with `_mcpOwner` (see the registration sites); untagged routes are
// left alone, so routes registered by anything else on the shared router are never touched.
function removeOwnedRoutes(router, method, path, ownerId) {
    if (!router || !Array.isArray(router.stack)) return;
    router.stack = router.stack.filter(layer => {
        if (!layer.route) return true;
        if (layer.route.path !== path || !layer.route.methods[method]) return true;
        return !(layer.route.stack || []).some(l =>
            l.handle && l.handle._mcpOwner !== undefined && l.handle._mcpOwner === ownerId);
    });
}

module.exports = { createHttpGuards, hostFilter, removeOwnedRoutes };

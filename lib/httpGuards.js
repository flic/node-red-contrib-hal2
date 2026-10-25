'use strict';
// HTTP hardening middleware for internet-exposed MCP routes: per-IP rate limiting
// (sliding 60s window) and a Content-Length cap. Express-style (req, res, next)
// middlewares, used by hal2EventHandler's MCP routes and unit-testable without Node-RED — a
// copy of node-red-contrib-mcp-server's lib/http-guards.js, plus removeOwnedRoutes. Node-RED
// does not parse bodies for routes registered on RED.httpNode, so jsonBody does. maxBody rejects an oversized Content-Length before reading; jsonBody's own limit is the
// backstop for a chunked request, which has none.

// createHttpGuards({ warn }) → { rateLimit(bucket, perMinute), maxBody(bytes), jsonBody(bytes) }.
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

    // jsonBody(bytes) reads and parses a JSON body itself. Node-RED parses bodies only in its
    // admin app and in http-in nodes; routes registered straight on RED.httpNode, like the MCP
    // routes, got theirs from the admin app's parser only while httpAdminRoot was '/', where
    // every request passed through it. With the editor moved (e.g. to '/editor') req.body was
    // undefined and every MCP call failed. A body something upstream already parsed
    // (body-parser sets req._body) is left alone. The limit is enforced while reading, so a
    // chunked request without Content-Length is capped too; maxBody only reads the header.
    function jsonBody(bytes) {
        return (req, res, next) => {
            if (req._body) return next();
            const type = String((req.headers && req.headers['content-type']) || '').toLowerCase();
            if (!/^application\/([\w.+-]+\+)?json\b/.test(type)) return next();
            const chunks = [];
            let size = 0;
            let done = false;
            const fail = (status, body) => {
                if (done) return;
                done = true;
                req.resume();                        // drain the rest, the reply is already decided
                res.status(status).json(body);
            };
            req.on('data', chunk => {
                if (done) return;
                size += chunk.length;
                if (size > bytes) return fail(413, { error: 'payload_too_large' });
                chunks.push(chunk);
            });
            req.on('error', () => fail(400, { error: 'bad_request' }));
            req.on('end', () => {
                if (done) return;
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed = {};
                if (text.trim()) {
                    try { parsed = JSON.parse(text); }
                    catch { return fail(400, { jsonrpc: '2.0', id: null,
                                               error: { code: -32700, message: 'Parse error' } }); }
                }
                done = true;
                req._body = true;
                req.body = parsed;
                next();
            });
        };
    }

    return { rateLimit, maxBody, jsonBody };
}

// hostFilter(expectedHost, registry) → middleware that only lets requests whose Host header
// matches expectedHost run this route's handler. On a mismatch it calls next('route'), skipping
// the rest of *this* route so another route on the shared router (same path, different
// hostname — e.g. a second mcp-server node) gets its turn. This is what makes hostname-based
// splitting work: several nodes can register the identical path and be told apart by Host.
//
// expectedHost falsy → the feature is off: this route answers every hostname. Compared
// case-insensitively; the port is part of the Host header so keep it in expectedHost if the
// public URL carries a non-default port. Put this first in the chain so mismatches skip before
// consuming the rate-limit budget.
//
// With a registry (hostRegistry below), an unfiltered route also steps aside for a hostname that
// a filtered sibling on the same path has claimed — so which server answers does not depend on
// which one happened to register first, an order every redeploy of one of them changes.
function hostFilter(expectedHost, registry) {
    const want = expectedHost ? String(expectedHost).toLowerCase() : '';
    return (req, res, next) => {
        const got = String((req.headers && req.headers.host) || '').toLowerCase();
        if (want) return got === want ? next() : next('route');
        if (registry && req.route && registry.claimed(routeKey(req.method, req.route.path), got)) return next('route');
        return next();
    };
}

// A HEAD is answered by the GET route; both key the same.
const routeKey = (method, path) => (String(method).toUpperCase() === 'HEAD' ? 'GET' : String(method).toUpperCase()) + ' ' + path;

// Which hostnames filtered routes have claimed, per method and path, shared by every node that
// registers MCP routes on this router. Kept on the router's holder under a global symbol, so
// another package registering MCP routes (node-red-contrib-hal2) can take part by using the
// same symbol.
const REGISTRY = Symbol.for('node-red-mcp.hostRegistry');

function hostRegistry(holder) {
    if (holder && holder[REGISTRY]) return holder[REGISTRY];
    const claims = new Map();   // owner → { host, keys: Set }
    const registry = {
        // owner claims `host` (lowercased, '' for unfiltered) on these [method, path] routes.
        claim(owner, host, routes) {
            claims.set(owner, { host: String(host || '').toLowerCase(),
                keys: new Set(routes.map(([m, p]) => routeKey(m, p))) });
        },
        release(owner) { claims.delete(owner); },
        // Whether some owner's filtered route on this key claims this host.
        claimed(key, host) {
            for (const c of claims.values()) { if (c.host && c.host === host && c.keys.has(key)) return true; }
            return false;
        }
    };
    if (holder) Object.defineProperty(holder, REGISTRY, { value: registry });
    return registry;
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

module.exports = { createHttpGuards, hostFilter, hostRegistry, removeOwnedRoutes };

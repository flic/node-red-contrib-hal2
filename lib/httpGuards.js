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

module.exports = { createHttpGuards };

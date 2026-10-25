'use strict';

const assert = require('node:assert');
const { createHttpGuards, hostFilter, hostRegistry, removeOwnedRoutes } = require('../lib/httpGuards');

function mockRes() {
    return {
        statusCode: null, body: null, headers: {},
        set(k, v)  { this.headers[k] = v; return this; },
        status(c)  { this.statusCode = c; return this; },
        json(b)    { this.body = b; return this; }
    };
}

function mockReq(overrides) {
    return Object.assign({
        ip: '203.0.113.7',
        headers: {},
        app: { get: () => true }   // trust proxy on by default in tests
    }, overrides);
}

function run(mw, req) {
    const res = mockRes();
    let passed = false;
    mw(req, res, () => { passed = true; });
    return { res, passed };
}

describe('lib/httpGuards rateLimit', function () {
    it('passes requests under the limit and 429s over it', function () {
        const { rateLimit } = createHttpGuards({});
        const mw = rateLimit('mcp', 2);
        assert.strictEqual(run(mw, mockReq()).passed, true);
        assert.strictEqual(run(mw, mockReq()).passed, true);
        const third = run(mw, mockReq());
        assert.strictEqual(third.passed, false);
        assert.strictEqual(third.res.statusCode, 429);
        assert.strictEqual(third.res.body.error, 'rate_limited');
        assert.strictEqual(third.res.headers['Retry-After'], '60');
    });

    it('tracks limits per IP', function () {
        const { rateLimit } = createHttpGuards({});
        const mw = rateLimit('mcp', 1);
        assert.strictEqual(run(mw, mockReq({ ip: '198.51.100.1' })).passed, true);
        assert.strictEqual(run(mw, mockReq({ ip: '198.51.100.2' })).passed, true);
        assert.strictEqual(run(mw, mockReq({ ip: '198.51.100.1' })).passed, false);
    });

    it('tracks limits per bucket', function () {
        const guards = createHttpGuards({});
        const a = guards.rateLimit('a', 1);
        const b = guards.rateLimit('b', 1);
        assert.strictEqual(run(a, mockReq()).passed, true);
        assert.strictEqual(run(b, mockReq()).passed, true);   // separate bucket, own budget
        assert.strictEqual(run(a, mockReq()).passed, false);
    });

    it('warns once when X-Forwarded-For arrives but trust proxy is off', function () {
        const warnings = [];
        const { rateLimit } = createHttpGuards({ warn: m => warnings.push(m) });
        const mw  = rateLimit('mcp', 10);
        const req = () => mockReq({
            headers: { 'x-forwarded-for': '192.0.2.1' },
            app: { get: () => false }
        });
        run(mw, req());
        run(mw, req());
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0], /trust proxy/);
    });

    it('does not warn when trust proxy is on or no proxy is involved', function () {
        const warnings = [];
        const { rateLimit } = createHttpGuards({ warn: m => warnings.push(m) });
        const mw = rateLimit('mcp', 10);
        run(mw, mockReq({ headers: { 'x-forwarded-for': '192.0.2.1' } }));   // trust proxy on
        run(mw, mockReq());                                                  // no XFF header
        assert.strictEqual(warnings.length, 0);
    });
});

describe('lib/httpGuards hostFilter', function () {
    // Captures what the middleware passed to next(): undefined = handle this route,
    // 'route' = skip to the next matching route.
    function runHost(mw, req) {
        let nextArg = 'NOT_CALLED';
        mw(req, mockRes(), (arg) => { nextArg = arg; });
        return nextArg;
    }

    it('passes everything through when no expected host is set', function () {
        const mw = hostFilter('');
        assert.strictEqual(runHost(mw, mockReq({ headers: { host: 'anything.example.com' } })), undefined);
        assert.strictEqual(runHost(mw, mockReq()), undefined);   // no host header at all
    });

    it('runs the route when the Host header matches', function () {
        const mw = hostFilter('mcp.furtenbach.se');
        assert.strictEqual(runHost(mw, mockReq({ headers: { host: 'mcp.furtenbach.se' } })), undefined);
    });

    it('skips to the next route when the Host header does not match', function () {
        const mw = hostFilter('mcp.furtenbach.se');
        assert.strictEqual(runHost(mw, mockReq({ headers: { host: 'other.furtenbach.se' } })), 'route');
        assert.strictEqual(runHost(mw, mockReq({ headers: {} })), 'route');   // missing host
    });

    it('matches host case-insensitively', function () {
        const mw = hostFilter('MCP.Furtenbach.SE');
        assert.strictEqual(runHost(mw, mockReq({ headers: { host: 'mcp.furtenbach.se' } })), undefined);
    });

    it('treats the port as part of the host', function () {
        const mw = hostFilter('mcp.furtenbach.se:8443');
        assert.strictEqual(runHost(mw, mockReq({ headers: { host: 'mcp.furtenbach.se:8443' } })), undefined);
        assert.strictEqual(runHost(mw, mockReq({ headers: { host: 'mcp.furtenbach.se' } })), 'route');
    });
});

describe('lib/httpGuards removeOwnedRoutes', function () {
    // Express-router shape: router.stack is a list of layers; a route layer carries
    // { route: { path, methods, stack: [{ handle }] } }. Ownership sits on a middleware
    // tagged with _mcpOwner, the way the registration sites tag their hostFilter guard.
    function routeLayer(method, path, ownerId) {
        const handle = () => {};
        if (ownerId !== undefined) handle._mcpOwner = ownerId;
        return { route: { path, methods: { [method]: true }, stack: [{ handle }] } };
    }

    it('removes only the owner\'s route when two nodes share a path (Host-split)', function () {
        const router = { stack: [
            routeLayer('post', '/mcp', 'nodeA'),
            routeLayer('post', '/mcp', 'nodeB')
        ] };
        removeOwnedRoutes(router, 'post', '/mcp', 'nodeA');
        assert.strictEqual(router.stack.length, 1);
        assert.strictEqual(router.stack[0].route.stack[0].handle._mcpOwner, 'nodeB');
    });

    it('leaves untagged routes and other methods/paths alone', function () {
        const router = { stack: [
            { name: 'query' },                                  // non-route layer
            routeLayer('post', '/mcp', undefined),              // someone else's, untagged
            routeLayer('get',  '/mcp', 'nodeA'),                // same path, other method
            routeLayer('post', '/other', 'nodeA'),              // same owner, other path
            routeLayer('post', '/mcp', 'nodeA')
        ] };
        removeOwnedRoutes(router, 'post', '/mcp', 'nodeA');
        assert.strictEqual(router.stack.length, 4);
    });

    it('tolerates a missing or shapeless router', function () {
        assert.doesNotThrow(() => removeOwnedRoutes(undefined, 'post', '/mcp', 'x'));
        assert.doesNotThrow(() => removeOwnedRoutes({}, 'post', '/mcp', 'x'));
    });
});

describe('lib/httpGuards host registry', function () {
    // Express in miniature: routes tried in registration order, next('route') moves on, plain
    // next() means this route answers.
    function dispatch(routes, host, method = 'POST', path = '/mcp') {
        for (const r of routes) {
            if (r.path !== path) continue;
            let arg = 'NOT_CALLED';
            r.mw({ headers: { host }, method, route: { path } }, mockRes(), a => { arg = a; });
            if (arg === undefined) return r.name;
        }
        return null;
    }
    function setup(order) {
        const registry = hostRegistry({});
        const make = {
            filtered  : () => { registry.claim('f', 'admin.example.com', [['POST', '/mcp']]);
                return { name: 'filtered', path: '/mcp', mw: hostFilter('admin.example.com', registry) }; },
            unfiltered: () => { registry.claim('u', '', [['POST', '/mcp']]);
                return { name: 'unfiltered', path: '/mcp', mw: hostFilter('', registry) }; }
        };
        return { registry, routes: order.map(n => make[n]()) };
    }

    for (const order of [['filtered', 'unfiltered'], ['unfiltered', 'filtered']]) {
        it('lets the filtered server win its hostname with ' + order[0] + ' registered first', function () {
            const { routes } = setup(order);
            assert.strictEqual(dispatch(routes, 'admin.example.com'), 'filtered');
            assert.strictEqual(dispatch(routes, 'ADMIN.example.com'), 'filtered');
            assert.strictEqual(dispatch(routes, 'other.example.com'), 'unfiltered');
        });
    }

    it('gives the hostname back to the unfiltered server once the filtered one releases it', function () {
        const { registry, routes } = setup(['unfiltered', 'filtered']);
        registry.release('f');
        assert.strictEqual(dispatch(routes.filter(r => r.name === 'unfiltered'), 'admin.example.com'), 'unfiltered');
    });

    it('scopes a claim to its own routes, and treats HEAD as GET', function () {
        const registry = hostRegistry({});
        registry.claim('f', 'admin.example.com', [['GET', '/.well-known/x']]);
        assert.strictEqual(registry.claimed('POST /mcp', 'admin.example.com'), false);
        assert.strictEqual(registry.claimed('GET /.well-known/x', 'admin.example.com'), true);
        const mw = hostFilter('', registry);
        let arg = 'NOT_CALLED';
        mw({ headers: { host: 'admin.example.com' }, method: 'HEAD', route: { path: '/.well-known/x' } }, mockRes(), a => { arg = a; });
        assert.strictEqual(arg, 'route');
    });

    it('is one registry per router holder, found again by its symbol', function () {
        const holder = {};
        assert.strictEqual(hostRegistry(holder), hostRegistry(holder));
        assert.strictEqual(holder[Symbol.for('node-red-mcp.hostRegistry')], hostRegistry(holder));
        assert.notStrictEqual(hostRegistry({}), hostRegistry(holder));
    });
});

describe('lib/httpGuards maxBody', function () {
    it('413s payloads over the cap and passes those under it', function () {
        const { maxBody } = createHttpGuards({});
        const mw = maxBody(100);
        const over = run(mw, mockReq({ headers: { 'content-length': '101' } }));
        assert.strictEqual(over.passed, false);
        assert.strictEqual(over.res.statusCode, 413);
        assert.strictEqual(over.res.body.error, 'payload_too_large');
        assert.strictEqual(run(mw, mockReq({ headers: { 'content-length': '100' } })).passed, true);
        assert.strictEqual(run(mw, mockReq()).passed, true);   // no header at all
    });
});

describe('lib/httpGuards jsonBody', function () {
    // Node-RED parses bodies only in its admin app and in http-in nodes. Routes on RED.httpNode
    // got the admin app's parser only while the editor sat at '/', so with it moved to '/editor'
    // every MCP call arrived with req.body undefined.
    const { PassThrough } = require('node:stream');

    function post(body, headers, prior) {
        const req = Object.assign(new PassThrough(),
            { headers: Object.assign({ 'content-type': 'application/json' }, headers) }, prior);
        const res = mockRes();
        const { jsonBody } = createHttpGuards({});
        return new Promise(resolve => {
            res.json = function (b) { this.body = b; resolve({ req, res, passed: false }); return this; };
            jsonBody(64)(req, res, () => resolve({ req, res, passed: true }));
            if (body !== null) req.end(body);
        });
    }

    it('parses a JSON body and marks it parsed', async function () {
        const { req, passed } = await post('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
        assert.strictEqual(passed, true);
        assert.deepStrictEqual(req.body, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        assert.strictEqual(req._body, true);
    });

    it('accepts a JSON media type with parameters', async function () {
        const { req, passed } = await post('{"a":1}', { 'content-type': 'application/json; charset=utf-8' });
        assert.strictEqual(passed, true);
        assert.deepStrictEqual(req.body, { a: 1 });
    });

    it('leaves a body that something upstream already parsed alone', async function () {
        const { req, passed } = await post(null, {}, { _body: true, body: { kept: true } });
        assert.strictEqual(passed, true);
        assert.deepStrictEqual(req.body, { kept: true });
    });

    it('leaves a non-JSON body alone', async function () {
        const { req, passed } = await post(null, { 'content-type': 'text/plain' });
        assert.strictEqual(passed, true);
        assert.strictEqual(req.body, undefined);
    });

    it('gives an empty body as an empty object', async function () {
        const { req, passed } = await post('');
        assert.strictEqual(passed, true);
        assert.deepStrictEqual(req.body, {});
    });

    it('answers malformed JSON with a JSON-RPC parse error', async function () {
        const { res, passed } = await post('{"jsonrpc":');
        assert.strictEqual(passed, false);
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.error.code, -32700);
    });

    it('caps a body without Content-Length while reading', async function () {
        // maxBody only reads the header, so a chunked request passes it; this is the backstop.
        const { res, passed } = await post(JSON.stringify({ pad: 'x'.repeat(100) }));
        assert.strictEqual(passed, false);
        assert.strictEqual(res.statusCode, 413);
    });
});

'use strict';

const assert = require('node:assert');
const { createHttpGuards } = require('../lib/httpGuards');

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

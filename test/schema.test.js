'use strict';

const assert = require('node:assert');
const { validateArgs, withoutNulls, unsupportedKeywords, invalidPatterns } = require('../lib/schema');

// The Seerr and Calibre example schemas, the kind that built URLs from unchecked values in 2.x.
const seerrGetTv = { type: 'object', required: ['tmdbId'], properties: { tmdbId: { type: 'integer', description: 'TMDB ID' } } };
const seerrRequest = { type: 'object', required: ['mediaId', 'mediaType'], properties: {
    mediaId: { type: 'integer' }, mediaType: { type: 'string', enum: ['movie', 'tv'] },
    seasons: { type: 'array', items: { type: 'integer' } }, is4k: { type: 'boolean' } } };

describe('lib/schema validateArgs', function () {
    it('accepts arguments that match', function () {
        assert.deepStrictEqual(validateArgs(seerrGetTv, { tmdbId: 1399 }), []);
        assert.deepStrictEqual(validateArgs(seerrRequest, { mediaId: 1, mediaType: 'tv', seasons: [1, 2] }), []);
    });

    it('refuses a path where an integer belongs — the 2.x path injection', function () {
        const problems = validateArgs(seerrGetTv, { tmdbId: '../../settings/main' });
        assert.strictEqual(problems.length, 1);
        assert.ok(problems[0].startsWith('tmdbId must be an integer, got string'), problems[0]);
        assert.strictEqual(validateArgs(seerrGetTv, { tmdbId: 1.5 })[0], 'tmdbId must be an integer, got 1.5');
        assert.strictEqual(validateArgs(seerrGetTv, { tmdbId: true })[0], 'tmdbId must be an integer, got true');
        assert.strictEqual(validateArgs(seerrGetTv, { tmdbId: [1] })[0], 'tmdbId must be an integer, got array');
    });

    it('names missing required arguments, wrong enums and wrong item types', function () {
        assert.deepStrictEqual(validateArgs(seerrRequest, {}), ['mediaId is required', 'mediaType is required']);
        assert.ok(validateArgs(seerrRequest, { mediaId: 1, mediaType: 'music' })[0].includes('one of "movie", "tv"'));
        assert.ok(validateArgs(seerrRequest, { mediaId: 1, mediaType: 'tv', seasons: [1, 'x'] })[0].startsWith('seasons[1] must be an integer'));
    });

    it('checks bounds, lengths, patterns and array sizes', function () {
        const s = { type: 'object', properties: {
            n: { type: 'number', minimum: 1, maximum: 10, exclusiveMaximum: 10 },
            s: { type: 'string', minLength: 2, maxLength: 3, pattern: '^[a-z]+$' },
            a: { type: 'array', minItems: 1, maxItems: 2 } } };
        assert.deepStrictEqual(validateArgs(s, { n: 5, s: 'ab', a: [1] }), []);
        assert.ok(validateArgs(s, { n: 0 })[0].includes('at least 1'));
        assert.ok(validateArgs(s, { n: 10 }).some(p => p.includes('less than 10')));
        assert.ok(validateArgs(s, { s: 'a' })[0].includes('at least 2 characters'));
        assert.ok(validateArgs(s, { s: 'ABC' })[0].includes('must match'));
        assert.ok(validateArgs(s, { a: [] })[0].includes('at least 1 items'));
        assert.ok(validateArgs(s, { a: [1, 2, 3] })[0].includes('at most 2 items'));
    });

    it('allows unknown arguments unless additionalProperties is false', function () {
        assert.deepStrictEqual(validateArgs(seerrGetTv, { tmdbId: 1, extra: 'x' }), []);
        const closed = { ...seerrGetTv, additionalProperties: false };
        assert.deepStrictEqual(validateArgs(closed, { tmdbId: 1, extra: 'x' }), ['extra is not a known argument']);
        const typed = { type: 'object', additionalProperties: { type: 'string' } };
        assert.ok(validateArgs(typed, { a: 1 })[0].startsWith('a must be a string'));
    });

    it('takes a bare properties map, multiple types, const, nulls and nested objects', function () {
        assert.ok(validateArgs({ id: { type: 'string' } }, { id: 3 })[0].startsWith('id must be a string'));
        assert.deepStrictEqual(validateArgs({ type: 'object', properties: { v: { type: ['string', 'null'] } } }, { v: null }), []);
        assert.ok(validateArgs({ type: 'object', properties: { k: { const: 'x' } } }, { k: 'y' })[0].includes('must be "x"'));
        const nested = { type: 'object', properties: { p: { type: 'object', required: ['q'], properties: { q: { type: 'boolean' } } } } };
        assert.deepStrictEqual(validateArgs(nested, { p: {} }), ['p.q is required']);
        assert.ok(validateArgs(nested, { p: { q: 'yes' } })[0].startsWith('p.q must be a boolean'));
    });

    it('treats missing arguments as {}, and refuses non-object arguments for an object schema', function () {
        assert.deepStrictEqual(validateArgs(seerrGetTv, undefined), ['tmdbId is required']);
        assert.ok(validateArgs(seerrGetTv, 'x')[0].startsWith('arguments must be an object'));
    });

    it('takes null for an optional argument as not sent, but not for a required one', function () {
        const s = { type: 'object', required: ['id'], properties: { id: { type: 'string' }, room: { type: 'string' } } };
        assert.deepStrictEqual(validateArgs(s, { id: 'a', room: null }), []);
        assert.ok(validateArgs(s, { id: null })[0].startsWith('id must be a string, got null'));
    });

    it('takes null as not sent for enum-only and additionalProperties arguments too, unless null is allowed', function () {
        assert.deepStrictEqual(validateArgs({ type: 'object', properties: { m: { enum: ['a', 'b'] } } }, { m: null }), []);
        assert.ok(validateArgs({ type: 'object', properties: { m: { enum: ['a', null] } } }, { m: 'c' })[0].includes('one of'));
        assert.deepStrictEqual(validateArgs({ type: 'object', additionalProperties: { type: 'string' } }, { x: null }), []);
        assert.deepStrictEqual(validateArgs({ type: 'object', additionalProperties: false }, { x: null }), ['x is not a known argument']);
    });

    it('compiles a pattern valid only outside unicode mode, such as an escaped dash', function () {
        const s = { type: 'object', properties: { d: { type: 'string', pattern: '^\\d{4}\\-\\d{2}$' } } };
        assert.deepStrictEqual(validateArgs(s, { d: '2026-10' }), []);
        assert.ok(validateArgs(s, { d: '2026/10' })[0].includes('must match'));
    });

    it('reports a pattern that is not a regular expression instead of throwing', function () {
        assert.ok(validateArgs({ type: 'object', properties: { s: { type: 'string', pattern: '(' } } }, { s: 'a' })[0].includes('not a valid regular expression'));
    });

    it('stops at ten problems', function () {
        const s = { type: 'object', required: Array.from({ length: 20 }, (_, i) => 'a' + i) };
        assert.strictEqual(validateArgs(s, {}).length, 10);
    });
});

describe('lib/schema unsupportedKeywords', function () {
    it('names what is not checked, nested too, and ignores annotations', function () {
        assert.deepStrictEqual(unsupportedKeywords(seerrRequest), []);
        assert.deepStrictEqual(unsupportedKeywords({ type: 'object', properties: {
            a: { type: 'string', format: 'email', description: 'x' }, b: { anyOf: [] } } }).sort(), ['anyOf', 'format']);
    });
});

describe('lib/schema withoutNulls', function () {
    const s = { type: 'object', required: ['id'], properties: {
        id: { type: 'string' }, types: { type: 'array' }, n: { type: ['string', 'null'] },
        o: { type: 'object', properties: { q: { type: 'string' } } } } };

    it('removes the nulls the check counted as not sent, nested too, and keeps allowed ones', function () {
        assert.deepStrictEqual(withoutNulls(s, { id: 'x', types: null, n: null, o: { q: null } }), { id: 'x', n: null, o: {} });
    });

    it('returns the same object when there is nothing to remove, and does not mutate its input', function () {
        const args = { id: 'x', o: { q: 'y' } };
        assert.strictEqual(withoutNulls(s, args), args);
        const withNull = { id: 'x', types: null };
        withoutNulls(s, withNull);
        assert.deepStrictEqual(withNull, { id: 'x', types: null });
    });
});

describe('lib/schema invalidPatterns', function () {
    it('names patterns that compile in neither syntax, nested too', function () {
        assert.deepStrictEqual(invalidPatterns({ type: 'object', properties: {
            a: { type: 'string', pattern: '\\-' }, b: { type: 'array', items: { type: 'string', pattern: '(' } } } }), ['(']);
        assert.deepStrictEqual(invalidPatterns(seerrRequest), []);
        // Compiles without the flag, but \\p{Lu} would then mean the letters p{Lu}: not taken.
        assert.deepStrictEqual(invalidPatterns({ type: 'object', properties: { a: { type: 'string', pattern: '^\\p{Lu}\\-\\d$' } } }), ['^\\p{Lu}\\-\\d$']);
    });
});

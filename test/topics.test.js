'use strict';

const assert = require('node:assert');
const { matchTopic, fixTopic, TOPIC_MATCHERS, applyFilters } = require('../lib/topics');

describe('lib/topics matchTopic (MQTT wildcards)', function () {
    it('# matches anything', function () {
        assert.strictEqual(matchTopic('#', 'a/b/c'), true);
    });
    it('+ matches exactly one level', function () {
        assert.strictEqual(matchTopic('a/+/c', 'a/b/c'), true);
        assert.strictEqual(matchTopic('a/+/c', 'a/b/x'), false);
        assert.strictEqual(matchTopic('a/+/c', 'a/b/d/c'), false);
    });
    it('trailing /# matches the prefix and any subtree', function () {
        assert.strictEqual(matchTopic('a/#', 'a'), true);
        assert.strictEqual(matchTopic('a/#', 'a/b/c'), true);
        assert.strictEqual(matchTopic('a/#', 'b/c'), false);
    });
    it('exact topics match literally', function () {
        assert.strictEqual(matchTopic('a/b', 'a/b'), true);
        assert.strictEqual(matchTopic('a/b', 'a/c'), false);
    });
    it('strips a $share prefix before matching', function () {
        assert.strictEqual(matchTopic('$share/grp/a/b', 'a/b'), true);
    });
});

describe('lib/topics fixTopic (prefix resolution)', function () {
    it('replaces a leading dot with the configured topic', function () {
        assert.strictEqual(fixTopic('./suffix', 'base'), 'base/suffix');
    });
    it('prepends the configured topic for a leading slash', function () {
        assert.strictEqual(fixTopic('/suffix', 'base'), 'base/suffix');
    });
    it('leaves other topics untouched', function () {
        assert.strictEqual(fixTopic('plain/topic', 'base'), 'plain/topic');
    });
});

describe('lib/topics TOPIC_MATCHERS', function () {
    it('str / StrStart / StrEnd / StrContain', function () {
        assert.strictEqual(TOPIC_MATCHERS.str('abc', 'abc'), true);
        assert.strictEqual(TOPIC_MATCHERS.StrStart('abcdef', 'abc'), true);
        assert.strictEqual(TOPIC_MATCHERS.StrEnd('abcdef', 'def'), true);
        assert.strictEqual(TOPIC_MATCHERS.StrContain('abcdef', 'cde'), true);
    });
    it('re matches against a pattern string', function () {
        assert.strictEqual(TOPIC_MATCHERS.re('abc', '^a'), true);
        assert.strictEqual(TOPIC_MATCHERS.re('abc', '^z'), false);
    });
});

describe('lib/topics applyFilters', function () {
    const getProp = (msg, field) => field.split('.').reduce((o, k) => (o == null ? o : o[k]), msg);

    it('empty filter list always matches', function () {
        assert.strictEqual(applyFilters({}, [], 'and', '', getProp), true);
    });

    it('and-mode requires every filter to pass', function () {
        const msg = { topic: 'home/kitchen', payload: { type: 'x' } };
        const pass = [
            { field: 'topic', matchType: 'StrStart', value: 'home/' },
            { field: 'payload.type', matchType: 'str', value: 'x' }
        ];
        const fail = [
            { field: 'topic', matchType: 'StrStart', value: 'home/' },
            { field: 'payload.type', matchType: 'str', value: 'y' }
        ];
        assert.strictEqual(applyFilters(msg, pass, 'and', '', getProp), true);
        assert.strictEqual(applyFilters(msg, fail, 'and', '', getProp), false);
    });

    it('or-mode passes when any filter matches', function () {
        const msg = { topic: 'home/kitchen' };
        const filters = [
            { field: 'topic', matchType: 'str', value: 'nope' },
            { field: 'topic', matchType: 'StrEnd', value: 'kitchen' }
        ];
        assert.strictEqual(applyFilters(msg, filters, 'or', '', getProp), true);
    });

    it('resolves a topic prefix for str topic filters', function () {
        const msg = { topic: 'base/light' };
        const filters = [{ field: 'topic', matchType: 'str', value: '/light' }];
        assert.strictEqual(applyFilters(msg, filters, 'and', 'base', getProp), true);
    });
});

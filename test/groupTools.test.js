'use strict';
const assert = require('node:assert');
const gt = require('../lib/group-tools');

const msToIso = ms => (typeof ms === 'number' && ms > 0) ? new Date(ms).toISOString() : null;

// Registry entries as node.getGroups() produces them.
const info = (o) => Object.assign({
    id: 'g1', name: 'Group', haType: '', notes: '', tags: [],
    aggregate: null, ratelimit: 0, stateMembers: 0, commandMembers: 0
}, o);

// State records as node.getGroupState() produces them.
const state = (o) => Object.assign({
    state: undefined, laststate: undefined, last_update: 0, last_change: 0,
    members: 0, live: 0, fn: null, name: 'Group'
}, o);

const SENSORS = info({ id: 'temp', name: 'Temperatur inne', haType: 'temperature',
                       aggregate: 'median', stateMembers: 9, commandMembers: 0,
                       notes: 'all indoor rooms', tags: ['inne', 'klimat'] });
const LIGHTS  = info({ id: 'lights', name: 'Alla lampor', haType: 'light',
                       aggregate: 'anyTrue', stateMembers: 12, commandMembers: 12 });
const SCENE   = info({ id: 'night', name: 'Natt (Släck lampor)', haType: 'light',
                       aggregate: null, stateMembers: 0, commandMembers: 8 });
// The common real case: switchable members that report back, with nobody having picked a
// default function. Readable, but only if you say what to compute.
const UNSET   = info({ id: 'alla', name: 'Alla lampor', haType: 'light',
                       aggregate: null, stateMembers: 39, commandMembers: 39 });

describe('group-tools groupEntry', function () {
    it('shapes a readable group with its value and how it was computed', function () {
        const e = gt.groupEntry(SENSORS, state({ state: 25.68, members: 9, live: 9, last_change: 1000 }), msToIso);
        assert.strictEqual(e.group_id, 'temp');
        assert.strictEqual(e.name, 'Temperatur inne');
        assert.strictEqual(e.ha_type, 'temperature');
        assert.strictEqual(e.value, 25.68);
        assert.strictEqual(e.function, 'median');
        assert.strictEqual(e.members, 9);
        assert.strictEqual(e.live, 9);
        assert.strictEqual(e.readable, true);
        assert.strictEqual(e.last_change, new Date(1000).toISOString());
    });

    it('omits the value key entirely when nothing is reporting', function () {
        // Not null: a null reads as "the value is nothing", which is a different claim from
        // "no live member is answering". This is the case a silent group must not lie about.
        const e = gt.groupEntry(SENSORS, state({ state: undefined, members: 9, live: 0 }), msToIso);
        assert.ok(!('value' in e), 'no value key');
        assert.strictEqual(e.readable, true, 'still a readable group — it just has nothing to say');
        assert.strictEqual(e.live, 0);
        assert.strictEqual(e.members, 9);
    });

    it('a group with state members but no configured function is readable and has no value', function () {
        // The case that made the function parameter worth having: 39 members that could answer,
        // and nothing to report until someone says what to compute.
        const e = gt.groupEntry(UNSET, undefined, msToIso);
        assert.strictEqual(e.readable, true);
        assert.strictEqual(e.members, 39);
        assert.ok(!('value' in e));
        assert.ok(!('function' in e), 'no function to report — none configured, none asked for');
    });

    it('computes a function asked for on the call', function () {
        const e = gt.groupEntry(UNSET, undefined, msToIso,
                                { value: true, live: 37, members: 39, fn: 'anyTrue' });
        assert.strictEqual(e.value, true);
        assert.strictEqual(e.function, 'anyTrue');
        assert.strictEqual(e.live, 37);
        assert.ok(!('configured_function' in e), 'nothing configured to differ from');
        assert.ok(!('last_change' in e), 'only tracked for the configured function');
    });

    it('names the configured function when a different one was asked for', function () {
        // Otherwise a reply computed with allTrue would look like the group's own setting.
        const e = gt.groupEntry(SENSORS, state({ state: 25.68 }), msToIso,
                                { value: 19.1, live: 9, members: 9, fn: 'min' });
        assert.strictEqual(e.function, 'min');
        assert.strictEqual(e.value, 19.1);
        assert.strictEqual(e.configured_function, 'median');
    });

    it('omits the value when the function asked for suits nothing in the group', function () {
        // average over booleans, say: the module returns undefined and the entry stays silent
        // rather than inventing a number.
        const e = gt.groupEntry(UNSET, undefined, msToIso,
                                { value: undefined, live: 39, members: 39, fn: 'average' });
        assert.ok(!('value' in e));
        assert.strictEqual(e.function, 'average');
        assert.strictEqual(e.live, 39);
    });

    it('a command-only group is not readable and carries no value fields', function () {
        const e = gt.groupEntry(SCENE, undefined, msToIso);
        assert.strictEqual(e.readable, false);
        assert.strictEqual(e.controllable, true);
        assert.ok(!('value' in e));
        assert.ok(!('function' in e));
        assert.ok(!('members' in e));
    });

    it('keeps readable and controllable independent', function () {
        // The distinction the whole design rests on: reading uses the state-capable members,
        // commanding the command-capable ones, and either set can be empty.
        const sensors = gt.groupEntry(SENSORS, state({ state: 21 }), msToIso);
        assert.deepStrictEqual([sensors.readable, sensors.controllable], [true, false]);

        const lights = gt.groupEntry(LIGHTS, state({ state: true, members: 12, live: 11 }), msToIso);
        assert.deepStrictEqual([lights.readable, lights.controllable], [true, true]);

        const scene = gt.groupEntry(SCENE, undefined, msToIso);
        assert.deepStrictEqual([scene.readable, scene.controllable], [false, true]);

        const orphan = gt.groupEntry(info({ stateMembers: 0, commandMembers: 0 }), undefined, msToIso);
        assert.deepStrictEqual([orphan.readable, orphan.controllable], [false, false]);

        // Readable rests on having state members, not on a function having been picked.
        const unset = gt.groupEntry(UNSET, undefined, msToIso);
        assert.deepStrictEqual([unset.readable, unset.controllable], [true, true]);
    });

    it('carries notes and tags only when they exist', function () {
        const withBoth = gt.groupEntry(SENSORS, state({ state: 21 }), msToIso);
        assert.strictEqual(withBoth.notes, 'all indoor rooms');
        assert.deepStrictEqual(withBoth.tags, ['inne', 'klimat']);

        const without = gt.groupEntry(LIGHTS, state({ state: true }), msToIso);
        assert.ok(!('notes' in without));
        assert.ok(!('tags' in without), 'an empty tag list is absent, not []');
    });

    it('reports live as 0 rather than guessing when there is no state record', function () {
        const e = gt.groupEntry(info({ aggregate: 'average', stateMembers: 4 }), undefined, msToIso);
        assert.strictEqual(e.members, 4);
        assert.strictEqual(e.live, 0);
        assert.strictEqual(e.last_change, null);
    });
});

describe('group-tools matchesFilters', function () {
    const all = [SENSORS, LIGHTS, SCENE];
    const filter = args => all.filter(g => gt.matchesFilters(g, args));

    it('matches a partial, case-insensitive name', function () {
        assert.deepStrictEqual(filter({ group_name: 'lampor' }).map(g => g.id), ['lights', 'night']);
        assert.deepStrictEqual(filter({ group_name: 'TEMPERATUR' }).map(g => g.id), ['temp']);
    });

    it('matches ha_type case-insensitively', function () {
        assert.deepStrictEqual(filter({ ha_type: 'light' }).map(g => g.id), ['lights', 'night']);
        assert.deepStrictEqual(filter({ ha_type: 'Temperature' }).map(g => g.id), ['temp']);
        assert.deepStrictEqual(filter({ ha_type: 'cover' }), []);
    });

    it('expands category aliases the same way get_all_states does', function () {
        // ha_type="light" has to reach a dimmer group here exactly as it reaches a dimmer
        // device there, or the same parameter would mean two different things.
        const dimmers = info({ id: 'dim', name: 'Dimmers', haType: 'dimmer', aggregate: 'average' });
        const withDim = [...all, dimmers];
        const expand = ha => new Set(ha === 'light' ? ['light', 'dimmer'] : [ha.toLowerCase()]);
        const ids = withDim.filter(g => gt.matchesFilters(g, { ha_type: 'light' }, expand)).map(g => g.id);
        assert.deepStrictEqual(ids, ['lights', 'night', 'dim']);
        // Without an expander it stays a literal match, so the module works standalone.
        assert.deepStrictEqual(
            withDim.filter(g => gt.matchesFilters(g, { ha_type: 'light' })).map(g => g.id),
            ['lights', 'night']);
    });

    it('filters to one group by exact id', function () {
        assert.deepStrictEqual(filter({ group_id: 'temp' }).map(g => g.id), ['temp']);
        assert.deepStrictEqual(filter({ group_id: 'nope' }), []);
    });

    it('matches a tag exactly, case-insensitively', function () {
        assert.deepStrictEqual(filter({ tag: 'inne' }).map(g => g.id), ['temp']);
        assert.deepStrictEqual(filter({ tag: 'INNE' }).map(g => g.id), ['temp']);
        assert.deepStrictEqual(filter({ tag: 'in' }), [], 'a tag is exact, not a substring');
    });

    it('combines filters, and no filter passes everything', function () {
        assert.deepStrictEqual(filter({ ha_type: 'light', group_name: 'natt' }).map(g => g.id), ['night']);
        assert.deepStrictEqual(filter({}).length, 3);
    });
});

describe('group-tools resolveGroup', function () {
    const all = [SENSORS, LIGHTS, SCENE];

    it('finds a group by exact id', function () {
        assert.strictEqual(gt.resolveGroup(all, { group_id: 'lights' }).group, LIGHTS);
    });

    it('finds a group by partial name when it is unambiguous', function () {
        assert.strictEqual(gt.resolveGroup(all, { group_name: 'temperatur' }).group, SENSORS);
        assert.strictEqual(gt.resolveGroup(all, { group_name: 'NATT' }).group, SCENE);
    });

    it('refuses an ambiguous name instead of guessing', function () {
        // Commanding the wrong group is not something reading the answer can undo.
        const r = gt.resolveGroup(all, { group_name: 'lampor' });
        assert.ok(!r.group);
        assert.match(r.error.error, /Several groups match/);
        assert.deepStrictEqual(r.error.matches.map(m => m.group_id), ['lights', 'night']);
    });

    it('answers an unknown group with the ones that exist', function () {
        for (const args of [{ group_id: 'nope' }, { group_name: 'nope' }, {}]) {
            const r = gt.resolveGroup(all, args);
            assert.ok(!r.group, JSON.stringify(args));
            assert.deepStrictEqual(r.error.available_groups.map(g => g.group_id),
                ['temp', 'lights', 'night'], JSON.stringify(args));
        }
    });

    it('prefers group_id when both are given', function () {
        assert.strictEqual(gt.resolveGroup(all, { group_id: 'temp', group_name: 'lampor' }).group, SENSORS);
    });
});

describe('group-tools commandRefusal', function () {
    const all = [SENSORS, LIGHTS, SCENE];

    it('allows a group that has commandable members', function () {
        assert.strictEqual(gt.commandRefusal(LIGHTS, all), null);
        assert.strictEqual(gt.commandRefusal(SCENE, all), null);
    });

    it('refuses a report-only group and says which ones can be commanded', function () {
        const r = gt.commandRefusal(SENSORS, all);
        assert.match(r.error, /only reports/);
        assert.strictEqual(r.group_id, 'temp');
        assert.deepStrictEqual(r.controllable_groups.map(g => g.group_id), ['lights', 'night']);
    });
});

describe('group-tools functionMismatch', function () {
    const kinds = (numbers, booleans) => ({ numbers, booleans, reporting: numbers + booleans });
    const NUMERIC = ['latest', 'min', 'max', 'average', 'median', 'sum', 'range'];
    const BOOLEAN = ['latest', 'anyTrue', 'allTrue', 'anyFalse', 'allFalse', 'countTrue', 'countFalse', 'percentTrue'];

    it('refuses a boolean function over members that report numbers', function () {
        // The case that prompted this: allTrue over a temperature group is not false, it is a
        // question that does not apply — and answering false would be believed.
        const r = gt.functionMismatch(SENSORS, 'allTrue', kinds(9, 0), NUMERIC);
        assert.match(r.error, /"allTrue" does not apply/);
        assert.match(r.error, /ha_type temperature/);
        assert.match(r.error, /hold numbers/);
        assert.deepStrictEqual(r.suitable_functions, NUMERIC);
        assert.strictEqual(r.group_id, 'temp');
    });

    it('refuses a numeric function over members that report true/false', function () {
        const r = gt.functionMismatch(LIGHTS, 'average', kinds(0, 12), BOOLEAN);
        assert.match(r.error, /"average" does not apply/);
        assert.match(r.error, /true\/false/);
        assert.deepStrictEqual(r.suitable_functions, BOOLEAN);
    });

    it('allows a function that fits some of a mixed group', function () {
        // Partial coverage answers and is disclosed by `used`; only zero coverage is refused.
        assert.strictEqual(gt.functionMismatch(LIGHTS, 'average', kinds(10, 29), NUMERIC.concat(BOOLEAN)), null);
        assert.strictEqual(gt.functionMismatch(LIGHTS, 'anyTrue', kinds(10, 29), NUMERIC.concat(BOOLEAN)), null);
    });

    it('says so when nothing is reporting at all, rather than blaming the function', function () {
        const r = gt.functionMismatch(SENSORS, 'average', kinds(0, 0), []);
        assert.match(r.error, /no member reporting a value/);
        assert.strictEqual(r.members, 9);
    });

    it('is silent when no function was asked for', function () {
        assert.strictEqual(gt.functionMismatch(SENSORS, null, kinds(9, 0), NUMERIC), null);
    });

    it('describes a mixed group by both kinds', function () {
        const r = gt.functionMismatch(LIGHTS, 'sum', kinds(3, 4), ['latest']);
        assert.match(r.error, /3 report numbers and 4 report true\/false/);
    });
});

describe('group-tools groupEntry used', function () {
    it('reports used only when the function covered part of the group', function () {
        const partial = gt.groupEntry(LIGHTS, undefined, msToIso,
            { value: 25.4, live: 39, used: 10, members: 39, fn: 'average' });
        assert.strictEqual(partial.used, 10, 'a mean over 10 of 39 must not read as the group');
        assert.strictEqual(partial.live, 39);

        const full = gt.groupEntry(LIGHTS, undefined, msToIso,
            { value: true, live: 12, used: 12, members: 12, fn: 'anyTrue' });
        assert.ok(!('used' in full), 'nothing to disclose when every member counted');
    });
});

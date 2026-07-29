'use strict';
const assert = require('node:assert');
const t = require('../resources/bayes-time');

// Fixed instants in local time. 2026-07-27 is a Monday, so +n days walks the week.
// Note the container runs TZ=Europe/Stockholm; these Dates are constructed in local time
// exactly as the runtime's `new Date()` would be.
const at = (dayOffset, hh, mm) => new Date(2026, 6, 27 + dayOffset, hh, mm, 0);
const MON = 0, TUE = 1, FRI = 4, SAT = 5, SUN = 6;

const WEEKDAYS = [1, 2, 3, 4, 5];          // getDay(): Mon–Fri
const ALL = [0, 1, 2, 3, 4, 5, 6];

describe('bayes-time parseHHMM', function() {
    it('accepts valid 24-hour times', function() {
        assert.strictEqual(t.parseHHMM('00:00'), 0);
        assert.strictEqual(t.parseHHMM('09:05'), 545);
        assert.strictEqual(t.parseHHMM('22:00'), 1320);
        assert.strictEqual(t.parseHHMM('23:59'), 1439);
        assert.strictEqual(t.parseHHMM(' 08:30 '), 510);      // tolerates padding
    });

    it('rejects anything else', function() {
        for (const bad of ['24:00', '9:5', '9:05', '08:60', '', 'nope', null, undefined, 830, '08.30']) {
            assert.strictEqual(t.parseHHMM(bad), null, 'should reject ' + JSON.stringify(bad));
        }
    });
});

describe('bayes-time inWindow', function() {
    it('same-day window is start-inclusive and end-exclusive', function() {
        const w = { start: '08:00', end: '17:00', days: ALL };
        assert.strictEqual(t.inWindow(at(MON, 8, 0), w), true);
        assert.strictEqual(t.inWindow(at(MON, 16, 59), w), true);
        assert.strictEqual(t.inWindow(at(MON, 17, 0), w), false);
        assert.strictEqual(t.inWindow(at(MON, 7, 59), w), false);
    });

    it('crosses midnight', function() {
        const w = { start: '22:00', end: '06:00', days: ALL };
        assert.strictEqual(t.inWindow(at(MON, 22, 0), w), true);
        assert.strictEqual(t.inWindow(at(MON, 23, 59), w), true);
        assert.strictEqual(t.inWindow(at(MON, 0, 0), w), true);
        assert.strictEqual(t.inWindow(at(MON, 5, 59), w), true);
        assert.strictEqual(t.inWindow(at(MON, 6, 0), w), false);
        assert.strictEqual(t.inWindow(at(MON, 21, 59), w), false);
    });

    it('weekdays are judged by the day it is right now', function() {
        // The decision that needed pinning: a night does not "belong to" the day it started.
        const w = { start: '22:00', end: '06:00', days: WEEKDAYS };
        assert.strictEqual(t.inWindow(at(MON, 23, 0), w), true);    // Monday evening
        assert.strictEqual(t.inWindow(at(TUE, 2, 0), w), true);     // Tuesday small hours
        assert.strictEqual(t.inWindow(at(SAT, 2, 0), w), false);    // Friday night, but it is Saturday
        assert.strictEqual(t.inWindow(at(SUN, 23, 0), w), false);   // Sunday evening
        assert.strictEqual(t.inWindow(at(FRI, 23, 0), w), true);
    });

    it('missing days means every day, an empty selection means never', function() {
        assert.strictEqual(t.inWindow(at(SAT, 12, 0), { start: '08:00', end: '17:00' }), true);
        assert.strictEqual(t.inWindow(at(SAT, 12, 0), { start: '08:00', end: '17:00', days: null }), true);
        assert.strictEqual(t.inWindow(at(SAT, 12, 0), { start: '08:00', end: '17:00', days: [] }), false);
    });

    it('an unparseable or zero-length window is never active', function() {
        assert.strictEqual(t.inWindow(at(MON, 12, 0), { start: '08:00', end: '08:00', days: ALL }), false);
        assert.strictEqual(t.inWindow(at(MON, 12, 0), { start: '', end: '17:00', days: ALL }), false);
        assert.strictEqual(t.inWindow(at(MON, 12, 0), { start: '25:00', end: '17:00', days: ALL }), false);
        assert.strictEqual(t.inWindow(at(MON, 12, 0), null), false);
        assert.strictEqual(t.inWindow(null, { start: '08:00', end: '17:00' }), false);
    });
});

describe('bayes-time describe', function() {
    it('renders a crossing window and a contiguous weekday run', function() {
        assert.strictEqual(t.describe({ start: '22:00', end: '06:00', days: WEEKDAYS }),
            '22:00–06:00, crosses midnight, Mo–Fr');
        assert.strictEqual(t.describe({ start: '08:00', end: '17:00', days: ALL }),
            '08:00–17:00, every day');
    });

    it('lists a scattered selection and flags degenerate windows', function() {
        assert.strictEqual(t.describeDays([6, 0]), 'Sa, Su');
        assert.strictEqual(t.describeDays([]), 'no days selected — never active');
        assert.strictEqual(t.describe({ start: '08:00', end: '08:00' }), 'start and end are equal — never active');
        assert.strictEqual(t.describe({ start: '', end: '' }), 'set a start and end time');
    });
});

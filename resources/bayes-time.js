// Time-of-day and weekday window for hal2Bayes time steps.
//
// Loaded from one source both ways, like bayes-scale.js:
//   - editor: <script src="resources/node-red-contrib-hal2/bayes-time.js"> → window.hal2BayesTime
//   - runtime/tests: require('../resources/bayes-time')
//
// Everything takes an explicit Date, so the runtime passes `new Date()` and tests pass a fixed
// instant. The container runs TZ=Europe/Stockholm, so getHours()/getDay() are local time with
// DST already applied — there is deliberately no timezone handling here.

(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) { module.exports = factory(); }
    else { root.hal2BayesTime = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Monday first for reading; the numbers are JS getDay(), where 0 is Sunday.
    var DAYS = [
        { d: 1, short: 'Mo' }, { d: 2, short: 'Tu' }, { d: 3, short: 'We' }, { d: 4, short: 'Th' },
        { d: 5, short: 'Fr' }, { d: 6, short: 'Sa' }, { d: 0, short: 'Su' }
    ];

    // '22:00' → 1320. Returns null for anything that is not a valid 24-hour HH:MM.
    function parseHHMM(s) {
        if (typeof s !== 'string') { return null; }
        var m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
        if (!m) { return null; }
        return Number(m[1]) * 60 + Number(m[2]);
    }

    // A missing days field means every day; a deliberately emptied one means never.
    function dayAllowed(days, dow) {
        if (days === undefined || days === null) { return true; }
        if (!Array.isArray(days)) { return true; }
        return days.indexOf(dow) !== -1;
    }

    // Start inclusive, end exclusive. start === end is never active — an empty window rather
    // than a whole day, so a half-filled form cannot silently match everything.
    function inWindow(date, spec) {
        if (!date || !spec) { return false; }
        var s = parseHHMM(spec.start);
        var e = parseHHMM(spec.end);
        if (s === null || e === null || s === e) { return false; }
        if (!dayAllowed(spec.days, date.getDay())) { return false; }
        var m = date.getHours() * 60 + date.getMinutes();
        return (s < e) ? (m >= s && m < e) : (m >= s || m < e);
    }

    // "22:00–06:00, crosses midnight, Mon–Fri" — for the editor's live hint.
    function describe(spec) {
        var s = parseHHMM(spec && spec.start);
        var e = parseHHMM(spec && spec.end);
        if (s === null || e === null) { return 'set a start and end time'; }
        if (s === e) { return 'start and end are equal — never active'; }
        var out = spec.start + '–' + spec.end;
        if (s > e) { out += ', crosses midnight'; }
        return out + ', ' + describeDays(spec.days);
    }

    function describeDays(days) {
        if (days === undefined || days === null || !Array.isArray(days)) { return 'every day'; }
        if (!days.length) { return 'no days selected — never active'; }
        if (days.length === 7) { return 'every day'; }
        // Collapse a contiguous Monday-first run into "Mon–Fri".
        var picked = DAYS.filter(function (x) { return days.indexOf(x.d) !== -1; });
        var idx = picked.map(function (x) { return DAYS.indexOf(x); });
        var run = idx.every(function (v, i) { return i === 0 || v === idx[i - 1] + 1; });
        if (run && picked.length > 2) { return picked[0].short + '–' + picked[picked.length - 1].short; }
        return picked.map(function (x) { return x.short; }).join(', ');
    }

    return { DAYS: DAYS, parseHHMM: parseHHMM, inWindow: inWindow, describe: describe, describeDays: describeDays };
}));

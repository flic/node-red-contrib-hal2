'use strict';
// Arrival-row expander for hal2Bayes.
//
// An "arrival" row is a sensor row of a different kind: instead of one observation it
// describes two sensors in time order — a door opening and closing again, followed by
// movement. That cannot be expressed as a single observation, so the editor stores it as
// one row and this function expands it into the ordinary rows + composite that an advanced
// user would write by hand. The runtime (core/bayes.js) and the estimator (lib/bayes.js)
// therefore need no knowledge of arrival rows at all.
//
// Expansion per arrival row:
//   <id>__door   event row, lr 1   — the door contact
//   <id>__motion event row, lr 1   — the motion sensor
//   <id>__seq    composite: door cycle within cycleMax, confirmed by motion during the open
//                phase or within confirmWindow after closing, applying the row's lr, and only
//                for a candidate (output currently off + person's sensor seen recently).
//
// Ids derived from a row id are reserved; halCreateId() (random hex) cannot collide with
// the '__door'/'__motion'/'__seq' suffixes.

const ARRIVAL_DEFAULTS = {
    lr: 30,
    cycleMax: 180,       // s — door open→closed must complete within this
    confirmWindow: 120,  // s — motion after close still confirms within this
    candidateWindow: 300 // s — how recently the person's sensor must have fired
};

function complete(sel) {
    return !!(sel && sel.thing && sel.item);
}

function num(v, dflt) {
    if (v === '' || v === null || v === undefined) { return dflt; }
    const n = Number(v);
    return isNaN(n) ? dflt : n;
}

// Pre-2.7 configs stored a single arrival as config.entry — fold it into a row so nothing
// is lost when a flow is deployed without being reopened in the editor.
function migrateLegacyEntry(config) {
    if (!config.entry || !complete(config.entry.door) || !complete(config.entry.motion)) { return null; }
    return {
        id: '__entry', kind: 'arrival',
        door: config.entry.door, motion: config.entry.motion,
        personRow: config.entry.personRow || '',
        lr: ARRIVAL_DEFAULTS.lr, cycleMax: ARRIVAL_DEFAULTS.cycleMax,
        confirmWindow: ARRIVAL_DEFAULTS.confirmWindow
    };
}

// expandArrivalRows(config) → { config, warnings }
// Non-mutating. Returns the same config object when there is nothing to expand.
function expandArrivalRows(config) {
    const rows = config.observations || [];
    const legacy = migrateLegacyEntry(config);
    const arrivals = rows.filter(r => r && r.kind === 'arrival').concat(legacy ? [legacy] : []);
    if (!arrivals.length) { return { config, warnings: [] }; }

    const warnings = [];
    const observations = rows.filter(r => !r || r.kind !== 'arrival');
    const composites = (config.composites || []).slice();
    let candidateRow = config.candidateRow || '';
    let candidateWindow = config.candidateWindow;

    for (const row of arrivals) {
        if (!complete(row.door) || !complete(row.motion)) {
            warnings.push('Arrival row is missing a door or motion sensor — ignored');
            continue;
        }
        const doorId = row.id + '__door';
        const motionId = row.id + '__motion';

        observations.push(
            { id: doorId, thing: row.door.thing, item: row.door.item, type: 'event',
              operator: 'true', value: '', valueType: 'str', lr: 1, halfLife: '', onlyAsCandidate: false },
            { id: motionId, thing: row.motion.thing, item: row.motion.item, type: 'event',
              operator: 'true', value: '', valueType: 'str', lr: 1, halfLife: '', onlyAsCandidate: false }
        );

        composites.push({
            id: row.id + '__seq', name: 'Arrival',
            armRow: doorId, armPattern: 'cycle', cycleMax: num(row.cycleMax, ARRIVAL_DEFAULTS.cycleMax),
            confirmRow: motionId, confirmWindow: num(row.confirmWindow, ARRIVAL_DEFAULTS.confirmWindow),
            confirmDuringArm: true, lr: num(row.lr, ARRIVAL_DEFAULTS.lr), onlyAsCandidate: true
        });

        // The node estimates one hypothesis, so the person's sensor is node-wide. An
        // explicitly configured candidate trigger (advanced mode) always wins.
        if (row.personRow) {
            if (config.candidateRow && config.candidateRow !== row.personRow) {
                warnings.push("Arrival row's person sensor ignored — a candidate trigger is already configured");
            } else if (candidateRow && candidateRow !== row.personRow) {
                warnings.push('Arrival rows disagree on the person sensor — using the first one');
            } else if (!candidateRow) {
                candidateRow = row.personRow;
                candidateWindow = ARRIVAL_DEFAULTS.candidateWindow;
            }
        }
    }

    return {
        config: Object.assign({}, config, { observations, composites, candidateRow, candidateWindow }),
        warnings
    };
}

module.exports = { expandArrivalRows, ARRIVAL_DEFAULTS };

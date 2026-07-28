'use strict';
// Entry-detection template expander for hal2Bayes. The simple-mode editor stores the
// template as config.entry = { door: {thing,item}, motion: {thing,item}, personRow } and
// this function expands it into ordinary observation rows + a composite, so the runtime
// (core/bayes.js normalization, feedback guard, subscriptions) and lib/bayes.js need no
// knowledge of the template. Runs on the RAW editor config (times still in seconds).
//
// The expansion reproduces the entry pattern: a door cycle (open→closed within 3 min)
// confirmed by motion (during the open phase, or within 2 min after closing) applies a
// strong boost (LR 30) — but only while the output is off and, when a person row is set,
// that row's condition fired recently (candidate window 5 min).
//
// Ids prefixed '__entry' are reserved for this expansion; halCreateId() (random hex)
// cannot produce them.

const ENTRY_DEFAULTS = {
    cycleMax: 180,       // s — door open→closed must complete within this
    confirmWindow: 120,  // s — motion after close confirms within this
    lr: 30,
    candidateWindow: 300 // s
};

function complete(sel) {
    return !!(sel && sel.thing && sel.item);
}

// expandEntryTemplate(config) → { config, warnings }
// Non-mutating: returns the same config object when the template is disabled, otherwise
// a shallow-extended copy with the entry rows/composite appended.
function expandEntryTemplate(config) {
    const entry = config.entry;
    if (!entry || !complete(entry.door) || !complete(entry.motion)) {
        return { config, warnings: [] };
    }

    const warnings = [];
    const out = Object.assign({}, config);

    out.observations = (config.observations || []).concat([
        { id: '__entry_door', name: 'Entry: door', thing: entry.door.thing, item: entry.door.item,
          type: 'event', operator: 'true', value: '', valueType: 'str', lr: 1,
          halfLife: '', onlyAsCandidate: false },
        { id: '__entry_motion', name: 'Entry: motion', thing: entry.motion.thing, item: entry.motion.item,
          type: 'event', operator: 'true', value: '', valueType: 'str', lr: 1,
          halfLife: '', onlyAsCandidate: false }
    ]);

    out.composites = (config.composites || []).concat([{
        id: '__entry', name: 'Entry detection',
        armRow: '__entry_door', armPattern: 'cycle', cycleMax: ENTRY_DEFAULTS.cycleMax,
        confirmRow: '__entry_motion', confirmWindow: ENTRY_DEFAULTS.confirmWindow,
        confirmDuringArm: true, lr: ENTRY_DEFAULTS.lr, onlyAsCandidate: true
    }]);

    // An explicitly configured candidate trigger always wins over the template's person row.
    if (entry.personRow) {
        if (config.candidateRow && config.candidateRow !== entry.personRow) {
            warnings.push('Entry template person row ignored — a candidate trigger is already configured');
        } else if (!config.candidateRow) {
            out.candidateRow = entry.personRow;
            out.candidateWindow = ENTRY_DEFAULTS.candidateWindow;
        }
    }

    return { config: out, warnings };
}

module.exports = { expandEntryTemplate, ENTRY_DEFAULTS };

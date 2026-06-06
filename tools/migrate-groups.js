#!/usr/bin/env node
/*
 * migrate-groups.js — convert legacy hal2Group nodes to the new group model.
 *
 * Old model: each hal2Group node holds group:[{thing,item}] and is referenced by
 * Action/Event nodes via the group's node id.
 *
 * New model: a group's identity (id, name, haType, ratelimit, notes) lives on its
 * hal2EventHandler node (eh.groups[]), and membership lives per item on each
 * hal2Thing (thing.groups = [{item, group}]).
 *
 * The group's node id is REUSED as the new group id, so existing Action/Event
 * references (which point at that id) keep working untouched. hal2Group nodes are
 * removed from the flow.
 *
 * haType is derived from the members' item haTypes: all equal -> that type;
 * otherwise (or unknown) -> 'other' (the mixed/untyped mode that accepts any item).
 *
 * Usage:
 *   node tools/migrate-groups.js <flows.json> [output.json]
 *
 * Default output: <flows>.migrated.json   (the input is never modified in place).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

function fail(msg) {
    console.error('Error: ' + msg);
    process.exit(1);
}

const inputPath = process.argv[2];
if (!inputPath) {
    fail('No input file. Usage: node tools/migrate-groups.js <flows.json> [output.json]');
}
const outputPath = process.argv[3] ||
    path.join(path.dirname(inputPath), path.basename(inputPath, path.extname(inputPath)) + '.migrated' + path.extname(inputPath));

let raw;
try { raw = fs.readFileSync(inputPath, 'utf8'); }
catch (e) { fail('Cannot read ' + inputPath + ': ' + e.message); }

let parsed;
try { parsed = JSON.parse(raw); }
catch (e) { fail('Invalid JSON in ' + inputPath + ': ' + e.message); }

// Node-RED full export is a flat array; some exports wrap it in { flows: [...] }.
const nodes = Array.isArray(parsed) ? parsed
            : (Array.isArray(parsed.flows) ? parsed.flows : null);
if (!nodes) { fail('Could not find a node array in the input (expected an array or { flows: [...] }).'); }

const byId = new Map();
for (const n of nodes) { if (n && n.id) byId.set(n.id, n); }

function deriveHaType(members) {
    const types = new Set();
    for (const m of members) {
        const thing = byId.get(m.thing);
        if (!thing || thing.type !== 'hal2Thing') { types.add(''); continue; }
        const tt = byId.get(thing.thingType);
        if (!tt || !Array.isArray(tt.items)) { types.add(''); continue; }
        const item = tt.items.find(it => it.id === m.item);
        types.add((item && item.haType) || '');
    }
    types.delete(undefined);
    if (types.size === 1) {
        const only = [...types][0];
        if (only) return only;       // homogeneous and known
    }
    return 'other';                  // heterogeneous or unknown -> mixed
}

const groupNodes = nodes.filter(n => n && n.type === 'hal2Group');
if (groupNodes.length === 0) {
    console.log('No hal2Group nodes found — nothing to migrate.');
}

let migrated = 0, membershipsAdded = 0, warnings = 0;

for (const group of groupNodes) {
    const groupId  = group.id;
    const members  = Array.isArray(group.group) ? group.group : [];
    const eh       = byId.get(group.eventHandler);

    if (!eh || eh.type !== 'hal2EventHandler') {
        console.warn('  ! Group "' + (group.name || groupId) + '" has no resolvable Event handler — skipping.');
        warnings += 1;
        continue;
    }

    const haType = deriveHaType(members);

    // 1) Register the group on the EventHandler (reuse the group's node id).
    if (!Array.isArray(eh.groups)) eh.groups = [];
    if (!eh.groups.some(g => g.id === groupId)) {
        eh.groups.push({
            id:        groupId,
            name:      group.name || groupId,
            haType:    haType,
            ratelimit: Number(group.ratelimit) || 0,
            notes:     group.notes || ''
        });
    }
    migrated += 1;
    console.log('  - "' + (group.name || groupId) + '"  ->  haType=' + haType +
        ', members=' + members.length + ', eh=' + (eh.name || eh.id));

    // 2) Add membership per item on each member Thing.
    for (const m of members) {
        const thing = byId.get(m.thing);
        if (!thing || thing.type !== 'hal2Thing') {
            console.warn('    ! Member thing ' + m.thing + ' not found — skipping member.');
            warnings += 1;
            continue;
        }
        if (!Array.isArray(thing.groups)) thing.groups = [];
        const exists = thing.groups.some(x => x.item === m.item && x.group === groupId);
        if (!exists) {
            thing.groups.push({ item: m.item, group: groupId });
            membershipsAdded += 1;
        }
    }
}

// 3) Remove the hal2Group nodes (references to them are by id, now the group id).
const remaining = nodes.filter(n => !(n && n.type === 'hal2Group'));

let output;
if (Array.isArray(parsed)) {
    output = remaining;
} else {
    output = Object.assign({}, parsed, { flows: remaining });
}

try { fs.writeFileSync(outputPath, JSON.stringify(output, null, 4)); }
catch (e) { fail('Cannot write ' + outputPath + ': ' + e.message); }

console.log('');
console.log('Migrated ' + migrated + ' group(s), ' + membershipsAdded + ' membership(s) added, ' +
    groupNodes.length + ' hal2Group node(s) removed.');
if (warnings > 0) console.log('Completed with ' + warnings + ' warning(s) — review the output above.');
console.log('Wrote: ' + outputPath);

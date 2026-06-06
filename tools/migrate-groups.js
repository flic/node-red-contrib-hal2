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

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

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

function newId() {
    return crypto.randomBytes(8).toString('hex');
}

// Mutate a node in place into a hal2Action that broadcasts to the group on input.
// Keeps id/z/x/y/name/eventHandler so incoming wires (which target this id) survive.
function toAction(node, groupId) {
    const keep = { id: node.id, z: node.z, x: node.x, y: node.y, name: node.name, eventHandler: node.eventHandler };
    for (const k of Object.keys(node)) delete node[k];
    Object.assign(node, keep, {
        type:       'hal2Action',
        commandset: [{ category: 'hal2Group', thing: groupId, item: groupId, value: 'payload', type: 'msg', onchange: false }],
        ratelimit:  0,
        passthru:   false,
        outputs:    0,
        wires:      []
    });
}

// Build a hal2Event that fires on any member change and forwards to `wires`.
function makeEvent(id, z, x, y, name, eventHandler, groupId, wires) {
    return {
        id: id, type: 'hal2Event', z: z, eventHandler: eventHandler,
        name: name, topic: '',
        thing: groupId, typeSel: 'hal2Group', item: groupId,
        operator: 'always', change: '0', compareValue: '', compareType: 'num',
        outputValue: 'payload', outputType: 'state',
        ratelimit: false, ratetype: 'all', rate: '1', rateUnits: 'hour',
        delay: false, delayExtend: false, delayReset: false, delayValue: 5,
        x: x, y: y, wires: (wires && wires.length) ? wires : [[]]
    };
}

// Mutate a node in place into the hal2Event above, keeping its outgoing wires.
function toEvent(node, groupId, wires) {
    const keep = { id: node.id, z: node.z, x: node.x, y: node.y, name: node.name, eventHandler: node.eventHandler };
    for (const k of Object.keys(node)) delete node[k];
    Object.assign(node, makeEvent(keep.id, keep.z, keep.x, keep.y, keep.name, keep.eventHandler, groupId, wires));
}

const groupNodes = nodes.filter(n => n && n.type === 'hal2Group');
if (groupNodes.length === 0) {
    console.log('No hal2Group nodes found — nothing to migrate.');
}

let migrated = 0, membershipsAdded = 0, warnings = 0;
let convertedAction = 0, convertedEvent = 0;
const dropIds   = new Set();   // pure registry groups to remove
const extraNodes = [];         // new Event nodes for input+output groups

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

    // 3) Decide what happens to the group node itself.
    //    - Pure registry group (no wires): drop it; Action/Event nodes reference it by id.
    //    - Input enabled: becomes an Action that broadcasts to the group (keeps id → incoming wires survive).
    //    - Output enabled: becomes an Event that fires on any member change (keeps id + outgoing wires).
    //    - Both: Action keeps the id (incoming wires); a new Event carries the outgoing wires.
    const wiredInput  = group.input  === true || Number(group.inputs)  > 0;
    const wiredOutput = group.output === true || Number(group.outputs) > 0;
    const outWires    = Array.isArray(group.wires) ? group.wires : [];

    if (!wiredInput && !wiredOutput) {
        dropIds.add(groupId);
    } else if (wiredInput && !wiredOutput) {
        toAction(group, groupId);
        convertedAction += 1;
        console.log('    → wired input: replaced with Action node (same id)');
    } else if (wiredOutput && !wiredInput) {
        toEvent(group, groupId, outWires);
        convertedEvent += 1;
        console.log('    → wired output: replaced with Event node (same id, wires kept)');
    } else {
        extraNodes.push(makeEvent(newId(), group.z, group.x, group.y + 40,
            (group.name || 'Group') + ' (event)', group.eventHandler, groupId, outWires));
        toAction(group, groupId);
        convertedAction += 1;
        convertedEvent += 1;
        console.log('    → wired input+output: Action keeps id, new Event carries the output wires');
    }
}

// 4) Assemble: drop pure registry groups, keep converted (mutated) nodes, append new Events.
let remaining = nodes.filter(n => !(n && dropIds.has(n.id)));
remaining = remaining.concat(extraNodes);

let output;
if (Array.isArray(parsed)) {
    output = remaining;
} else {
    output = Object.assign({}, parsed, { flows: remaining });
}

try { fs.writeFileSync(outputPath, JSON.stringify(output, null, 4)); }
catch (e) { fail('Cannot write ' + outputPath + ': ' + e.message); }

console.log('');
console.log('Migrated ' + migrated + ' group(s), ' + membershipsAdded + ' membership(s) added.');
console.log('  ' + dropIds.size + ' pure registry group(s) removed, ' +
    convertedAction + ' converted to Action, ' + convertedEvent + ' converted to Event.');
if (warnings > 0) console.log('Completed with ' + warnings + ' warning(s) — review the output above.');
console.log('Wrote: ' + outputPath);

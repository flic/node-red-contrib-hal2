#!/usr/bin/env node
/*
 * migrate-groups.js — convert hal2Group nodes, removed in 4.0.0, to the event handler's group
 * registry, in a flows file rather than in the editor (which offers the same conversion when it
 * loads the flows). See resources/convert.js for what the conversion does.
 *
 * Usage:
 *   node tools/migrate-groups.js <flows.json> [output.json]
 *
 * Default output: <flows>.migrated.json   (the input is never modified in place).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { convertGroups } = require('../resources/convert');

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

let parsed;
try { parsed = JSON.parse(fs.readFileSync(inputPath, 'utf8')); }
catch (e) { fail('Cannot read ' + inputPath + ': ' + e.message); }

// Node-RED full export is a flat array; some exports wrap it in { flows: [...] }.
const nodes = Array.isArray(parsed) ? parsed
            : (Array.isArray(parsed.flows) ? parsed.flows : null);
if (!nodes) { fail('Could not find a node array in the input (expected an array or { flows: [...] }).'); }

const { flows, changed, notes } = convertGroups(nodes);
if (!changed.length) { console.log('No hal2Group nodes found — nothing to migrate.'); }
for (const n of notes) { console.log(n); }

const output = Array.isArray(parsed) ? flows : Object.assign({}, parsed, { flows });
try { fs.writeFileSync(outputPath, JSON.stringify(output, null, 4)); }
catch (e) { fail('Cannot write ' + outputPath + ': ' + e.message); }
console.log('Wrote: ' + outputPath);

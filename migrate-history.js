'use strict';

const fs       = require('fs');
const readline = require('readline');
const path     = require('path');

const [,, nedbPath, sqlitePath] = process.argv;

if (!nedbPath || !sqlitePath) {
    console.error('Usage: node migrate-history.js <nedb-file> <sqlite-file>');
    process.exit(1);
}

if (!fs.existsSync(nedbPath)) {
    console.error('NeDB file not found: ' + nedbPath);
    process.exit(1);
}

if (fs.existsSync(sqlitePath)) {
    console.error('SQLite file already exists: ' + sqlitePath + ' — remove it first to avoid duplicates');
    process.exit(1);
}

function tryRequire(pkg) {
    // 1. Local node_modules
    try { return require(pkg); } catch {}
    // 2. ~/.node-red/node_modules (Node-RED user directory)
    try { return require(path.join(process.env.HOME, '.node-red', 'node_modules', pkg)); } catch {}
    // 3. Global npm
    try {
        const { execSync } = require('child_process');
        const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
        return require(path.join(globalRoot, pkg));
    } catch {}
    return null;
}

const Database = tryRequire('better-sqlite3');
if (!Database) {
    console.error('better-sqlite3 not found locally, in ~/.node-red, or globally.');
    console.error('Install it with: npm install -g better-sqlite3');
    process.exit(1);
}

console.log('Migrating ' + nedbPath + ' → ' + sqlitePath);

const db = new Database(sqlitePath);

db.exec(`
    CREATE TABLE IF NOT EXISTS history (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        thing_id TEXT    NOT NULL,
        item_id  TEXT    NOT NULL,
        state    TEXT,
        ts       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_history_ts    ON history(ts);
    CREATE INDEX IF NOT EXISTS idx_history_thing ON history(thing_id, item_id, ts);
`);

const stmt = db.prepare('INSERT INTO history (thing_id, item_id, state, ts) VALUES (?, ?, ?, ?)');

let migrated = 0;
let skipped  = 0;

const insertBatch = db.transaction((rows) => {
    for (const r of rows) stmt.run(r.thing_id, r.item_id, r.state, r.ts);
});

const BATCH_SIZE = 10000;
let batch = [];

function flushBatch() {
    if (batch.length === 0) return;
    insertBatch(batch);
    migrated += batch.length;
    batch = [];
}

const rl = readline.createInterface({
    input   : fs.createReadStream(nedbPath, { encoding: 'utf8' }),
    crlfDelay: Infinity
});

rl.on('line', (line) => {
    if (!line.trim()) return;

    let doc;
    try {
        doc = JSON.parse(line);
    } catch {
        skipped++;
        return;
    }

    if (doc.$$deleted || doc.$$indexCreated) { skipped++; return; }
    if (!doc.thing_id || !doc.item_id || doc.ts === undefined) { skipped++; return; }

    batch.push({
        thing_id: doc.thing_id,
        item_id : doc.item_id,
        state   : JSON.stringify(doc.state),
        ts      : doc.ts
    });

    if (batch.length >= BATCH_SIZE) {
        flushBatch();
        if (migrated % 100000 === 0) {
            process.stdout.write(migrated.toLocaleString() + ' records...\n');
        }
    }
});

rl.on('close', () => {
    flushBatch();
    db.close();
    console.log('Done. Migrated: ' + migrated.toLocaleString() + ', skipped: ' + skipped.toLocaleString());
});

rl.on('error', (err) => {
    console.error('Read error: ' + err.message);
    flushBatch();
    db.close();
    process.exit(1);
});

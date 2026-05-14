'use strict';

module.exports = function createHistoryDb(dbPath) {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);

    db.exec(`
        CREATE TABLE IF NOT EXISTS history (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            thing_id TEXT    NOT NULL,
            item_id  TEXT    NOT NULL,
            state    TEXT,
            ts       INTEGER NOT NULL,
            source   TEXT    NOT NULL DEFAULT 'external'
        );
        CREATE INDEX IF NOT EXISTS idx_history_ts    ON history(ts);
        CREATE INDEX IF NOT EXISTS idx_history_thing ON history(thing_id, item_id, ts);
    `);

    const cols = db.prepare('PRAGMA table_info(history)').all();
    if (!cols.some(c => c.name === 'source')) {
        db.exec("ALTER TABLE history ADD COLUMN source TEXT NOT NULL DEFAULT 'external'");
        console.log('[hal2EventHandler] history: migrated schema — added source column');
    }

    const stmtInsert    = db.prepare('INSERT INTO history (thing_id, item_id, state, ts, source) VALUES (?, ?, ?, ?, ?)');
    const stmtQuery     = db.prepare('SELECT thing_id, item_id, state, ts, source FROM history WHERE thing_id=? AND item_id=? AND ts>=? AND ts<=? ORDER BY ts ASC');
    const stmtQueryAll  = db.prepare('SELECT thing_id, item_id, state, ts, source FROM history WHERE ts>=? AND ts<=? ORDER BY ts ASC');
    const stmtPrune     = db.prepare('DELETE FROM history WHERE ts < ?');

    function parseRow(row) {
        try   { row.state = JSON.parse(row.state); }
        catch { /* leave as string */ }
        return row;
    }

    return {
        insert(rec) {
            stmtInsert.run(rec.thing_id, rec.item_id, JSON.stringify(rec.state), rec.ts, rec.source || 'external');
        },
        queryHistory(thingId, itemId, fromMs, toMs, cb) {
            try   { cb(null, stmtQuery.all(thingId, itemId, fromMs, toMs).map(parseRow)); }
            catch (e) { cb(e); }
        },
        queryHistoryAll(fromMs, toMs, cb) {
            try   { cb(null, stmtQueryAll.all(fromMs, toMs).map(parseRow)); }
            catch (e) { cb(e); }
        },
        prune(beforeMs) {
            return stmtPrune.run(beforeMs).changes;
        },
        close() {
            db.close();
        }
    };
};

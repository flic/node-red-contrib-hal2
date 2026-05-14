'use strict';

const EXCLUDED_HA_TYPES = new Set([
    'temperature', 'humidity', 'battery', 'binary_sensor',
    'presence', 'room', 'water leak'
]);

const DEBOUNCE_MS = 5000;
const STALE_MS    = 30 * 24 * 3600000;

function normaliseState(state) {
    if (state === 'on'  || state === 'true')  return true;
    if (state === 'off' || state === 'false') return false;
    return state;
}

function bucketToTime(bucketIdx, windowMinutes) {
    const totalMinutes = bucketIdx * windowMinutes;
    const h = Math.floor(totalMinutes / 60) % 24;
    const m = totalMinutes % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

module.exports = function analyzePatterns(docs, thingNameMap, opts) {
    const windowMinutes  = opts.windowMinutes  || 30;
    const threshold      = opts.threshold      || 0.7;
    const minOccurrences = opts.minOccurrences || 2;
    const includeInternal = opts.includeInternal === true;
    const excludeTypes   = opts.includeSensors ? new Set() : EXCLUDED_HA_TYPES;

    let excludedInternal = 0;

    // Phase 1: group records by series key
    const seriesMap = new Map();
    for (const doc of docs) {
        const thingInfo = thingNameMap.get(doc.thing_id);
        if (!thingInfo) continue;
        const itemInfo = thingInfo.items.get(doc.item_id);
        if (!itemInfo) continue;
        if (doc.item_id === '1') continue;
        if (excludeTypes.has(itemInfo.ha_type)) continue;
        if (doc.state === null || doc.state === undefined || doc.state === 'no value') continue;

        const src = doc.source || 'external';
        if (!includeInternal && (src === 'hal2' || src === 'heartbeat')) {
            excludedInternal++;
            continue;
        }

        const key = doc.thing_id + '::' + doc.item_id;
        if (!seriesMap.has(key)) {
            seriesMap.set(key, { thingInfo, itemInfo, thing_id: doc.thing_id, item_id: doc.item_id, ha_type: itemInfo.ha_type, records: [] });
        }
        seriesMap.get(key).records.push({ ts: doc.ts, state: doc.state });
    }

    // Phase 2: detect transitions per series, collect stale items
    const transitions = [];
    const staleItems  = [];
    const nowMs       = Date.now();

    for (const series of seriesMap.values()) {
        const { records, thing_id, item_id, ha_type, thingInfo, itemInfo } = series;
        if (!records.length) continue;

        const lastTs = records[records.length - 1].ts;
        if (lastTs < nowMs - STALE_MS) {
            staleItems.push({
                thing_id,
                thing_name        : thingInfo.thing_name,
                item_id,
                item_name         : itemInfo.item_name,
                last_seen_days_ago: Math.floor((nowMs - lastTs) / 86400000)
            });
        }

        let prevState;
        let prevTs = 0;

        for (const rec of records) {
            const state = normaliseState(rec.state);
            if (state === prevState && rec.ts - prevTs < DEBOUNCE_MS) continue;
            if (state !== prevState) {
                transitions.push({
                    thing_id,
                    item_id,
                    ha_type,
                    thing_name: thingInfo.thing_name,
                    item_name : itemInfo.item_name,
                    state,
                    ts        : rec.ts
                });
                prevState = state;
                prevTs    = rec.ts;
            }
        }
    }

    // Phase 3: bucket transitions by time-of-day
    const bucketMap = new Map();
    for (const t of transitions) {
        const d = new Date(t.ts);
        const minutesSinceMidnight = d.getHours() * 60 + d.getMinutes();
        const bucketIdx = Math.floor(minutesSinceMidnight / windowMinutes);
        const bkey = t.thing_id + '::' + t.item_id + '::' + String(t.state) + '::' + bucketIdx;
        if (!bucketMap.has(bkey)) {
            bucketMap.set(bkey, { meta: t, bucketIdx, count: 0 });
        }
        bucketMap.get(bkey).count++;
    }

    // Phase 4: aggregate totals per (thing, item, state)
    const totalMap = new Map();
    for (const [, bucket] of bucketMap) {
        const { meta, bucketIdx, count } = bucket;
        const tkey = meta.thing_id + '::' + meta.item_id + '::' + String(meta.state);
        if (!totalMap.has(tkey)) {
            totalMap.set(tkey, { meta, total: 0, peakBucket: null, peakCount: 0 });
        }
        const group = totalMap.get(tkey);
        group.total += count;
        if (count > group.peakCount) {
            group.peakCount  = count;
            group.peakBucket = bucketIdx;
        }
    }

    // Phase 5: filter and format
    const suggestions = [];
    for (const group of totalMap.values()) {
        const consistency = group.peakCount / group.total;
        if (consistency < threshold)      continue;
        if (group.total < minOccurrences) continue;
        suggestions.push({
            thing_id       : group.meta.thing_id,
            thing_name     : group.meta.thing_name,
            item_id        : group.meta.item_id,
            item_name      : group.meta.item_name,
            ha_type        : group.meta.ha_type,
            state          : group.meta.state,
            suggested_time : bucketToTime(group.peakBucket, windowMinutes),
            consistency    : Math.round(consistency * 100) / 100,
            occurrences    : group.peakCount,
            total_in_period: group.total
        });
    }

    suggestions.sort((a, b) => b.consistency - a.consistency || b.occurrences - a.occurrences);

    return {
        analyzed_records : docs.length,
        excluded_internal: excludedInternal,
        window_minutes   : windowMinutes,
        suggestions,
        stale_items      : staleItems
    };
};

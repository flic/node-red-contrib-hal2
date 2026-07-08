'use strict';
// Single source of truth for the hal2 tool catalog.
// Consumed by core/eventhandler.js (MCP route + node.callTool) and by
// scripts/gen-api-docs.js (auto-generated docs/API.md).

// ── MCP tool definitions ──────────────────────────────────────────────────────

const MCP_TOOLS = [
    {
        name        : 'get_all_states',
        description : 'Returns the current state of all devices/things connected to this event handler. ' +
                      'The response includes a location field (e.g. "Home" or "Cabin") identifying which property this server controls. ' +
                      'Use fields="summary" (default) for a lightweight list with thing_id, thing_name, type_name and alive — ideal for orientation and ID lookup. ' +
                      'Use fields="items" for a compact per-device item index (thing_id, thing_name, type_name, items:[{item_id, item_name, ha_type, history}]) — cheap way to find an item_id without the full dump. ' +
                      'Use fields="full" to include all items with item_id, item_name, ha_type and current value. ' +
                      'Each item and each device always includes a last_change field (ISO 8601 UTC timestamp, null if the value has not changed since startup) — when the value last actually changed. Use this to answer "when did X happen?" without an extra get_history call. ' +
                      'Each device has an alive field (true/false) — if false the device is offline. ' +
                      'Only items with a ha_type are included in full mode. ' +
                      'Responses include free-text notes and tags on both Thing and Item level when configured — use them to disambiguate what a device actually measures or controls (e.g. "Pool Sensor" notes: "pool water temperature"). ' +
                      'Each device also includes a categories field listing which control categories it falls into (climate, spa, light, fan, cover, scene), derived from its items — use this to identify what kind of device it is at a glance. ' +
                      'ha_type accepts both literal item types (e.g. "light", "temperature") and category aliases that expand to their underlying types — e.g. "climate" matches devices with target temperature / ac mode / fan mode / swing mode. Supported aliases: climate, spa, light, fan, cover, scene. ' +
                      'Use tag to limit results to devices/items tagged with a specific keyword. ' +
                      'Supports optional pagination via offset and limit. The response includes total.',
        inputSchema : {
            type       : 'object',
            properties : {
                fields  : { type: 'string', enum: ['summary', 'items', 'full'], description: 'Level of detail — "summary" (default): thing_id, thing_name, type_name, alive; "items": compact item index (item_id, item_name, ha_type, history) for cheap id lookup; "full": includes all items with values + metadata' },
                ha_type : { type: 'string', description: 'Filter to devices that have at least one item with this ha_type (e.g. "light", "scene", "cover")' },
                tag     : { type: 'string', description: 'Filter to devices/items tagged with this value (case-insensitive, exact match)' },
                offset  : { type: 'integer', description: 'Number of devices to skip (default: 0)' },
                limit   : { type: 'integer', description: 'Max devices to return (default: all)' }
            }
        }
    },
    {
        name        : 'get_state',
        description : 'Returns the complete state for a specific device. ' +
                      'Use this to fetch full details for one device by its thing_id. ' +
                      'Provide thing_id for an exact lookup or thing_name for a partial, case-insensitive match. ' +
                      'Response includes notes and tags on both Thing and Item level when configured. ' +
                      'Each item and the device itself include last_change (ISO 8601 UTC) — when the value last actually changed. ' +
                      'Optionally provide item_id to return only a single item value — the item is a measurement/control within the device, not the device name. ' +
                      'If item_id is wrong, the error response lists available_items for that thing so you can pick the right one.',
        inputSchema : {
            type       : 'object',
            properties : {
                thing_id   : { type: 'string', description: 'Exact thing node ID' },
                thing_name : { type: 'string', description: 'Partial, case-insensitive name match (alternative to thing_id)' },
                item_id    : { type: 'string', description: 'If provided, returns only this item within the device' }
            }
        }
    },
    {
        name        : 'get_history',
        description : 'Returns logged historical values for a specific device item — temperature and other sensor readings over time, time series for a graph/chart, trends, statistics, activity. ' +
                      'Use this whenever the user asks about history, statistics, trends, activity over time, ' +
                      'how often something happened, when it last changed, or similar time-based questions. ' +
                      'Items that support history are marked with history:true in get_all_states. ' +
                      'NOTE: a thing is the device, an item is a measurement/control WITHIN it — they are separate namespaces with separate names (e.g. the device "Sjövatten Sensor" contains an item named "Temperatur"), so a thing name will not match an item name. ' +
                      'If you know the device but not the exact item, pass ha_type (e.g. ha_type="temperature") and the server resolves the item for you. ' +
                      'If a device has several items of the same ha_type (e.g. an indoor and an outdoor temperature), combine ha_type with tag (e.g. tag="ute") to pick the right one — items and their tags are listed in available_items when the match is ambiguous. ' +
                      'If item resolution fails, the error response includes available_items (item_id, item_name, ha_type, history) for that thing — pick from it, no full get_all_states dump needed. ' +
                      'Returns an array of objects with timestamp (ISO 8601 UTC, e.g. "2026-05-28T12:03:11.000Z") and state fields, sorted oldest-first. ' +
                      'Time window — use one of these forms: ' +
                      '(1) hours: number of hours back from now (default: 24); ' +
                      '(2) from + to: explicit ISO datetime strings or epoch ms, e.g. from="2026-05-01T00:00:00" to="2026-05-02T00:00:00"; ' +
                      '(3) from only: from that point until now; ' +
                      '(4) at: returns the single most recent record at or before that moment — useful for "what was the value at time X?". ' +
                      'Use offset and limit to page through large result sets (default limit: 500). ' +
                      'The response includes total so you know how many calls are needed. ' +
                      'DOWNSAMPLING: for long ranges of a NUMERIC item (e.g. a week of temperature for a graph), set bucket to "minute", "hour" or "day" ' +
                      '(or bucket_seconds for a custom interval). The server then aggregates per time bucket and returns a compact "buckets" array — ' +
                      'each entry { start, count, avg, min, max } (avg/min/max rounded to numeric_precision; bucket start is local time, e.g. a "day" is local midnight) — ' +
                      'instead of all raw samples. Prefer this over fetching raw data and averaging yourself. Buckets with no data are omitted. ' +
                      'Aggregation is numeric-only; for non-numeric items (on/off, mode) use bucket="raw" (the default).',
        inputSchema : {
            type       : 'object',
            properties : {
                thing_id   : { type: 'string',  description: 'Exact thing node ID (from get_all_states)' },
                thing_name : { type: 'string',  description: 'Partial, case-insensitive name match (alternative to thing_id)' },
                item_id    : { type: 'string',  description: 'Item ID (from get_all_states). The item is the measurement within the thing — NOT the thing/device name.' },
                item_name  : { type: 'string',  description: 'Item name, partial case-insensitive match (alternative to item_id). Must be an item name (e.g. "Temperatur"), not the device name.' },
                ha_type    : { type: 'string',  description: 'Resolve the item by its ha_type within the thing (e.g. "temperature", "humidity", "power"). Convenient when you know the device but not the item name. Aliases like "climate"/"light" expand.' },
                tag        : { type: 'string',  description: 'Disambiguate items of the same ha_type within the thing by tag (e.g. ha_type="temperature" + tag="ute"). Can also be used alone. Item tags appear in available_items.' },
                hours      : { type: 'number',  description: 'Hours back from now (default: 24). Ignored if from/to/at are provided.', minimum: 1 },
                from       : { type: 'string',  description: 'Start of time window — ISO datetime string (e.g. "2026-05-01T06:00:00") or epoch ms as string' },
                to         : { type: 'string',  description: 'End of time window — ISO datetime string or epoch ms as string. Defaults to now if omitted.' },
                at         : { type: 'string',  description: 'Point-in-time lookup — ISO datetime string or epoch ms. Returns the single most recent record at or before this moment.' },
                bucket     : { type: 'string',  enum: ['raw', 'minute', 'hour', 'day'], description: 'Downsampling resolution. "raw" (default) returns individual records; "minute"/"hour"/"day" return server-aggregated avg/min/max/count per local-time bucket (numeric items only).' },
                bucket_seconds   : { type: 'integer', description: 'Custom bucket size in seconds (epoch-aligned). Overrides bucket. Numeric items only.', minimum: 1 },
                numeric_precision: { type: 'integer', description: 'Decimal places for avg/min/max when bucketing (default 2).', minimum: 0, maximum: 6 },
                offset     : { type: 'integer', description: 'Number of records to skip (default: 0). Not applicable when using at or bucketing.' },
                limit      : { type: 'integer', description: 'Max records to return (default: 500). Not applicable when using at or bucketing.' }
            }
        }
    },
    {
        name        : 'control_device',
        description : 'Send a command to a specific device item. Use thing_id and item_id from get_all_states. ' +
                      'The item is the control WITHIN the device (e.g. an "On" item), not the device name. ' +
                      'If the item_id is wrong or read-only, the error response lists available_items (item_id, item_name, ha_type, read_only) for that thing — pick a controllable one from it.',
        inputSchema : {
            type       : 'object',
            required   : ['thing_id', 'item_id', 'value'],
            properties : {
                thing_id  : { type: 'string', description: 'Thing node ID (from get_all_states)' },
                item_id   : { type: 'string', description: 'Item ID within the thing type (from get_all_states)' },
                value     : { description: 'Value to set (e.g. "on", "off", brightness number, temperature, etc.)' }
            }
        }
    },
    {
        name        : 'control_fan',
        description : 'Control a ceiling fan. Identify by thing_id or thing_name (partial, case-insensitive). ' +
                      'Speed 0 = off, 1 = low, 2 = medium, 3 = high. Current speed is available via get_all_states.',
        inputSchema : {
            type       : 'object',
            properties : {
                thing_id   : { type: 'string',  description: 'Exact thing node ID (from get_all_states)' },
                thing_name : { type: 'string',  description: 'Partial, case-insensitive name match' },
                speed      : { type: 'number',  description: '0 = off, 1 = low, 2 = medium, 3 = high', minimum: 0, maximum: 3 }
            }
        }
    },
    {
        name        : 'get_scenes',
        description : 'Returns all scenes with their current status (active/inactive) and last_change (ISO 8601 UTC) — ' +
                      'when the scene was last activated or deactivated. ' +
                      'Use this to answer "is scene X active?", "which scenes are active right now?" or "when was scene Y last activated?".',
        inputSchema : {
            type       : 'object',
            properties : {
                name : { type: 'string', description: 'Optional partial, case-insensitive filter on scene name' }
            }
        }
    },
    {
        name        : 'activate_scene',
        description : 'Activate or deactivate a scene by name or ID. Use get_scenes to find available scenes.',
        inputSchema : {
            type       : 'object',
            properties : {
                thing_id   : { type: 'string',  description: 'Exact thing node ID (from get_scenes)' },
                thing_name : { type: 'string',  description: 'Partial, case-insensitive name match' },
                active     : { type: 'boolean', description: 'true = activate, false = deactivate' }
            }
        }
    },
    {
        name        : 'control_cover',
        description : 'Control curtains, blinds or shutters. Identify by thing_id or thing_name ' +
                      '(partial, case-insensitive). Use position to set an exact opening level, ' +
                      'or open/close as a shortcut. Current position is available via get_all_states.',
        inputSchema : {
            type       : 'object',
            properties : {
                thing_id   : { type: 'string',  description: 'Exact thing node ID (from get_all_states)' },
                thing_name : { type: 'string',  description: 'Partial, case-insensitive name match' },
                position   : { type: 'number',  description: 'Position 0–100 where 0 = fully closed, 100 = fully open', minimum: 0, maximum: 100 },
                open       : { type: 'boolean', description: 'true = fully open (100), false = fully closed (0). Overridden by position if both are given.' }
            }
        }
    },
    {
        name        : 'control_spa',
        description : 'Control a spa or hot tub. Identify by thing_id or thing_name (partial, case-insensitive). ' +
                      'Current status (water temperature, heater state etc.) is available via get_all_states. ' +
                      'All control parameters are optional — only provided ones are sent.',
        inputSchema : {
            type       : 'object',
            properties : {
                thing_id    : { type: 'string',  description: 'Exact thing node ID (from get_all_states)' },
                thing_name  : { type: 'string',  description: 'Partial, case-insensitive name match' },
                target_temp : { type: 'number',  description: 'Desired water temperature in °C' },
                heater      : { type: 'boolean', description: 'true = turn heater on, false = turn off' },
                pump        : { type: 'boolean', description: 'true = turn circulation pump on, false = turn off' },
                airjets     : { type: 'boolean', description: 'true = turn airjets on, false = turn off' }
            }
        }
    },
    {
        name        : 'control_climate',
        description : 'Control a heat pump or AC unit. Identify by thing_id or thing_name (partial, case-insensitive). ' +
                      'Current status is available via get_all_states. All parameters are optional — only provided ones are sent.',
        inputSchema : {
            type       : 'object',
            properties : {
                thing_id   : { type: 'string', description: 'Exact thing node ID (from get_all_states)' },
                thing_name : { type: 'string', description: 'Partial, case-insensitive name match' },
                mode       : { type: 'string', enum: ['off','cool','heat','fan_only','dry','heat_cool'], description: 'HVAC mode' },
                target_temp: { type: 'number', description: 'Target temperature in °C' },
                fan_mode   : { type: 'string', enum: ['auto','diffuse','low','medium','middle','high'], description: 'Fan speed/mode' },
                swing_mode : { type: 'string', enum: ['off','vertical'], description: 'Swing direction' }
            }
        }
    },
    {
        name        : 'get_presence',
        description : 'Returns presence information for all people/persons tracked in the system. ' +
                      'Shows who is home, who is away, and which room each person is in. ' +
                      'Use this to answer questions like "is anyone home?", "where is Alice?", ' +
                      '"who is home right now?", "when did Bob come home?", "how long has Alice been away?". ' +
                      'Each person includes home_since/away_since (ISO timestamp of last change) and ' +
                      'home_for_minutes/away_for_minutes (duration in current state). When home, also includes ' +
                      'room, room_since and in_room_for_minutes. thing_id and item ids are included so follow-up ' +
                      'tools (get_history, set_light, etc.) can be called without an extra lookup. ' +
                      'A summary block provides aggregated counts and name lists.',
        inputSchema : { type: 'object', properties: {} }
    },
    {
        name        : 'get_alerts',
        description : 'Returns water leak sensor status, devices with low battery, and offline devices in one call. ' +
                      'Use this to answer "is there a water leak?", "which sensors have low battery?", ' +
                      '"are any devices offline?", "what needs attention?" or similar questions about sensor alerts. ' +
                      'Each entry always includes last_change (ISO 8601 UTC, null if unknown) — for water sensors this is when the wet/dry state changed, ' +
                      'for low-battery items when the level last changed, and for offline devices when they went offline.',
        inputSchema : {
            type       : 'object',
            properties : {
                battery_threshold : { type: 'number', description: 'Battery level threshold in percent (default: 20)', minimum: 0, maximum: 100 }
            }
        }
    },
    {
        name        : 'set_light',
        description : 'Control a specific light or lamp. Identify the device by thing_id OR thing_name. ' +
                      'thing_name supports partial, case-insensitive match against the thing name OR against ' +
                      'item labels (the label field in get_all_states items). Labels are friendly names assigned ' +
                      'per-device, e.g. a double switch named "Kitchen Double Switch" may have items labelled ' +
                      '"Kitchen Ceiling Light" and "Kitchen Counter Light" — searching "counter" will target only that relay. ' +
                      'You can turn it on/off and/or set brightness/color_temp/color in one call.',
        inputSchema : {
            type       : 'object',
            properties : {
                thing_id   : { type: 'string',  description: 'Exact thing node ID (from get_all_states). Takes priority over thing_name.' },
                thing_name : { type: 'string',  description: 'Partial, case-insensitive name match (e.g. "kontor" matches "Kontor Spotlights").' },
                on         : { type: 'boolean', description: 'true = turn on, false = turn off' },
                brightness : { type: 'number',  description: 'Brightness 0–100 (percent)', minimum: 0, maximum: 100 },
                color_temp : { type: 'number',  description: 'Color temperature in Kelvin (e.g. 2700 = warm white, 4000 = neutral, 6500 = cool wide)' },
                color      : { type: 'string',  description: 'Color as HSB string "H,S,B" where H=0-360 (hue), S=0-100 (saturation), B=0-100 (brightness). E.g. "0,100,100"=red, "120,100,100"=green, "240,100,100"=blue.' }
            }
        }
    },
    {
        name        : 'analyze_patterns',
        description : 'Analyzes the history database to detect recurring behavioral patterns — ' +
                      'e.g. "Living Room Light turns ON around 07:30, 85% consistent". ' +
                      'Detects state transitions (actual changes), groups them into time-of-day windows, ' +
                      'and returns suggestions sorted by consistency score. ' +
                      'Also reports stale items (no activity in 30+ days). ' +
                      'By default, state changes caused by hal2 itself are excluded so existing automations are not re-suggested as patterns. ' +
                      'Requires history to be enabled on the event handler. ' +
                      'Use when the user asks about automating routines or finding patterns in device usage.',
        inputSchema : {
            type       : 'object',
            properties : {
                days             : { type: 'number',  description: 'Lookback period in days (default: 30, max: 365)', minimum: 1, maximum: 365 },
                window_minutes   : { type: 'number',  description: 'Time-of-day bucket size in minutes (default: 30)', minimum: 5, maximum: 120 },
                threshold        : { type: 'number',  description: 'Minimum consistency ratio 0–1 to include a pattern (default: 0.7)', minimum: 0, maximum: 1 },
                min_occurrences  : { type: 'integer', description: 'Minimum number of occurrences to qualify (default: 2)', minimum: 1 },
                include_sensors  : { type: 'boolean', description: 'If true, include continuous/noisy sensors (temperature, humidity, battery, illuminance, power, pressure, depth) — default: false. co2 is always analyzed.' },
                include_internal : { type: 'boolean', description: 'If true, include state changes caused by hal2 itself (default: false). Useful for debugging or verifying that automations actually run.' },
                numeric_precision: { type: 'integer', description: 'Significant figures used to quantize numeric values before detecting transitions, suppressing micro-noise (e.g. lux 287/289/294 → 290). Default: 2. Range 1–6.', minimum: 1, maximum: 6 }
            }
        }
    }
];

// Single source of truth for which item ha_types define each device category.
// Used both for tool exposure (TOOL_HARDWARE_REQUIREMENTS below) and for ha_type
// filter expansion + categories derivation in get_all_states.
// Extend freely if a location uses non-standard ha_types for a category.
const HA_TYPE_GROUPS = {
    climate : ['target temperature', 'ac mode', 'fan mode', 'swing mode'],
    spa     : ['heater', 'circulation pump', 'airjets'],
    light   : ['light', 'dimmer'],
    fan     : ['fan'],
    cover   : ['cover'],
    scene   : ['scene']
};

// Maps tool name → list of ha_types where at least one must be present on this
// location for the tool to be exposed. Tools not listed here are unconditional.
const TOOL_HARDWARE_REQUIREMENTS = {
    control_fan     : HA_TYPE_GROUPS.fan,
    control_cover   : HA_TYPE_GROUPS.cover,
    control_spa     : HA_TYPE_GROUPS.spa,
    control_climate : HA_TYPE_GROUPS.climate,
    set_light       : HA_TYPE_GROUPS.light,
    activate_scene  : HA_TYPE_GROUPS.scene,
    get_scenes      : HA_TYPE_GROUPS.scene
};

function expandHaTypeFilter(input) {
    const key = (input || '').toLowerCase();
    if (HA_TYPE_GROUPS[key]) {
        return new Set([key, ...HA_TYPE_GROUPS[key].map(s => s.toLowerCase())]);
    }
    return new Set([key]);
}

function deriveCategories(items) {
    const itemTypes = new Set(items.map(i => (i.ha_type || '').toLowerCase()));
    const cats = [];
    for (const [cat, types] of Object.entries(HA_TYPE_GROUPS)) {
        if (types.some(t => itemTypes.has(t.toLowerCase()))) cats.push(cat);
    }
    return cats;
}

const MCP_TOOLS_ADMIN = [
    {
        name        : 'get_flow',
        description : 'Lists all Node-RED tabs (ID and node count) when called without arguments. ' +
                      'Returns full JSON configuration for a specific tab when called with an id.',
        inputSchema : {
            type       : 'object',
            properties : {
                id : { type: 'string', description: 'Flow/tab ID — omit to list all flows' }
            }
        }
    },
    {
        name        : 'deploy_flow',
        description : 'Creates or updates a Node-RED flow tab. Omit id to create new.',
        inputSchema : {
            type       : 'object',
            required   : ['label', 'nodes'],
            properties : {
                id    : { type: 'string', description: 'Existing flow ID (omit for new flow)' },
                label : { type: 'string', description: 'Flow tab label/name' },
                nodes : { type: 'array',  description: 'Array of node objects' }
            }
        }
    }
];

const MCP_ADMIN_TOOL_NAMES = new Set(MCP_TOOLS_ADMIN.map(t => t.name));

module.exports = {
    MCP_TOOLS,
    MCP_TOOLS_ADMIN,
    MCP_ADMIN_TOOL_NAMES,
    TOOL_HARDWARE_REQUIREMENTS,
    HA_TYPE_GROUPS,
    expandHaTypeFilter,
    deriveCategories
};

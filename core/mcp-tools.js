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
                      'Use fields="summary" (default) for a lightweight list with id, name, type_name and alive — ideal for orientation and ID lookup. ' +
                      'Use fields="items" for a compact per-device item index (id, name, type_name, items:[{item_id, item_name, ha_type, history}]) — cheap way to find an item_id without the full dump. ' +
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
                fields  : { type: 'string', enum: ['summary', 'items', 'full'], description: 'Level of detail — "summary" (default): id, name, type_name, alive; "items": compact item index (item_id, item_name, ha_type, history) for cheap id lookup; "full": includes all items with values + metadata' },
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
                      'Use this to fetch full details for one device by its id. ' +
                      'Provide id for an exact lookup or name for a partial, case-insensitive match. ' +
                      'Response includes notes and tags on both Thing and Item level when configured. ' +
                      'Each item and the device itself include last_change (ISO 8601 UTC) — when the value last actually changed. ' +
                      'Optionally provide item_id to return only a single item value — the item is a measurement/control within the device, not the device name. ' +
                      'If item_id is wrong, the error response lists available_items for that thing so you can pick the right one.',
        inputSchema : {
            type       : 'object',
            properties : {
                id   : { type: 'string', description: 'Exact thing node ID' },
                name : { type: 'string', description: 'Partial, case-insensitive name match (alternative to id)' },
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
                      'NOTE: a thing is the device, an item is a measurement/control WITHIN it — they are separate namespaces with separate names (e.g. the device "Lake Water Sensor" contains an item named "Temperature"), so a thing name will not match an item name. ' +
                      'If you know the device but not the exact item, pass ha_type (e.g. ha_type="temperature") and the server resolves the item for you. ' +
                      'If a device has several items of the same ha_type (e.g. an indoor and an outdoor temperature), combine ha_type with tag (e.g. tag="outdoor") to pick the right one — items and their tags are listed in available_items when the match is ambiguous. ' +
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
                id   : { type: 'string',  description: 'Exact thing node ID (from get_all_states)' },
                name : { type: 'string',  description: 'Partial, case-insensitive name match (alternative to id)' },
                item_id    : { type: 'string',  description: 'Item ID (from get_all_states). The item is the measurement within the thing — NOT the thing/device name.' },
                item_name  : { type: 'string',  description: 'Item name, partial case-insensitive match (alternative to item_id). Must be an item name (e.g. "Temperature"), not the device name.' },
                ha_type    : { type: 'string',  description: 'Resolve the item by its ha_type within the thing (e.g. "temperature", "humidity", "power"). Convenient when you know the device but not the item name. Aliases like "climate"/"light" expand.' },
                tag        : { type: 'string',  description: 'Disambiguate items of the same ha_type within the thing by tag (e.g. ha_type="temperature" + tag="outdoor"). Can also be used alone. Item tags appear in available_items.' },
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
        description : 'Send a command to a specific device item. Use id and item_id from get_all_states. ' +
                      'The item is the control WITHIN the device (e.g. an "On" item), not the device name. ' +
                      'If the item_id is wrong or read-only, the error response lists available_items (item_id, item_name, ha_type, read_only) for that thing — pick a controllable one from it.',
        inputSchema : {
            type       : 'object',
            required   : ['id', 'item_id', 'value'],
            properties : {
                id  : { type: 'string', description: 'Thing node ID (from get_all_states)' },
                item_id   : { type: 'string', description: 'Item ID within the thing type (from get_all_states)' },
                value     : { description: 'Value to set (e.g. "on", "off", brightness number, temperature, etc.)' }
            }
        }
    },
    {
        name        : 'control_fan',
        description : 'Control a ceiling fan. Identify by id or name (partial, case-insensitive). ' +
                      'Speed 0 = off, 1 = low, 2 = medium, 3 = high. Current speed is available via get_all_states.',
        inputSchema : {
            type       : 'object',
            properties : {
                id   : { type: 'string',  description: 'Exact thing node ID (from get_all_states)' },
                name : { type: 'string',  description: 'Partial, case-insensitive name match' },
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
                id   : { type: 'string',  description: 'Exact thing node ID (from get_scenes)' },
                name : { type: 'string',  description: 'Partial, case-insensitive name match' },
                active     : { type: 'boolean', description: 'true = activate, false = deactivate' }
            }
        }
    },
    {
        name        : 'control_cover',
        description : 'Control curtains, blinds or shutters. Identify by id or name ' +
                      '(partial, case-insensitive). Use position to set an exact opening level, ' +
                      'or open/close as a shortcut. Current position is available via get_all_states.',
        inputSchema : {
            type       : 'object',
            properties : {
                id   : { type: 'string',  description: 'Exact thing node ID (from get_all_states)' },
                name : { type: 'string',  description: 'Partial, case-insensitive name match' },
                position   : { type: 'number',  description: 'Position 0–100 where 0 = fully closed, 100 = fully open', minimum: 0, maximum: 100 },
                open       : { type: 'boolean', description: 'true = fully open (100), false = fully closed (0). Overridden by position if both are given.' }
            }
        }
    },
    {
        name        : 'control_spa',
        description : 'Control a spa or hot tub. Identify by id or name (partial, case-insensitive). ' +
                      'Current status (water temperature, heater state etc.) is available via get_all_states. ' +
                      'All control parameters are optional — only provided ones are sent.',
        inputSchema : {
            type       : 'object',
            properties : {
                id    : { type: 'string',  description: 'Exact thing node ID (from get_all_states)' },
                name  : { type: 'string',  description: 'Partial, case-insensitive name match' },
                target_temp : { type: 'number',  description: 'Desired water temperature in °C' },
                heater      : { type: 'boolean', description: 'true = turn heater on, false = turn off' },
                pump        : { type: 'boolean', description: 'true = turn circulation pump on, false = turn off' },
                airjets     : { type: 'boolean', description: 'true = turn airjets on, false = turn off' }
            }
        }
    },
    {
        name        : 'control_climate',
        description : 'Control a heat pump or AC unit. Identify by id or name (partial, case-insensitive). ' +
                      'Current status is available via get_all_states. All parameters are optional — only provided ones are sent.',
        inputSchema : {
            type       : 'object',
            properties : {
                id   : { type: 'string', description: 'Exact thing node ID (from get_all_states)' },
                name : { type: 'string', description: 'Partial, case-insensitive name match' },
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
                      'room, room_since and in_room_for_minutes. id and item ids are included so follow-up ' +
                      'tools (get_history, set_light, etc.) can be called without an extra lookup. ' +
                      'Entries carry the notes and tags of the thing they describe — this is how a tracked ' +
                      'phone is told apart from the person carrying it, so read them before treating an ' +
                      'entry as a person. A summary block provides aggregated counts and name lists.',
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
        name        : 'get_groups',
        description : 'Returns the groups configured at this location, with their current value. ' +
                      'A GROUP IS NOT A DEVICE: it is a named set of items drawn from several devices, and it has no items of its own — so it takes no item_id and does not appear in get_state. ' +
                      'Its value is COMPUTED from its members by the function shown — latest, min, max, average, median, sum, range (highest minus lowest), any true, all true, any false, all false, count true, count false, percent true (0-100) — and members whose device is offline are left out, so a group value can change with nothing having been switched. ' +
                      'Prefer a group over reading its members one by one whenever the user speaks about a set as one thing: "is anything on?", "how warm is it indoors?", "how many windows are open?". Use get_state instead when they mean one specific device. ' +
                      'THE FUNCTION IS NOT FIXED: pass function to compute a different one from the same members on this call. That is the point — "any true" answers "is a lamp on?", "all true" answers "did the turn-them-on command work?", "count true" answers "how many are on?", over exactly the same group. It changes nothing: the configured function is what the group keeps reporting, and configured_function appears in the reply when the two differ. ' +
                      'A function that does not apply to the members is REFUSED, not answered: asking a temperature group whether all its members are true comes back as an error naming what the members hold and listing suitable_functions — it does not come back as false. ' +
                      'On a mixed group a function may cover only part of it (average over a light group uses the dimmers and ignores the on/off members); the reply then carries used alongside live, and a value computed from a minority of the members should be read as such. ' +
                      'The default is derived from the group\'s ha_type, not configured by anyone: a temperature group reports its average, a light or switch group whether any member is true. A group whose ha_type implies no default has no standing value and no function field — pass function to read it, and members > 0 is what says it is worth asking. ' +
                      'readable:true means the group has members that carry a state, so it can be read. controllable:true means control_group can command it. The two are independent: sensors contribute a value and take no commands, a switch may take commands and report nothing back. ' +
                      'members is how many members carry a state, live how many are contributing right now — a gap between them means devices are offline. ' +
                      'last_change is tracked per function, so it is this function\'s own: "all true" and "any true" over the same group change at different moments. ' +
                      'source names the member the value came from, present only for latest, min and max where one member owns it — use it to answer "which room is coldest?" without reading every member. last_changed_by names the member that last moved the value, which is a different question and only the same one for latest. ' +
                      'notes and tags say what the group actually covers, which the name usually does not ("All lights" does not tell you whether the outdoor lights are included) — read them before assuming, and use the tag filter to select the set you mean.',
        inputSchema : {
            type       : 'object',
            properties : {
                group_id   : { type: 'string', description: 'Exact group ID — returns just that group, for re-reading one you already know' },
                function   : { type: 'string', description: 'Compute this function instead of the group\'s configured one, for this call only: latest, min, max, average, median, sum, range, anyTrue, allTrue, anyFalse, allFalse, countTrue, countFalse, percentTrue',
                               enum: ['latest', 'min', 'max', 'average', 'median', 'sum', 'range', 'anyTrue', 'allTrue', 'anyFalse', 'allFalse', 'countTrue', 'countFalse', 'percentTrue'] },
                group_name : { type: 'string', description: 'Optional partial, case-insensitive filter on group name' },
                ha_type    : { type: 'string', description: 'Filter to groups of this ha_type. Accepts the same category aliases as get_all_states (climate, spa, light, fan, cover, scene), so ha_type="light" also matches dimmer groups' },
                tag        : { type: 'string', description: 'Filter to groups tagged with this value (case-insensitive, exact match)' }
            }
        }
    },
    {
        name        : 'control_group',
        description : 'Sends one command to every member of a group that can accept one — one call instead of one per device. Use get_groups to find groups and see which are controllable. ' +
                      'COMMANDING A GROUP COMMANDS ITS MEMBERS. The group\'s own value is derived and is never written: it follows from what the members report back afterwards, so read it again rather than assuming the command set it. ' +
                      'Members that only report (sensors) are skipped, so the number of members commanded can be lower than the member count in get_groups. Members are paced by the group\'s rate limit, so a large group takes a moment to finish. ' +
                      'The value must suit the group\'s ha_type: on/off (or true/false) for a light or switch group, 0-100 for a dimmer or cover group, a number for a setpoint group. Groups of a structured type (e.g. colour) take whatever value that type expects, so the parameter is deliberately untyped. ' +
                      'RETURNS { ok, group_id, name, value, commanded, skipped, delivery }: commanded is how many members the command was queued to, skipped how many were passed over because they only report or could not be resolved. ' +
                      'There is NO per-member success or failure — commands are fire-and-forget onto the event bus and paced by the rate limit, so most members have not been sent yet when the call returns. A non-zero commanded means the command was accepted and queued, not that any device has acted on it. To confirm the effect, read the group again with get_groups; do not treat the reply as confirmation and do not re-send on the assumption that nothing happened. ' +
                      'To control a single device instead, use set_light or control_device.',
        inputSchema : {
            type       : 'object',
            required   : ['value'],
            properties : {
                group_id   : { type: 'string', description: 'Exact group ID (from get_groups)' },
                group_name : { type: 'string', description: 'Partial, case-insensitive name match (alternative to group_id)' },
                value      : { description: 'Value to send to every commandable member — "on"/"off", true/false, or a number' }
            }
        }
    },
    {
        name        : 'set_light',
        description : 'Control a specific light or lamp. Identify the device by id OR name. ' +
                      'name supports partial, case-insensitive match against the thing name OR against ' +
                      'item labels (the label field in get_all_states items). Labels are friendly names assigned ' +
                      'per-device, e.g. a double switch named "Kitchen Double Switch" may have items labelled ' +
                      '"Kitchen Ceiling Light" and "Kitchen Counter Light" — searching "counter" will target only that relay. ' +
                      'You can turn it on/off and/or set brightness/color_temp/color in one call.',
        inputSchema : {
            type       : 'object',
            properties : {
                id   : { type: 'string',  description: 'Exact thing node ID (from get_all_states). Takes priority over name.' },
                name : { type: 'string',  description: 'Partial, case-insensitive name match (e.g. "office" matches "Office Spotlights").' },
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

// The vocabulary lives in resources/device-class.js because the editor loads the same file over
// HTTP — one definition, so the classes a Thing can be given cannot drift from the ones the tools
// resolve against. See that file for what the two concepts mean.
const {
    HA_TYPE_GROUPS, DEVICE_CLASSES, deviceClassFromHaType, effectiveDeviceClass
} = require('../resources/device-class');

// Maps tool name → what must exist at this location for the tool to be exposed. `haTypes` is
// the item types it writes to; `classes` names the device_class values that also count, which
// is only ever the ones the tool has been taught to act on.
//
// The distinction matters: set_light writes to a switch declared `light` (see writesOnOff), so
// such an item should expose it. control_fan writes a speed to an `ha_type: fan` item and can do
// nothing with a relay declared `fan`, so that declaration must NOT advertise it — a tool
// offered but unable to act is worse than one absent.
const TOOL_HARDWARE_REQUIREMENTS = {
    control_fan     : { haTypes: HA_TYPE_GROUPS.fan,     classes: ['fan'] },
    control_cover   : { haTypes: HA_TYPE_GROUPS.cover,   classes: [] },
    control_spa     : { haTypes: HA_TYPE_GROUPS.spa,     classes: [] },
    control_climate : { haTypes: HA_TYPE_GROUPS.climate, classes: [] },
    set_light       : { haTypes: HA_TYPE_GROUPS.light,   classes: ['light'] },
    activate_scene  : { haTypes: HA_TYPE_GROUPS.scene,   classes: [] },
    get_scenes      : { haTypes: HA_TYPE_GROUPS.scene,   classes: [] }
};

// Whether one item satisfies a tool's requirement — its ha_type is one the tool writes to, or
// its declared class is one the tool knows how to act on.
function itemSatisfies(item, req) {
    if (!req) { return true; }
    const ht = String((item && item.ha_type) || '').toLowerCase();
    if ((req.haTypes || []).some(t => t.toLowerCase() === ht)) { return true; }
    const cls = String((item && item.device_class) || '').toLowerCase();
    return !!cls && (req.classes || []).some(c => c.toLowerCase() === cls);
}

// What an item may be declared to drive. The category names above, because every
// consumer already understands them, plus 'appliance' for "explicitly none of these"
// — a plug on the coffee machine says so rather than staying silent, which is the
// difference between "not classified yet" and "classified, and not a light".



function expandHaTypeFilter(input) {
    const key = (input || '').toLowerCase();
    if (HA_TYPE_GROUPS[key]) {
        return new Set([key, ...HA_TYPE_GROUPS[key].map(s => s.toLowerCase())]);
    }
    return new Set([key]);
}

// An ha_type filter has to see a declared class too, or a relay-driven lamp stays invisible
// to `get_all_states(ha_type: "light")` — which is most of what this feature is for. The
// category name is itself in the expanded set, so matching the class against it is enough.
function itemMatchesHaTypeFilter(item, wanted) {
    return wanted.has(String((item && item.ha_type) || '').toLowerCase())
        || wanted.has(String((item && item.device_class) || '').toLowerCase());
}

// Which of a Thing's items set_light may touch at all: anything not declared to be something
// other than a light. A socket declared `appliance` is never a target, however it is reached —
// that is what stops a set_light aimed at a dual relay cutting the socket beside the lamp.
// Which of the survivors actually take an on/off command is writesOnOff's question.
function lightTargets(candidates) {
    return (candidates || []).filter(i => {
        const explicit = String((i && i.device_class) || '').toLowerCase();
        return !explicit || explicit === 'light';
    });
}

// Whether set_light may switch this item on or off.
//
// An ha_type of `light` says so on its own. A `switch` says only that something can be turned
// on and off — the load could be a lamp or a coffee machine, which is the question device_class
// exists to settle, so an undeclared one is not written. Before device_class there was no way to
// tell them apart and every switch was treated as a light; that guess is what this replaces.
// A dimmer is left to the brightness branch, as before.
function writesOnOff(item) {
    const ht = String((item && item.ha_type) || '').toLowerCase();
    if (ht !== 'light' && ht !== 'switch') { return false; }
    return effectiveDeviceClass(item) === 'light';
}

// The answer when a command matched a thing and then wrote to nothing on it.
//
// Reporting `success: true` with an empty command list has always been this family's habit, and
// it leaves the caller believing something changed: a brightness aimed at an undimmable lamp, an
// on/off aimed at a switch with no device_class, a target temperature aimed at a radiator on a
// relay. Naming the items instead is what makes the answer actionable — it shows whether the tool
// was wrong for the device or a declaration is missing.
function nothingToCommand(devices, need) {
    return {
        error   : 'nothing_to_command',
        message : 'No item on the matched thing(s) takes this command. ' + need,
        things  : (devices || []).map(d => ({
            id   : d.id,
            name : d.name,
            items      : (d.items || []).map(i => ({
                item_id      : i.item_id,
                item_name    : i.item_name,
                ha_type      : i.ha_type,
                device_class : i.device_class || null
            }))
        }))
    };
}

// What a fan item should receive for a requested speed.
//
// An `ha_type: fan` item takes the speed as given. A switch declared a fan is a fan with two
// settings instead of four — 0 is off, anything above it is on — so it gets a boolean. Treating
// the tool as unable to reach a relay was a gap, not a constraint: the fan is no less a fan for
// having one speed. Returns undefined when the item is not a fan control at all, which includes
// a switch declared something else.
function fanValue(item, speed) {
    const ht = String((item && item.ha_type) || '').toLowerCase();
    if (ht === 'fan') { return speed; }
    if (ht === 'switch' && effectiveDeviceClass(item) === 'fan') { return speed > 0; }
    return undefined;
}

// Who or what a presence entry is about.
//
// get_presence flattens a Thing and its presence item into one entry, so it has to choose whose
// notes and tags those of the entry are. It forwarded the item's, which come from the shared
// ThingType — identical for every phone, and describing how the item behaves ("true while any
// node still hears the phone") rather than what the entity is. The Thing's are the ones that tell
// a phone apart from the person carrying it: tags ['device'] against ['person'].
//
// So the Thing's notes identify the entry, tags are the union of both since both are labels on
// it, and the item's notes stay under a name that says they are about the item.
function presenceIdentity(device, presenceItem) {
    const out = {};
    const thingNotes = ((device && device.notes) || '').trim();
    if (thingNotes) { out.notes = thingNotes; }
    const tags = [...new Set([
        ...((device && device.tags) || []),
        ...((presenceItem && presenceItem.tags) || [])
    ])];
    if (tags.length) { out.tags = tags; }
    const itemNotes = ((presenceItem && presenceItem.notes) || '').trim();
    if (itemNotes) { out.presence_item_notes = itemNotes; }
    return out;
}

function deriveCategories(items) {
    const present = new Set();
    for (const i of items) {
        const cls = effectiveDeviceClass(i);
        if (cls) { present.add(cls); }
    }
    // Iterate the vocabulary, not the items, so category order stays stable regardless of
    // how the items happen to be ordered — existing consumers compare these lists.
    return Object.keys(HA_TYPE_GROUPS).filter(c => present.has(c));
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

// Which built-in tools only observe, and which change the house. The split cannot be
// derived from the dispatch functions in eventhandler.js — get_scenes and get_alerts are
// read-only but are handled inside dispatchControlTools — so it has to be stated here.
const MCP_READ_TOOL_NAMES = new Set([
    'get_all_states', 'get_state', 'get_history',
    'get_scenes', 'get_presence', 'get_alerts', 'analyze_patterns', 'get_groups'
]);

const MCP_WRITE_TOOL_NAMES = new Set([
    'set_light',
    // control_light is an undocumented alias of set_light accepted by the dispatcher but
    // absent from MCP_TOOLS. Leaving it out would be a clean bypass of the write gate.
    'control_light',
    'control_device', 'control_fan', 'control_cover', 'control_spa', 'control_climate',
    'activate_scene', 'control_group'
]);

// Which gate a built-in tool answers to. Anything unclassified counts as a write, so a tool
// added to the catalog without being classified is held to the stricter gate rather than
// slipping through ungated; test/mcp-tools.test.js turns the omission into a build failure.
function toolClass(name) {
    if (MCP_ADMIN_TOOL_NAMES.has(name)) { return 'admin'; }
    if (MCP_READ_TOOL_NAMES.has(name))  { return 'read'; }
    return 'write';
}

module.exports = {
    MCP_TOOLS,
    MCP_TOOLS_ADMIN,
    MCP_ADMIN_TOOL_NAMES,
    MCP_READ_TOOL_NAMES,
    MCP_WRITE_TOOL_NAMES,
    toolClass,
    TOOL_HARDWARE_REQUIREMENTS,
    HA_TYPE_GROUPS,
    DEVICE_CLASSES,
    deviceClassFromHaType,
    effectiveDeviceClass,
    expandHaTypeFilter,
    itemMatchesHaTypeFilter,
    lightTargets,
    writesOnOff,
    nothingToCommand,
    itemSatisfies,
    fanValue,
    presenceIdentity,
    deriveCategories
};

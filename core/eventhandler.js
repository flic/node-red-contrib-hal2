const http            = require('http');
const https           = require('https');
const crypto          = require('crypto');
const analyzePatterns = require('./analyzePatterns');

console.log('[hal2EventHandler] module loaded, version check: ' + new Date().toISOString());

// ── MCP tool definitions ──────────────────────────────────────────────────────

const MCP_TOOLS = [
    {
        name        : 'get_all_states',
        description : 'Returns the current state of all devices/things connected to this event handler. ' +
                      'The response includes a location field (e.g. "Hemma" or "Landet") identifying which property this server controls. ' +
                      'Use fields="summary" (default) for a lightweight list with thing_id, thing_name, type_name and alive — ideal for orientation and ID lookup. ' +
                      'Use fields="full" to include all items with item_id, item_name, ha_type and current value. ' +
                      'Each item and each device always includes a last_change field (ISO 8601 UTC timestamp, null if the value has not changed since startup) — when the value last actually changed. Use this to answer "when did X happen?" without an extra get_history call. ' +
                      'Each device has an alive field (true/false) — if false the device is offline. ' +
                      'Only items with a ha_type are included in full mode. ' +
                      'Responses include free-text notes and tags on both Thing and Item level when configured — use them to disambiguate what a device actually measures or controls (e.g. "Sjövatten Sensor" notes: "lake water temperature at the dock"). ' +
                      'Each device also includes a categories field listing which control categories it falls into (climate, spa, light, fan, cover, scene), derived from its items — use this to identify what kind of device it is at a glance. ' +
                      'ha_type accepts both literal item types (e.g. "light", "temperature") and category aliases that expand to their underlying types — e.g. "climate" matches devices with target temperature / ac mode / fan mode / swing mode. Supported aliases: climate, spa, light, fan, cover, scene. ' +
                      'Use tag to limit results to devices/items tagged with a specific keyword. ' +
                      'Supports optional pagination via offset and limit. The response includes total.',
        inputSchema : {
            type       : 'object',
            properties : {
                fields  : { type: 'string', enum: ['summary', 'full'], description: 'Level of detail — "summary" (default): thing_id, thing_name, type_name, alive; "full": includes all items' },
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
                      'Use this after get_all_states (summary) to fetch full details for one device by its thing_id. ' +
                      'Provide thing_id for an exact lookup or thing_name for a partial, case-insensitive match. ' +
                      'Response includes notes and tags on both Thing and Item level when configured. ' +
                      'Each item and the device itself include last_change (ISO 8601 UTC) — when the value last actually changed. ' +
                      'Optionally provide item_id to return only a single item value.',
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
        description : 'Returns logged historical values for a specific device item. ' +
                      'Use this whenever the user asks about history, statistics, trends, activity over time, ' +
                      'how often something happened, when it last changed, or similar time-based questions. ' +
                      'Items that support history are marked with history:true in get_all_states. ' +
                      'Returns an array of objects with timestamp (ISO 8601 UTC, e.g. "2026-05-28T12:03:11.000Z") and state fields, sorted oldest-first. ' +
                      'Time window — use one of these forms: ' +
                      '(1) hours: number of hours back from now (default: 24); ' +
                      '(2) from + to: explicit ISO datetime strings or epoch ms, e.g. from="2026-05-01T00:00:00" to="2026-05-02T00:00:00"; ' +
                      '(3) from only: from that point until now; ' +
                      '(4) at: returns the single most recent record at or before that moment — useful for "what was the value at time X?". ' +
                      'Use offset and limit to page through large result sets (default limit: 500). ' +
                      'The response includes total so you know how many calls are needed.',
        inputSchema : {
            type       : 'object',
            properties : {
                thing_id   : { type: 'string',  description: 'Exact thing node ID (from get_all_states)' },
                thing_name : { type: 'string',  description: 'Partial, case-insensitive name match (alternative to thing_id)' },
                item_id    : { type: 'string',  description: 'Item ID (from get_all_states)' },
                item_name  : { type: 'string',  description: 'Item name, partial case-insensitive match (alternative to item_id)' },
                hours      : { type: 'number',  description: 'Hours back from now (default: 24). Ignored if from/to/at are provided.', minimum: 1 },
                from       : { type: 'string',  description: 'Start of time window — ISO datetime string (e.g. "2026-05-01T06:00:00") or epoch ms as string' },
                to         : { type: 'string',  description: 'End of time window — ISO datetime string or epoch ms as string. Defaults to now if omitted.' },
                at         : { type: 'string',  description: 'Point-in-time lookup — ISO datetime string or epoch ms. Returns the single most recent record at or before this moment.' },
                offset     : { type: 'integer', description: 'Number of records to skip (default: 0). Not applicable when using at.' },
                limit      : { type: 'integer', description: 'Max records to return (default: 500). Not applicable when using at.' }
            }
        }
    },
    {
        name        : 'control_device',
        description : 'Send a command to a specific device item. Use thing_id and item_id from get_all_states.',
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
                      'Use this to answer questions like "is anyone home?", "where is Fredrik?", ' +
                      '"who is home right now?", "when did Mica come home?", "how long has Fredrik been away?". ' +
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
                      'per-device, e.g. a double switch named "Kök Dubbelbrytare" may have items labelled ' +
                      '"Kök Taklampa" and "Kök Bänkbelysning" — searching "bänkbelysning" will target only that relay. ' +
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

console.log('[hal2EventHandler] MCP_TOOLS catalog (static, pre-filter): ' + MCP_TOOLS.map(t => t.name).join(', '));

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

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGet(url, headers) {
    return new Promise((resolve, reject) => {
        const u    = new URL(url);
        const lib  = u.protocol === 'https:' ? https : http;
        const opts = {
            hostname : u.hostname,
            port     : u.port || (u.protocol === 'https:' ? 443 : 80),
            path     : u.pathname + (u.search || ''),
            method   : 'GET',
            headers  : headers || {}
        };
        const req = lib.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function httpRequest(method, hostname, port, path, headers, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const hdrs = Object.assign({ 'Content-Type': 'application/json', 'Node-RED-API-Version': 'v2' }, headers);
        if (data) hdrs['Content-Length'] = Buffer.byteLength(data);
        const req = http.request({ method, hostname, port, path, headers: hdrs }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                try   { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
                catch { resolve({ status: res.statusCode, body: raw }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function removeRoute(RED, method, path) {
    if (!RED.httpNode || !RED.httpNode._router) return;
    RED.httpNode._router.stack = RED.httpNode._router.stack.filter(layer => {
        if (!layer.route) return true;
        return !(layer.route.path === path && layer.route.methods[method]);
    });
}

// ── EventHandler node ─────────────────────────────────────────────────────────

module.exports = function(RED) {

    function hal2EventHandler(config) {
        RED.nodes.createNode(this, config);
        console.log('[hal2EventHandler] constructor called, id=' + config.id + ', mcpEnabled=' + !!config.mcpEnabled);

        this.host           = config.name;
        this.contextStore   = config.contextStore;
        this.maxlisteners   = config.maxlisteners;
        this.heartbeat      = config.heartbeat;
        this.items          = config.items;
        this.ingressLibrary = config.ingressLibrary || [];
        this.egressLibrary  = config.egressLibrary  || [];

        if (typeof this.contextStore === 'undefined') { this.contextStore = ''; }

        const node  = this;

        // ── Dynamic MCP tool registry (used by hal2MCPIn / hal2MCPOut) ─────────

        node.mcpRegisteredTools = {};
        node.mcpPendingCalls    = {};

        // ── Shared function library lookup helpers ────────────────────────────

        node.findIngressFn = function (id) {
            return (node.ingressLibrary || []).find(f => f.id === id);
        };
        node.findEgressFn = function (id) {
            return (node.egressLibrary || []).find(f => f.id === id);
        };

        node.registerMCPTool = function (toolName, description, schema, timeoutSec) {
            node.mcpRegisteredTools[toolName] = { description, schema, timeoutMs: (timeoutSec || 30) * 1000 };
            node.log('MCP tool registered: ' + toolName);
        };

        node.unregisterMCPTool = function (toolName) {
            delete node.mcpRegisteredTools[toolName];
            node.log('MCP tool unregistered: ' + toolName);
        };

        node.resolveMCPCall = function (callId, text) {
            const pending = node.mcpPendingCalls[callId];
            if (!pending) { node.warn('resolveMCPCall: no pending call for ' + callId); return; }
            clearTimeout(pending.timer);
            delete node.mcpPendingCalls[callId];
            pending.resolve(text);
        };
        let   hbList = [];

        node.debug("Max listeners set to " + node.maxlisteners);
        node.setMaxListeners(Number(node.maxlisteners));

        // ── Heartbeat ─────────────────────────────────────────────────────────

        function checkHeartbeat() {
            const date = Date.now();
            for (const n in hbList) {
                const thing  = RED.nodes.getNode(hbList[n].id);
                const online = (thing.id in thing.heartbeat) &&
                               (date < (Number(thing.thingType.hbTTL) * 1000) + thing.heartbeat[thing.id]);
                if (online !== thing.state['1']) {
                    if (!online) { node.debug("Heartbeat: " + thing.name + " offline"); }
                    thing.updateState([], '1', false, 'heartbeat');
                }
            }
        }

        if (this.heartbeat) {
            node.debug("Heartbeat check interval set to " + node.heartbeat);
            setTimeout(checkHeartbeat, 5000);
            setInterval(checkHeartbeat, this.heartbeat * 1000);
        }

        node.registerHeartbeat = function (id, ttl) {
            hbList.push({ id, ttl });
            node.debug("Added heartbeat TTL check for " + id);
        };

        node.unregisterHeartbeat = function (id) {
            hbList = hbList.filter(hb => hb.id !== id);
            node.debug("Removed heartbeat TTL check for " + id);
        };

        // ── History ───────────────────────────────────────────────────────────

        let historyDb = null;

        if (config.historyEnabled && config.historyDbPath) {
            const retentionMs = (Number(config.historyRetentionDays) || 30) * 24 * 60 * 60 * 1000;
            try {
                const createHistoryDb = require('./historyDb');
                historyDb = createHistoryDb(config.historyDbPath);
                node.log('History enabled (SQLite), db: ' + config.historyDbPath);

                const pruneHistory = () => {
                    const n = historyDb.prune(Date.now() - retentionMs);
                    if (n > 0) { node.log('History pruned ' + n + ' records'); }
                };
                pruneHistory();
                const historyPruneInterval = setInterval(pruneHistory, 60 * 60 * 1000);
                node.on('close', () => {
                    clearInterval(historyPruneInterval);
                    historyDb.close();
                    historyDb = null;
                });
            } catch (err) {
                node.warn('History unavailable (better-sqlite3 not installed): ' + err.message);
                historyDb = null;
            }
        }

        // ── Hal2 command correlation ──────────────────────────────────────────
        // When hal2 issues a command via publishCommand, we mark (thing_id, item_id)
        // for a short window. A subsequent ingress event for the same pair is then
        // attributed to hal2 (source='hal2'), so analyze_patterns can ignore it.

        const correlationCfg = Number(config.hal2CorrelationMs);
        node.hal2CorrelationMs   = Number.isFinite(correlationCfg) && correlationCfg >= 0 ? correlationCfg : 5000;
        node.pendingHal2Commands = new Map();

        const correlationCleanupInterval = setInterval(() => {
            const now = Date.now();
            for (const [key, expiresAt] of node.pendingHal2Commands) {
                if (expiresAt <= now) node.pendingHal2Commands.delete(key);
            }
        }, 60_000);

        node.on('close', () => {
            clearInterval(correlationCleanupInterval);
            node.pendingHal2Commands.clear();
        });

        // ── Event bus ─────────────────────────────────────────────────────────

        node.subscribe = function (event, id, listener) {
            const eventStr = event + "_" + id;
            this.addListener(eventStr, listener);
            node.debug("Added listener for event " + eventStr + ", count: " + this.listenerCount(eventStr));
        };

        node.unsubscribe = function (event, id, listener) {
            const eventStr = event + "_" + id;
            this.removeListener(eventStr, listener);
            node.debug("Removed listener for event " + eventStr);
        };

        node.publishCommand = function (id, itemid, payload) {
            // Normalise string on/off/true/false to boolean
            if (payload === 'on'  || payload === 'true')  payload = true;
            if (payload === 'off' || payload === 'false') payload = false;
            const listenerCount = this.listenerCount("command_" + id);
            console.log('[hal2EventHandler] publishCommand: thing=' + id + ', item=' + itemid + ', payload=' + JSON.stringify(payload) + ', listeners=' + listenerCount);

            // Mark this (thing, item) as hal2-driven so the incoming HA confirmation
            // can be attributed to us. Lazy-cleanup expired markers while we're here.
            if (node.hal2CorrelationMs > 0) {
                const now = Date.now();
                for (const [k, expiresAt] of node.pendingHal2Commands) {
                    if (expiresAt <= now) node.pendingHal2Commands.delete(k);
                }
                node.pendingHal2Commands.set(id + '::' + itemid, now + node.hal2CorrelationMs);
            }

            this.emit("command_" + id, itemid, payload);
        };

        node.publishUpdate = function (thingtypeid, thingid, itemid, payload, logtype) {
            if (historyDb && thingtypeid) {
                const thingType = RED.nodes.getNode(thingtypeid);
                if (thingType && thingType.items) {
                    const item = thingType.items.find(i => i.id === itemid);
                    if (item && item.history) {
                        if (item.historyAllUpdates || payload.state !== payload.laststate) {
                            let source = 'external';
                            if (logtype === 'heartbeat') {
                                source = 'heartbeat';
                            } else if (logtype === 'egress') {
                                source = 'hal2';
                            } else if (logtype === 'ingress') {
                                const key = thingid + '::' + itemid;
                                const expiresAt = node.pendingHal2Commands.get(key);
                                if (expiresAt && expiresAt > Date.now()) {
                                    source = 'hal2';
                                    node.pendingHal2Commands.delete(key);
                                }
                            }
                            historyDb.insert({ thing_id: thingid, item_id: itemid, state: payload.state, ts: Date.now(), source });
                        }
                    }
                }
            }
            if (thingtypeid !== null) {
                node.debug("Update event: Thingtype " + thingtypeid + " Item " + itemid);
                this.emit("update_" + thingtypeid, thingtypeid, thingid, itemid, payload);
            }
            node.debug("Update event: Thing " + thingid + " Item " + itemid);
            this.emit("update_" + thingid, thingtypeid, thingid, itemid, payload);
        };

        node.queryHistory = function (thingid, itemid, fromMs, toMs, cb) {
            if (!historyDb) { cb(null, []); return; }
            historyDb.queryHistory(thingid, itemid, fromMs, toMs, cb);
        };

        node.queryHistoryAll = function (fromMs, toMs, cb) {
            if (!historyDb) { cb(null, []); return; }
            historyDb.queryHistoryAll(fromMs, toMs, cb);
        };

        node.publishLog = function (payload) {
            node.debug("Log event");
            this.emit("log_", payload);
        };

        // ── MCP ───────────────────────────────────────────────────────────────

        const mcpPrefix = (config.httpPathPrefix || '').replace(/\/$/, '');

        node.log('MCP enabled: ' + !!config.mcpEnabled + ', prefix: "' + mcpPrefix + '", location: "' + (config.locationName || '') + '"');

        if (config.mcpEnabled) {

            const mcpServerUrl  = config.mcpServerUrl  || '';
            const pocketidUrl   = config.pocketidUrl   || '';
            const mcpServerName = config.mcpServerName || 'hal2-mcp';

            node.log('MCP init: serverUrl=' + mcpServerUrl + ', pocketidUrl=' + pocketidUrl);
            const tokenTTL      = Number(config.tokenCacheTTL || 300) * 1000;
            const adminEnabled  = config.adminToolsEnabled === true;
            const adminPort     = Number(config.adminPort || 1880);

            let tokenCache = {};

            // ── Admin API helper ───────────────────────────────────────────────

            function adminApi(method, path, body) {
                const token = (node.credentials && node.credentials.adminToken) || '';
                const hdrs  = token ? { 'Authorization': 'Bearer ' + token } : {};
                return httpRequest(method, 'localhost', adminPort, path, hdrs, body);
            }

            // ── Token validation ───────────────────────────────────────────────

            const localDebugToken = (node.credentials && node.credentials.localDebugToken) || '';

            async function validateToken(token) {
                // Local debug token bypass — skips PocketID entirely
                if (localDebugToken && token === localDebugToken) {
                    return { sub: 'debug', name: 'Local debug user' };
                }

                const cacheKey = 'auth_' + crypto.createHash('sha256').update(token).digest('hex').slice(0, 20);
                if (tokenCache[cacheKey] && tokenCache[cacheKey].exp >= Date.now()) {
                    return tokenCache[cacheKey].user;
                }
                try {
                    const r = await httpGet(pocketidUrl + '/api/oidc/userinfo',
                        { 'Authorization': 'Bearer ' + token });
                    if (r.status !== 200) return null;
                    tokenCache[cacheKey] = { user: r.body, exp: Date.now() + tokenTTL };
                    return r.body;
                } catch (e) {
                    return null;
                }
            }

            // ── Device state helpers ───────────────────────────────────────────

            // Normalise a name for attribute key matching: lowercase + remove spaces/hyphens
            function normalise(str) {
                return (str || '').toLowerCase().replace(/[\s\-_]+/g, '');
            }

            // Build attribute name→value map for a thing
            function resolveAttributes(thing) {
                const map = {};
                if (!Array.isArray(thing.thingType.attributes)) return map;
                for (const attrDef of thing.thingType.attributes) {
                    if (!Array.isArray(thing.attributes)) break;
                    for (const a of thing.attributes) {
                        if (a.id === attrDef.id) {
                            map[normalise(attrDef.name)] = a.val;
                            break;
                        }
                    }
                }
                return map;
            }

            function msToIso(ms) {
                return (typeof ms === 'number' && ms > 0) ? new Date(ms).toISOString() : null;
            }

            function getAllStates() {
                const devices = [];
                RED.nodes.eachNode(function (cfg) {
                    if (cfg.type !== 'hal2Thing') return;
                    const thing = RED.nodes.getNode(cfg.id);
                    if (!thing || !thing.eventHandler || thing.eventHandler.id !== node.id) return;
                    const tt = thing.thingType;
                    if (!tt || !tt.items) return;

                    const attrMap = resolveAttributes(thing);
                    const lastChange = thing.last_change || {};

                    const items = [];
                    for (const i in tt.items) {
                        const itm = tt.items[i];
                        const ha_type = itm.id === '1' ? 'binary_sensor' : (itm.haType || '');
                        if (!ha_type) continue;
                        const label = attrMap[normalise(itm.name)] || null;
                        const entry = {
                            item_id     : itm.id,
                            item_name   : itm.name,
                            ha_type,
                            value       : (thing.state[itm.id] !== undefined) ? thing.state[itm.id] : 'no value',
                            last_change : msToIso(lastChange[itm.id])
                        };
                        if (label) entry.label = label;
                        if (itm.history) entry.history = true;
                        if (itm.notes) entry.notes = itm.notes;
                        if (Array.isArray(itm.tags) && itm.tags.length) entry.tags = itm.tags;
                        items.push(entry);
                    }

                    const deviceEntry = {
                        thing_id    : thing.id,
                        thing_name  : thing.name,
                        type_id     : tt.id,
                        type_name   : tt.name,
                        alive       : tt.hbCheck === false ? true : thing.state['1'] !== false,
                        last_change : msToIso(lastChange[thing.id]),
                        items
                    };
                    if (thing.notes) deviceEntry.notes = thing.notes;
                    if (Array.isArray(thing.tags) && thing.tags.length) deviceEntry.tags = thing.tags;
                    const categories = deriveCategories(items);
                    if (categories.length) deviceEntry.categories = categories;
                    devices.push(deviceEntry);

                });
                return devices;
            }

            function hasAnyHaType(wantedTypes) {
                const wanted = new Set(wantedTypes.map(s => s.toLowerCase()));
                for (const thing of getAllStates()) {
                    for (const item of thing.items) {
                        if (item.ha_type && wanted.has(item.ha_type.toLowerCase())) return true;
                    }
                }
                return false;
            }

            function getNotConfiguredError(toolName) {
                const reqs = TOOL_HARDWARE_REQUIREMENTS[toolName];
                if (!reqs) return null;
                if (hasAnyHaType(reqs)) return null;
                return {
                    error             : 'not_configured',
                    tool              : toolName,
                    required_ha_types : reqs,
                    message           : 'No matching hardware is configured at this location (' +
                                        (config.locationName || 'unnamed') + ').'
                };
            }

            // Log the per-location effective tool list once flows are fully loaded,
            // so all hal2Thing nodes have registered and hasAnyHaType can see them.
            RED.events.once('flows:started', () => {
                const exposed = MCP_TOOLS.filter(t => !getNotConfiguredError(t.name)).map(t => t.name);
                console.log('[hal2EventHandler] MCP_TOOLS exposed @ ' + (config.locationName || 'unnamed') + ': ' + exposed.join(', '));
            });

            function controlDevice(thingId, itemId, value) {
                console.log('[hal2EventHandler] controlDevice: thingId=' + thingId + ', itemId=' + itemId + ', value=' + JSON.stringify(value));
                const thing = RED.nodes.getNode(thingId);
                if (!thing || thing.type !== 'hal2Thing') {
                    console.log('[hal2EventHandler] controlDevice: thing not found or wrong type, type=' + (thing && thing.type));
                    return { error: 'Thing not found: ' + thingId };
                }
                if (!thing.eventHandler || thing.eventHandler.id !== node.id) {
                    console.log('[hal2EventHandler] controlDevice: eventHandler mismatch, thing.eh=' + (thing.eventHandler && thing.eventHandler.id) + ', node.id=' + node.id);
                    return { error: 'Thing not connected to this event handler' };
                }
                node.publishCommand(thingId, itemId, value);
                return { success: true, thing_name: thing.name, item_id: itemId, value };
            }

            // ── Auth middleware helper ─────────────────────────────────────────

            async function requireBearer(req, res) {
                const authHeader = req.headers['authorization'] || '';
                if (!authHeader.startsWith('Bearer ')) {
                    res.set('WWW-Authenticate',
                        `Bearer resource_metadata="${mcpServerUrl}/.well-known/oauth-protected-resource"`);
                    res.status(401).json({ error: 'unauthorized' });
                    return null;
                }
                const token = authHeader.slice(7);
                const user  = await validateToken(token);
                if (!user) {
                    res.set('WWW-Authenticate',
                        `Bearer error="invalid_token", resource_metadata="${mcpServerUrl}/.well-known/oauth-protected-resource"`);
                    res.status(401).json({ error: 'invalid_token' });
                    return null;
                }
                return user;
            }

            node.requireBearer = requireBearer;

            // ── OAuth: /.well-known/oauth-protected-resource ───────────────────

            node.log('MCP registering route: GET ' + mcpPrefix + '/.well-known/oauth-protected-resource');
            RED.httpNode.get(mcpPrefix + '/.well-known/oauth-protected-resource', (_req, res) => {
                res.status(200).json({
                    resource                 : mcpServerUrl,
                    authorization_servers    : [mcpServerUrl],
                    bearer_methods_supported : ['header'],
                    scopes_supported         : ['openid', 'profile', 'email']
                });
            });

            // ── OAuth: /.well-known/oauth-authorization-server ────────────────

            node.log('MCP registering route: GET ' + mcpPrefix + '/.well-known/oauth-authorization-server');
            RED.httpNode.get(mcpPrefix + '/.well-known/oauth-authorization-server', (_req, res) => {
                res.status(200).json({
                    issuer                                : mcpServerUrl,
                    authorization_endpoint                : pocketidUrl + '/authorize',
                    token_endpoint                        : pocketidUrl + '/api/oidc/token',
                    userinfo_endpoint                     : pocketidUrl + '/api/oidc/userinfo',
                    registration_endpoint                 : mcpServerUrl + mcpPrefix + '/oauth/register',
                    jwks_uri                              : pocketidUrl + '/.well-known/jwks.json',
                    scopes_supported                      : ['openid', 'profile', 'email'],
                    response_types_supported              : ['code'],
                    grant_types_supported                 : ['authorization_code', 'refresh_token'],
                    code_challenge_methods_supported      : ['S256'],
                    token_endpoint_auth_methods_supported : ['client_secret_post', 'none']
                });
            });

            // ── DCR: /oauth/register ──────────────────────────────────────────

            node.log('MCP registering route: POST ' + mcpPrefix + '/oauth/register');
            RED.httpNode.post(mcpPrefix + '/oauth/register', (req, res) => {
                const clientId     = (node.credentials && node.credentials.pocketidClientId)     || '';
                const clientSecret = (node.credentials && node.credentials.pocketidClientSecret) || '';
                const requested    = req.body || {};
                const redirectUris = requested.redirect_uris || ['https://claude.ai/api/mcp/auth_callback'];
                res.status(201).json({
                    client_id                  : clientId,
                    client_secret              : clientSecret,
                    client_id_issued_at        : Math.floor(Date.now() / 1000),
                    redirect_uris              : redirectUris,
                    grant_types                : ['authorization_code', 'refresh_token'],
                    response_types             : ['code'],
                    token_endpoint_auth_method : 'client_secret_post',
                    scope                      : 'openid profile email'
                });
            });

            // ── MCP: /mcp ─────────────────────────────────────────────────────

            node.log('MCP registering route: POST ' + mcpPrefix + '/mcp');
            RED.httpNode.post(mcpPrefix + '/mcp', async (req, res) => {
                // Bearer token validation
                const user = await requireBearer(req, res);
                if (!user) return;

                const body   = req.body || {};
                const id     = body.id     !== undefined ? body.id : null;
                const method = body.method || null;
                const params = body.params || {};

                const respond = result => res.status(200).json({ jsonrpc: '2.0', id, result });
                const rpcErr  = (c, m)  => res.status(200).json({ jsonrpc: '2.0', id, error: { code: c, message: m } });
                const toolOk  = text    => respond({ content: [{ type: 'text', text }] });

                // ── initialize ────────────────────────────────────────────────
                if (method === 'initialize') {
                    node.status({ fill: 'green', shape: 'dot', text: 'connected' });
                    res.set('Cache-Control', 'no-store');
                    return respond({
                        protocolVersion : '2024-11-05',
                        capabilities    : { tools: {} },
                        serverInfo      : { name: mcpServerName, version: '1.0.0' },
                        instructions    : (config.locationName ? 'This MCP server controls devices at location: ' + config.locationName + '. ' : '') +
                                          'Always call the appropriate tool to fetch live data — never rely on ' +
                                          'previously seen results. Device states, presence, sensor values and ' +
                                          'scene status can change at any time. When in doubt, call get_all_states ' +
                                          'or the relevant tool again before answering. ' +
                                          'Available tools: ' + [
                                              ...MCP_TOOLS.filter(t => !getNotConfiguredError(t.name)),
                                              ...(adminEnabled ? MCP_TOOLS_ADMIN : [])
                                          ].map(t => t.name).join(', ') + '.'
                    });
                }

                if (method === 'notifications/initialized') {
                    return res.status(204).send('');
                }

                // ── tools/list ────────────────────────────────────────────────
                if (method === 'tools/list') {
                    const tools = MCP_TOOLS.filter(t => !getNotConfiguredError(t.name));
                    if (adminEnabled) tools.push(...MCP_TOOLS_ADMIN);
                    for (const [name, t] of Object.entries(node.mcpRegisteredTools)) {
                        const s = t.schema;
                        const inputSchema = (s && s.type === 'object')
                            ? s
                            : { type: 'object', properties: s || {} };
                        tools.push({ name, description: t.description, inputSchema });
                    }
                    return respond({ tools });
                }

                // ── tools/call ────────────────────────────────────────────────
                if (method === 'tools/call') {
                    const toolName = params.name;
                    const args     = params.arguments || {};
                    console.log('[hal2EventHandler] tools/call: tool=' + toolName + ', args=' + JSON.stringify(args));

                    node.status({ fill: 'blue', shape: 'dot', text: toolName });

                    const notConfigured = getNotConfiguredError(toolName);
                    if (notConfigured) {
                        console.log('[hal2EventHandler] tools/call: ' + toolName + ' not_configured at ' + (config.locationName || ''));
                        return toolOk(JSON.stringify(notConfigured));
                    }

                    // get_all_states
                    if (toolName === 'get_all_states') {
                        let devices = getAllStates();

                        if (args.ha_type) {
                            const wanted = expandHaTypeFilter(args.ha_type);
                            devices = devices.filter(d => d.items.some(i => wanted.has(i.ha_type.toLowerCase())));
                        }

                        if (args.tag) {
                            const wanted = args.tag.toLowerCase();
                            devices = devices.filter(d =>
                                (d.tags || []).some(t => t.toLowerCase() === wanted) ||
                                d.items.some(i => (i.tags || []).some(t => t.toLowerCase() === wanted))
                            );
                        }

                        const total  = devices.length;
                        const offset = parseInt(args.offset) || 0;
                        const limit  = args.limit ? parseInt(args.limit) : undefined;
                        let paged    = limit !== undefined ? devices.slice(offset, offset + limit) : devices.slice(offset);

                        const fields = (args.fields || 'summary').toLowerCase();
                        if (fields === 'summary') {
                            paged = paged.map(d => {
                                const o = {
                                    thing_id    : d.thing_id,
                                    thing_name  : d.thing_name,
                                    type_name   : d.type_name,
                                    alive       : d.alive,
                                    last_change : d.last_change || null
                                };
                                if (d.notes)      o.notes      = d.notes;
                                if (d.tags)       o.tags       = d.tags;
                                if (d.categories) o.categories = d.categories;
                                return o;
                            });
                        }

                        const result = { total, offset, devices: paged };
                        if (limit !== undefined) result.limit = limit;
                        if (config.locationName) result.location = config.locationName;
                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify(result, null, 2));
                    }

                    // get_state
                    if (toolName === 'get_state') {
                        if (!args.thing_id && !args.thing_name) {
                            return toolOk(JSON.stringify({ error: 'Provide thing_id or thing_name' }));
                        }
                        const all = getAllStates();
                        let device;
                        if (args.thing_id) {
                            device = all.find(d => d.thing_id === args.thing_id);
                        } else {
                            const q = args.thing_name.toLowerCase();
                            device = all.find(d => d.thing_name.toLowerCase().includes(q));
                        }
                        if (!device) {
                            return toolOk(JSON.stringify({ error: 'Device not found' }));
                        }
                        if (args.item_id) {
                            const item = device.items.find(i => i.item_id === args.item_id);
                            if (!item) return toolOk(JSON.stringify({ error: 'Item not found' }));
                            return toolOk(JSON.stringify({
                                thing_id   : device.thing_id,
                                thing_name : device.thing_name,
                                ...item
                            }, null, 2));
                        }
                        return toolOk(JSON.stringify(device, null, 2));
                    }

                    // get_presence
                    if (toolName === 'get_presence') {
                        const nowMs = Date.now();
                        const minutesSinceIso = iso => iso ? Math.floor((nowMs - Date.parse(iso)) / 60000) : null;

                        const people = [];
                        for (const device of getAllStates()) {
                            const presenceItem = device.items.find(i => (i.ha_type || '').toLowerCase() === 'presence');
                            if (!presenceItem) continue;
                            const roomItem = device.items.find(i => (i.ha_type || '').toLowerCase() === 'room');
                            const home = presenceItem.value === true || presenceItem.value === 'true';

                            const entry = {
                                name             : device.thing_name,
                                home,
                                thing_id         : device.thing_id,
                                presence_item_id : presenceItem.item_id
                            };

                            const presenceChange = presenceItem.last_change || null;
                            if (home) {
                                entry.home_since       = presenceChange;
                                entry.home_for_minutes = minutesSinceIso(presenceChange);
                            } else {
                                entry.away_since       = presenceChange;
                                entry.away_for_minutes = minutesSinceIso(presenceChange);
                            }

                            entry.room = (home && roomItem) ? roomItem.value : null;
                            if (home && roomItem) {
                                const roomChange = roomItem.last_change || null;
                                entry.room_since          = roomChange;
                                entry.in_room_for_minutes = minutesSinceIso(roomChange);
                                entry.room_item_id        = roomItem.item_id;
                            }

                            if (presenceItem.notes) entry.notes = presenceItem.notes;
                            if (Array.isArray(presenceItem.tags) && presenceItem.tags.length) entry.tags = presenceItem.tags;

                            people.push(entry);
                        }
                        people.sort((a, b) => (b.home ? 1 : 0) - (a.home ? 1 : 0));

                        const people_home = people.filter(p => p.home).map(p => p.name);
                        const people_away = people.filter(p => !p.home).map(p => p.name);
                        const summary = {
                            home_count  : people_home.length,
                            away_count  : people_away.length,
                            anyone_home : people_home.length > 0,
                            people_home,
                            people_away
                        };

                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify({ summary, people }));
                    }

                    // control_fan
                    if (toolName === 'control_fan') {
                        const allStates = getAllStates();
                        let matched = [];
                        if (args.thing_id) {
                            const device = allStates.find(d => d.thing_id === args.thing_id);
                            if (device) matched = [device];
                        } else if (args.thing_name) {
                            const needle = args.thing_name.toLowerCase();
                            matched = allStates.filter(d => d.thing_name && d.thing_name.toLowerCase().includes(needle));
                        }

                        if (matched.length === 0) {
                            node.status({ fill: 'red', shape: 'dot', text: 'error' });
                            return toolOk(JSON.stringify({ error: 'No matching fan found', available: allStates.map(d => ({ thing_id: d.thing_id, thing_name: d.thing_name })) }));
                        }

                        if (args.speed === undefined) {
                            return toolOk(JSON.stringify({ error: 'Provide speed (0–3)' }));
                        }

                        const speed = Math.max(0, Math.min(3, Math.round(args.speed)));
                        const results = [];
                        for (const device of matched) {
                            const sent = [];
                            for (const itm of device.items) {
                                if ((itm.ha_type || '').toLowerCase() === 'fan') {
                                    node.publishCommand(device.thing_id, itm.item_id, speed);
                                    sent.push({ item_name: itm.item_name, value: speed });
                                }
                            }
                            results.push({ thing_name: device.thing_name, commands: sent });
                        }

                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify({ success: true, results }));
                    }

                    // get_scenes
                    if (toolName === 'get_scenes') {
                        const needle = args.name ? args.name.toLowerCase() : null;
                        const scenes = [];
                        for (const device of getAllStates()) {
                            const sceneItem = device.items.find(i => (i.ha_type || '').toLowerCase() === 'scene');
                            if (!sceneItem) continue;
                            if (needle && !device.thing_name.toLowerCase().includes(needle)) continue;
                            scenes.push({
                                thing_id    : device.thing_id,
                                thing_name  : device.thing_name,
                                active      : sceneItem.value === true || sceneItem.value === 'true',
                                last_change : sceneItem.last_change || null
                            });
                        }
                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify({ scenes }));
                    }

                    // activate_scene
                    if (toolName === 'activate_scene') {
                        const allStates = getAllStates();
                        let matched = [];
                        if (args.thing_id) {
                            const device = allStates.find(d => d.thing_id === args.thing_id);
                            if (device) matched = [device];
                        } else if (args.thing_name) {
                            const needle = args.thing_name.toLowerCase();
                            matched = allStates.filter(d => d.thing_name && d.thing_name.toLowerCase().includes(needle));
                        }

                        if (matched.length === 0) {
                            node.status({ fill: 'red', shape: 'dot', text: 'error' });
                            return toolOk(JSON.stringify({ error: 'No matching scene found' }));
                        }

                        const results = [];
                        for (const device of matched) {
                            const sceneItem = device.items.find(i => (i.ha_type || '').toLowerCase() === 'scene');
                            if (!sceneItem) continue;
                            node.publishCommand(device.thing_id, sceneItem.item_id, args.active);
                            results.push({ thing_name: device.thing_name, active: args.active });
                        }

                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify({ success: true, results }));
                    }

                    // control_cover
                    if (toolName === 'control_cover') {
                        const allStates = getAllStates();
                        let matched = [];
                        if (args.thing_id) {
                            const device = allStates.find(d => d.thing_id === args.thing_id);
                            if (device) matched = [device];
                        } else if (args.thing_name) {
                            const needle = args.thing_name.toLowerCase();
                            matched = allStates.filter(d => d.thing_name && d.thing_name.toLowerCase().includes(needle));
                        }

                        if (matched.length === 0) {
                            node.status({ fill: 'red', shape: 'dot', text: 'error' });
                            return toolOk(JSON.stringify({ error: 'No matching cover found', available: allStates.map(d => ({ thing_id: d.thing_id, thing_name: d.thing_name })) }));
                        }

                        // Resolve target position
                        let position;
                        if (args.position !== undefined) {
                            position = Math.max(0, Math.min(100, args.position));
                        } else if (args.open !== undefined) {
                            position = args.open ? 100 : 0;
                        }

                        if (position === undefined) {
                            return toolOk(JSON.stringify({ error: 'Provide position (0–100) or open (true/false)' }));
                        }

                        const results = [];
                        for (const device of matched) {
                            const sent = [];
                            for (const itm of device.items) {
                                if ((itm.ha_type || '').toLowerCase() === 'cover') {
                                    node.publishCommand(device.thing_id, itm.item_id, position);
                                    sent.push({ item_name: itm.item_name, value: position });
                                }
                            }
                            results.push({ thing_name: device.thing_name, commands: sent });
                        }

                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify({ success: true, results }));
                    }

                    // control_spa
                    if (toolName === 'control_spa') {
                        const allStates = getAllStates();
                        let matched = [];
                        if (args.thing_id) {
                            const device = allStates.find(d => d.thing_id === args.thing_id);
                            if (device) matched = [device];
                        } else if (args.thing_name) {
                            const needle = args.thing_name.toLowerCase();
                            matched = allStates.filter(d => d.thing_name && d.thing_name.toLowerCase().includes(needle));
                        }

                        if (matched.length === 0) {
                            node.status({ fill: 'red', shape: 'dot', text: 'error' });
                            return toolOk(JSON.stringify({ error: 'No matching spa found', available: allStates.map(d => ({ thing_id: d.thing_id, thing_name: d.thing_name })) }));
                        }

                        const results = [];
                        for (const device of matched) {
                            const sent = [];
                            for (const itm of device.items) {
                                const ht = (itm.ha_type || '').toLowerCase();
                                if (ht === 'target temperature' && args.target_temp !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.target_temp);
                                    sent.push({ item_name: itm.item_name, value: args.target_temp });
                                }
                                if (ht === 'heater' && args.heater !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.heater);
                                    sent.push({ item_name: itm.item_name, value: args.heater });
                                }
                                if (ht === 'circulation pump' && args.pump !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.pump);
                                    sent.push({ item_name: itm.item_name, value: args.pump });
                                }
                                if (ht === 'airjets' && args.airjets !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.airjets);
                                    sent.push({ item_name: itm.item_name, value: args.airjets });
                                }
                            }
                            results.push({ thing_name: device.thing_name, commands: sent });
                        }

                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify({ success: true, results }));
                    }

                    // control_climate
                    if (toolName === 'control_climate') {
                        const allStates = getAllStates();
                        let matched = [];
                        if (args.thing_id) {
                            const device = allStates.find(d => d.thing_id === args.thing_id);
                            if (device) matched = [device];
                        } else if (args.thing_name) {
                            const needle = args.thing_name.toLowerCase();
                            matched = allStates.filter(d => d.thing_name && d.thing_name.toLowerCase().includes(needle));
                        }

                        if (matched.length === 0) {
                            node.status({ fill: 'red', shape: 'dot', text: 'error' });
                            return toolOk(JSON.stringify({ error: 'No matching climate device found', available: allStates.map(d => ({ thing_id: d.thing_id, thing_name: d.thing_name })) }));
                        }

                        const results = [];
                        for (const device of matched) {
                            const sent = [];
                            for (const itm of device.items) {
                                const ht = (itm.ha_type || '').toLowerCase();
                                if (ht === 'ac mode' && args.mode !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.mode);
                                    sent.push({ item_name: itm.item_name, value: args.mode });
                                }
                                if (ht === 'target temperature' && args.target_temp !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.target_temp);
                                    sent.push({ item_name: itm.item_name, value: args.target_temp });
                                }
                                if (ht === 'fan mode' && args.fan_mode !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.fan_mode);
                                    sent.push({ item_name: itm.item_name, value: args.fan_mode });
                                }
                                if (ht === 'swing mode' && args.swing_mode !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.swing_mode);
                                    sent.push({ item_name: itm.item_name, value: args.swing_mode });
                                }
                            }
                            results.push({ thing_name: device.thing_name, commands: sent });
                        }

                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify({ success: true, results }));
                    }

                    // get_alerts
                    if (toolName === 'get_alerts') {
                        const threshold = args.battery_threshold !== undefined ? Number(args.battery_threshold) : 20;
                        const sensors = [];
                        const low = [];
                        const offline = [];
                        for (const device of getAllStates()) {
                            if (!device.alive) {
                                const aliveItem = device.items.find(i => i.item_id === '1');
                                offline.push({
                                    thing_id    : device.thing_id,
                                    thing_name  : device.thing_name,
                                    type_name   : device.type_name,
                                    last_change : (aliveItem && aliveItem.last_change) || null
                                });
                            }
                            const waterItem = device.items.find(i => (i.ha_type || '').toLowerCase() === 'water leak');
                            if (waterItem) {
                                sensors.push({
                                    thing_id    : device.thing_id,
                                    thing_name  : device.thing_name,
                                    wet         : waterItem.value === true || waterItem.value === 'true',
                                    last_change : waterItem.last_change || null
                                });
                            }
                            for (const itm of device.items) {
                                if ((itm.ha_type || '').toLowerCase() === 'battery') {
                                    const level = Number(itm.value);
                                    if (!isNaN(level) && level < threshold) {
                                        low.push({
                                            thing_id    : device.thing_id,
                                            thing_name  : device.thing_name,
                                            item_id     : itm.item_id,
                                            item_name   : itm.item_name,
                                            battery     : level,
                                            last_change : itm.last_change || null
                                        });
                                    }
                                }
                            }
                        }
                        sensors.sort((a, b) => (b.wet ? 1 : 0) - (a.wet ? 1 : 0));
                        low.sort((a, b) => a.battery - b.battery);
                        const hasAlert = sensors.some(s => s.wet) || offline.length > 0;
                        node.status({ fill: hasAlert ? 'red' : 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify({ water_sensors: sensors, any_wet: sensors.some(s => s.wet), low_battery_devices: low, battery_threshold: threshold, offline_devices: offline }));
                    }

                    // control_device
                    if (toolName === 'control_device') {
                        const result = controlDevice(args.thing_id, args.item_id, args.value);
                        node.status({ fill: result.error ? 'red' : 'green', shape: 'dot', text: result.error ? 'error' : 'ready' });
                        return toolOk(JSON.stringify(result));
                    }

                    // set_light / control_light
                    if (toolName === 'set_light' || toolName === 'control_light') {
                        console.log('[hal2EventHandler] set_light called, args=' + JSON.stringify(args));

                        // Use getAllStates() so search is consistent with what Claude sees
                        const allStates = getAllStates();

                        // matched = array of { device, items } where items may be filtered to a subset
                        let matched = [];
                        if (args.thing_id) {
                            const device = allStates.find(d => d.thing_id === args.thing_id);
                            if (device) matched = [{ device, items: device.items }];
                            console.log('[hal2EventHandler] set_light by id "' + args.thing_id + '": matched=' + matched.length);
                        } else if (args.thing_name) {
                            const needle = args.thing_name.toLowerCase();
                            // First try matching thing_name
                            for (const device of allStates) {
                                if (device.thing_name && device.thing_name.toLowerCase().includes(needle)) {
                                    matched.push({ device, items: device.items });
                                }
                            }
                            // If nothing matched thing_name, try matching item labels
                            if (matched.length === 0) {
                                for (const device of allStates) {
                                    const labelItems = device.items.filter(itm => itm.label && itm.label.toLowerCase().includes(needle));
                                    if (labelItems.length > 0) matched.push({ device, items: labelItems });
                                }
                            }
                            console.log('[hal2EventHandler] set_light by name "' + args.thing_name + '": matched=' + matched.length);
                        }

                        if (matched.length === 0) {
                            node.status({ fill: 'red', shape: 'dot', text: 'error' });
                            const available = allStates.map(d => ({
                                thing_id: d.thing_id, thing_name: d.thing_name,
                                labels: d.items.filter(i => i.label).map(i => i.label)
                            }));
                            return toolOk(JSON.stringify({ error: 'No matching thing found', thing_id: args.thing_id, thing_name: args.thing_name, available }));
                        }

                        const results = [];
                        for (const { device, items } of matched) {
                            const sent = [];
                            for (const itm of items) {
                                const ht = (itm.ha_type || '').toLowerCase();
                                console.log('[hal2EventHandler] set_light item: "' + itm.item_name + '" label="' + (itm.label || '') + '" ha_type="' + ht + '"');
                                if ((ht === 'light' || ht === 'switch') && args.on !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.on);
                                    sent.push({ item_id: itm.item_id, item_name: itm.item_name, label: itm.label, value: args.on });
                                }
                                if (ht === 'dimmer' && args.brightness !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.brightness);
                                    sent.push({ item_id: itm.item_id, item_name: itm.item_name, label: itm.label, value: args.brightness });
                                }
                                if (ht === 'color temperature' && args.color_temp !== undefined) {
                                    // Convert Kelvin → percent, 100% = warmest (2700K), 0% = coolest (6500K)
                                    const CT_MIN = 2700, CT_MAX = 6500;
                                    const ctPct = Math.round(Math.max(0, Math.min(100,
                                        (CT_MAX - args.color_temp) / (CT_MAX - CT_MIN) * 100
                                    )));
                                    node.publishCommand(device.thing_id, itm.item_id, ctPct);
                                    sent.push({ item_id: itm.item_id, item_name: itm.item_name, label: itm.label, value: ctPct, kelvin: args.color_temp });
                                }
                                if (ht === 'color' && args.color !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.color);
                                    sent.push({ item_id: itm.item_id, item_name: itm.item_name, label: itm.label, value: args.color });
                                }
                            }
                            results.push({ thing_id: device.thing_id, thing_name: device.thing_name, commands: sent });
                        }

                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify({ success: true, results }));
                    }

                    // Admin tools — handled internally
                    if (adminEnabled && MCP_ADMIN_TOOL_NAMES.has(toolName)) {
                        try {
                            if (toolName === 'get_flow') {
                                if (!args.id) {
                                    const r        = await adminApi('GET', '/flows');
                                    const allNodes = Array.isArray(r.body) ? r.body
                                        : (Array.isArray(r.body?.flows) ? r.body.flows : []);
                                    const tabs  = allNodes.filter(n => n.type === 'tab');
                                    const lines = ['**Node-RED flikar:**', ''];
                                    tabs.forEach(tab => {
                                        const count = allNodes.filter(n => n.z === tab.id).length;
                                        lines.push('- **' + tab.label + '**' + (tab.disabled ? ' [inaktiv]' : ''));
                                        lines.push('  ID: `' + tab.id + '`  |  Noder: ' + count);
                                    });
                                    node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                                    return toolOk(lines.join('\n'));
                                }
                                const r = await adminApi('GET', '/flow/' + args.id);
                                if (r.status === 404) {
                                    node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                                    return toolOk('Flöde \'' + args.id + '\' hittades inte.');
                                }
                                node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                                return toolOk(JSON.stringify(r.body, null, 2));
                            }

                            if (toolName === 'deploy_flow') {
                                const tabId    = args.id || crypto.randomBytes(8).toString('hex').slice(0, 16);
                                const nodes    = (args.nodes || []).map(n => Object.assign({}, n, { z: n.z || tabId }));
                                const flowBody = { id: tabId, label: args.label, nodes };
                                const r = args.id
                                    ? await adminApi('PUT',  '/flow/' + args.id, flowBody)
                                    : await adminApi('POST', '/flow',             flowBody);
                                node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                                if (r.status === 200 || r.status === 204) {
                                    return toolOk('Flödet \'' + args.label + '\' deployades. ID: ' + (r.body.id || tabId));
                                }
                                return toolOk('Deploy misslyckades (' + r.status + '): ' + JSON.stringify(r.body));
                            }
                        } catch (e) {
                            node.status({ fill: 'red', shape: 'ring', text: 'admin error' });
                            return toolOk('Fel vid admin-anrop: ' + e.message);
                        }
                    }

                    // get_history
                    if (toolName === 'get_history') {
                        if (!historyDb) {
                            return toolOk(JSON.stringify({ error: 'History is not enabled on this event handler' }));
                        }
                        let targetThing = null;
                        if (args.thing_id) {
                            targetThing = RED.nodes.getNode(args.thing_id);
                            if (!targetThing || targetThing.type !== 'hal2Thing') {
                                return toolOk(JSON.stringify({ error: 'Thing not found: ' + args.thing_id }));
                            }
                        } else if (args.thing_name) {
                            const needle = args.thing_name.toLowerCase();
                            RED.nodes.eachNode(cfg => {
                                if (targetThing || cfg.type !== 'hal2Thing') return;
                                const t = RED.nodes.getNode(cfg.id);
                                if (t && t.eventHandler && t.eventHandler.id === node.id && t.name.toLowerCase().includes(needle)) {
                                    targetThing = t;
                                }
                            });
                            if (!targetThing) return toolOk(JSON.stringify({ error: 'No thing matching: ' + args.thing_name }));
                        } else {
                            return toolOk(JSON.stringify({ error: 'Provide thing_id or thing_name' }));
                        }

                        let itemId = args.item_id;
                        if (!itemId && args.item_name) {
                            const needle = args.item_name.toLowerCase();
                            const found = targetThing.thingType.items.find(i => i.name.toLowerCase().includes(needle));
                            if (!found) return toolOk(JSON.stringify({ error: 'No item matching: ' + args.item_name }));
                            if (!found.history) return toolOk(JSON.stringify({ error: 'History not enabled for item: ' + found.name }));
                            itemId = found.id;
                        } else if (itemId) {
                            const found = targetThing.thingType.items.find(i => i.id === itemId);
                            if (found && !found.history) return toolOk(JSON.stringify({ error: 'History not enabled for item: ' + found.name }));
                        } else {
                            return toolOk(JSON.stringify({ error: 'Provide item_id or item_name' }));
                        }

                        function parseTimeArg(v) {
                            if (!v) return null;
                            const n = Number(v);
                            return isNaN(n) ? new Date(v).getTime() : n;
                        }

                        const nowMs  = Date.now();
                        const atMs   = parseTimeArg(args.at);
                        const fromMs = atMs ? null : (parseTimeArg(args.from) ?? (nowMs - (Number(args.hours) || 24) * 3600000));
                        const toMs   = atMs ? null : (parseTimeArg(args.to)   ?? nowMs);

                        if ((fromMs !== null && isNaN(fromMs)) || (toMs !== null && isNaN(toMs)) || (atMs !== null && isNaN(atMs))) {
                            return toolOk(JSON.stringify({ error: 'Invalid date/time value in from, to, or at' }));
                        }

                        try {
                            const docs = await new Promise((resolve, reject) => {
                                node.queryHistory(targetThing.id, itemId, atMs ? 0 : fromMs, atMs ?? toMs, (err, d) => err ? reject(err) : resolve(d));
                            });
                            node.status({ fill: 'green', shape: 'dot', text: 'ready' });

                            if (atMs !== null) {
                                const record = docs.length ? docs[docs.length - 1] : null;
                                return toolOk(JSON.stringify({
                                    thing_id  : targetThing.id,
                                    thing_name: targetThing.name,
                                    item_id   : itemId,
                                    at        : new Date(atMs).toISOString(),
                                    record    : record ? { timestamp: msToIso(record.ts), state: record.state } : null
                                }));
                            }

                            const offset = parseInt(args.offset) || 0;
                            const limit  = parseInt(args.limit)  || 500;
                            const page   = docs.slice(offset, offset + limit);
                            return toolOk(JSON.stringify({
                                thing_id  : targetThing.id,
                                thing_name: targetThing.name,
                                item_id   : itemId,
                                from      : new Date(fromMs).toISOString(),
                                to        : new Date(toMs).toISOString(),
                                total     : docs.length,
                                offset,
                                limit,
                                data      : page.map(d => ({ timestamp: msToIso(d.ts), state: d.state }))
                            }));
                        } catch (e) {
                            return toolOk(JSON.stringify({ error: 'History query failed: ' + e.message }));
                        }
                    }

                    // analyze_patterns
                    if (toolName === 'analyze_patterns') {
                        if (!historyDb) {
                            return toolOk(JSON.stringify({ error: 'History is not enabled on this event handler' }));
                        }
                        const days           = Math.max(1, Math.min(365, Number(args.days)            || 30));
                        const windowMinutes  = Math.max(5, Math.min(120, Number(args.window_minutes)  || 30));
                        const threshold      = Math.max(0, Math.min(1,   Number(args.threshold)       || 0.7));
                        const minOccurrences = Math.max(1,               Number(args.min_occurrences) || 2);
                        const numericPrecision = Math.max(1, Math.min(6, Number(args.numeric_precision) || 2));
                        const fromMs         = Date.now() - days * 24 * 3600000;

                        const thingNameMap = new Map();
                        for (const d of getAllStates()) {
                            const itemMap = new Map();
                            for (const itm of d.items) {
                                itemMap.set(itm.item_id, { item_name: itm.item_name, ha_type: itm.ha_type });
                            }
                            thingNameMap.set(d.thing_id, { thing_name: d.thing_name, items: itemMap });
                        }

                        try {
                            const docs = await new Promise((resolve, reject) => {
                                node.queryHistoryAll(fromMs, Date.now(), (err, d) => err ? reject(err) : resolve(d));
                            });
                            const result = analyzePatterns(docs, thingNameMap, {
                                windowMinutes, threshold, minOccurrences, numericPrecision,
                                includeSensors : args.include_sensors === true,
                                includeInternal: args.include_internal === true
                            });
                            result.lookback_days = days;
                            node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                            return toolOk(JSON.stringify(result, null, 2));
                        } catch (e) {
                            return toolOk(JSON.stringify({ error: 'Pattern analysis failed: ' + e.message }));
                        }
                    }

                    // Dynamically registered tools (hal2MCPIn/Out)
                    if (node.mcpRegisteredTools[toolName]) {
                        try {
                            const callId     = crypto.randomBytes(16).toString('hex');
                            const timeoutMs  = node.mcpRegisteredTools[toolName].timeoutMs || 30000;
                            const result = await new Promise((resolve, reject) => {
                                const timer = setTimeout(() => {
                                    delete node.mcpPendingCalls[callId];
                                    reject(new Error('timeout'));
                                }, timeoutMs);
                                node.mcpPendingCalls[callId] = { resolve, reject, timer };
                                node.emit('mcp_tool_' + toolName, { args, _mcpCallId: callId });
                            });
                            node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                            return Array.isArray(result)
                                ? respond({ content: result })
                                : toolOk(result);
                        } catch (e) {
                            node.status({ fill: 'red', shape: 'dot', text: 'timeout' });
                            return toolOk(JSON.stringify({ error: e.message === 'timeout' ? 'Tool timed out: ' + toolName : e.message }));
                        }
                    }

                    return rpcErr(-32601, 'Unknown tool: ' + toolName);
                }

                return rpcErr(-32601, 'Unknown method: ' + (method || 'null'));
            });

            node.status({ fill: 'green', shape: 'dot', text: 'ready' });
        }

        // ── Close ─────────────────────────────────────────────────────────────

        node.on('close', function () {
            // Reject any pending dynamic tool calls
            for (const [, pending] of Object.entries(node.mcpPendingCalls)) {
                clearTimeout(pending.timer);
                pending.reject(new Error('Event handler closing'));
            }
            node.mcpPendingCalls = {};

            node.log('MCP close: mcpEnabled=' + !!config.mcpEnabled);
            if (config.mcpEnabled) {
                tokenCache = {};
                node.log('MCP removing routes with prefix: "' + mcpPrefix + '"');
                removeRoute(RED, 'get',  mcpPrefix + '/.well-known/oauth-protected-resource');
                removeRoute(RED, 'get',  mcpPrefix + '/.well-known/oauth-authorization-server');
                removeRoute(RED, 'post', mcpPrefix + '/oauth/register');
                removeRoute(RED, 'post', mcpPrefix + '/mcp');
            }
        });
    }

    RED.nodes.registerType("hal2EventHandler", hal2EventHandler, {
        credentials: {
            pocketidClientId     : { type: 'text' },
            pocketidClientSecret : { type: 'password' },
            adminToken           : { type: 'password' },
            localDebugToken      : { type: 'password' }
        }
    });
};

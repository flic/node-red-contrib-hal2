const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

// ── MCP tool definitions ──────────────────────────────────────────────────────

const MCP_TOOLS = [
    {
        name        : 'get_all_states',
        description : 'Returns the current state of all devices/things connected to this event handler. ' +
                      'The response includes a location field (e.g. "Hemma" or "Landet") identifying which ' +
                      'property this server controls, and a devices array where each device has thing_id, ' +
                      'thing_name, type_name and a list of items with item_id, item_name, ha_type and current value.',
        inputSchema : { type: 'object', properties: {} }
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
        description : 'Returns all scenes with their current status (active/inactive). ' +
                      'Use this to answer "is scene X active?" or "which scenes are active right now?".',
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
        name        : 'get_presence',
        description : 'Returns presence information for all people/persons tracked in the system. ' +
                      'Shows who is home, who is away, and which room each person is in. ' +
                      'Use this to answer questions like "is anyone home?", "where is Fredrik?", ' +
                      '"who is home right now?".',
        inputSchema : { type: 'object', properties: {} }
    },
    {
        name        : 'get_water_sensors',
        description : 'Returns status of all water leak sensors. ' +
                      'Use this to answer "is there a water leak?", "are any water sensors triggered?" etc. ' +
                      'Triggered sensors (wet=true) are listed first.',
        inputSchema : { type: 'object', properties: {} }
    },
    {
        name        : 'get_low_battery',
        description : 'Returns all devices that have a battery level below a given threshold. ' +
                      'Use this to answer questions like "which sensors have low battery?" or "what needs new batteries?".',
        inputSchema : {
            type       : 'object',
            properties : {
                threshold : { type: 'number', description: 'Battery level threshold in percent (default: 20)', minimum: 0, maximum: 100 }
            }
        }
    },
    {
        name        : 'get_history',
        description : 'Returns logged historical values for a specific device item. ' +
                      'Only items with history logging enabled are available. ' +
                      'Use get_all_states to find thing_id and item_id. ' +
                      'Returns an array of {ts, state} objects sorted oldest-first.',
        inputSchema : {
            type       : 'object',
            properties : {
                thing_id   : { type: 'string', description: 'Exact thing node ID (from get_all_states)' },
                thing_name : { type: 'string', description: 'Partial, case-insensitive name match (alternative to thing_id)' },
                item_id    : { type: 'string', description: 'Item ID (from get_all_states)' },
                item_name  : { type: 'string', description: 'Item name, partial case-insensitive match (alternative to item_id)' },
                hours      : { type: 'number', description: 'How many hours back to fetch (default: 24)', minimum: 0.1 }
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
                      'You can turn it on/off and/or set brightness/color_temp in one call.',
        inputSchema : {
            type       : 'object',
            properties : {
                thing_id   : { type: 'string',  description: 'Exact thing node ID (from get_all_states). Takes priority over thing_name.' },
                thing_name : { type: 'string',  description: 'Partial, case-insensitive name match (e.g. "kontor" matches "Kontor Spotlights").' },
                on         : { type: 'boolean', description: 'true = turn on, false = turn off' },
                brightness : { type: 'number',  description: 'Brightness 0–100 (percent)', minimum: 0, maximum: 100 },
                color_temp : { type: 'number',  description: 'Color temperature in Kelvin (e.g. 2700 = warm white, 4000 = neutral, 6500 = cool wide)' }
            }
        }
    }
];

const MCP_TOOLS_ADMIN = [
    {
        name        : 'get_flows',
        description : 'Lists all Node-RED tabs with ID and node count.',
        inputSchema : { type: 'object', properties: {} }
    },
    {
        name        : 'get_flow',
        description : 'Returns full JSON configuration for a Node-RED tab.',
        inputSchema : {
            type       : 'object',
            required   : ['id'],
            properties : {
                id : { type: 'string', description: 'Flow/tab ID' }
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

console.log('[hal2EventHandler] module loaded');

module.exports = function(RED) {

    function hal2EventHandler(config) {
        RED.nodes.createNode(this, config);
        console.log('[hal2EventHandler] constructor called, id=' + config.id + ', mcpEnabled=' + !!config.mcpEnabled);

        this.host         = config.name;
        this.contextStore = config.contextStore;
        this.maxlisteners = config.maxlisteners;
        this.heartbeat    = config.heartbeat;
        this.items        = config.items;

        if (typeof this.contextStore === 'undefined') { this.contextStore = ''; }

        const node  = this;

        // ── Dynamic MCP tool registry (used by hal2MCPIn / hal2MCPOut) ─────────

        node.mcpRegisteredTools = {};
        node.mcpPendingCalls    = {};

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
            const Datastore = require('@seald-io/nedb');
            const retentionMs = (Number(config.historyRetentionDays) || 30) * 24 * 60 * 60 * 1000;

            (async () => {
                try {
                    historyDb = new Datastore({ filename: config.historyDbPath });
                    await historyDb.loadDatabaseAsync();
                    await historyDb.ensureIndexAsync({ fieldName: 'ts' });
                    await historyDb.ensureIndexAsync({ fieldName: 'thing_id' });
                    node.log('History enabled, db: ' + config.historyDbPath);

                    const pruneHistory = async () => {
                        const n = await historyDb.removeAsync({ ts: { $lt: Date.now() - retentionMs } }, { multi: true });
                        if (n > 0) { node.log('History pruned ' + n + ' records'); }
                    };
                    await pruneHistory();
                    const historyPruneInterval = setInterval(pruneHistory, 60 * 60 * 1000);
                    node.on('close', () => clearInterval(historyPruneInterval));
                } catch (err) {
                    node.error('History init failed: ' + err.message);
                    historyDb = null;
                }
            })();
        }

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
            this.emit("command_" + id, itemid, payload);
        };

        node.publishUpdate = function (thingtypeid, thingid, itemid, payload) {
            if (historyDb && thingtypeid) {
                const thingType = RED.nodes.getNode(thingtypeid);
                if (thingType && thingType.items) {
                    const item = thingType.items.find(i => i.id === itemid);
                    if (item && item.history) {
                        historyDb.insert({ thing_id: thingid, item_id: itemid, state: payload.state, ts: Date.now() });
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
            historyDb.find({ thing_id: thingid, item_id: itemid, ts: { $gte: fromMs, $lte: toMs } })
                .sort({ ts: 1 })
                .exec(cb);
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

            function getAllStates() {
                const devices = [];
                RED.nodes.eachNode(function (cfg) {
                    if (cfg.type !== 'hal2Thing') return;
                    const thing = RED.nodes.getNode(cfg.id);
                    if (!thing || !thing.eventHandler || thing.eventHandler.id !== node.id) return;
                    const tt = thing.thingType;
                    if (!tt || !tt.items) return;

                    const attrMap = resolveAttributes(thing);

                    const items = [];
                    for (const i in tt.items) {
                        const itm = tt.items[i];
                        if (itm.id === '1') continue; // skip heartbeat alive item
                        const label = attrMap[normalise(itm.name)] || null;
                        const entry = {
                            item_id   : itm.id,
                            item_name : itm.name,
                            ha_type   : itm.haType || '',
                            value     : (thing.state[itm.id] !== undefined) ? thing.state[itm.id] : 'no value'
                        };
                        if (label) entry.label = label;
                        items.push(entry);
                    }

                    devices.push({
                        thing_id   : thing.id,
                        thing_name : thing.name,
                        type_id    : tt.id,
                        type_name  : tt.name,
                        items
                    });

                });
                return devices;
            }

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
                                          'or the relevant tool again before answering.'
                    });
                }

                if (method === 'notifications/initialized') {
                    return res.status(204).send('');
                }

                // ── tools/list ────────────────────────────────────────────────
                if (method === 'tools/list') {
                    const tools = [...MCP_TOOLS];
                    if (adminEnabled) tools.push(...MCP_TOOLS_ADMIN);
                    for (const [name, t] of Object.entries(node.mcpRegisteredTools)) {
                        tools.push({ name, description: t.description, inputSchema: t.schema || { type: 'object', properties: {} } });
                    }
                    return respond({ tools });
                }

                // ── tools/call ────────────────────────────────────────────────
                if (method === 'tools/call') {
                    const toolName = params.name;
                    const args     = params.arguments || {};
                    console.log('[hal2EventHandler] tools/call: tool=' + toolName + ', args=' + JSON.stringify(args));

                    node.status({ fill: 'blue', shape: 'dot', text: toolName });

                    // get_all_states
                    if (toolName === 'get_all_states') {
                        const result = { devices: getAllStates() };
                        if (config.locationName) result.location = config.locationName;
                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify(result, null, 2));
                    }

                    // get_presence
                    if (toolName === 'get_presence') {
                        const people = [];
                        for (const device of getAllStates()) {
                            const presenceItem = device.items.find(i => (i.ha_type || '').toLowerCase() === 'presence');
                            if (!presenceItem) continue;
                            const roomItem = device.items.find(i => (i.ha_type || '').toLowerCase() === 'room');
                            const home = presenceItem.value === true || presenceItem.value === 'true';
                            people.push({
                                name  : device.thing_name,
                                home,
                                room  : (home && roomItem) ? roomItem.value : null
                            });
                        }
                        people.sort((a, b) => (b.home ? 1 : 0) - (a.home ? 1 : 0));
                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify({ people }));
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
                                thing_id   : device.thing_id,
                                thing_name : device.thing_name,
                                active     : sceneItem.value === true || sceneItem.value === 'true'
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

                    // get_water_sensors
                    if (toolName === 'get_water_sensors') {
                        const sensors = [];
                        for (const device of getAllStates()) {
                            const waterItem = device.items.find(i => (i.ha_type || '').toLowerCase() === 'water leak');
                            if (!waterItem) continue;
                            const wet = waterItem.value === true || waterItem.value === 'true';
                            sensors.push({
                                thing_id   : device.thing_id,
                                thing_name : device.thing_name,
                                wet
                            });
                        }
                        sensors.sort((a, b) => (b.wet ? 1 : 0) - (a.wet ? 1 : 0));
                        node.status({ fill: sensors.some(s => s.wet) ? 'red' : 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify({ sensors, any_wet: sensors.some(s => s.wet) }));
                    }

                    // get_low_battery
                    if (toolName === 'get_low_battery') {
                        const threshold = args.threshold !== undefined ? Number(args.threshold) : 20;
                        const low = [];
                        for (const device of getAllStates()) {
                            for (const itm of device.items) {
                                if ((itm.ha_type || '').toLowerCase() === 'battery') {
                                    const level = Number(itm.value);
                                    if (!isNaN(level) && level < threshold) {
                                        low.push({
                                            thing_id   : device.thing_id,
                                            thing_name : device.thing_name,
                                            item_id    : itm.item_id,
                                            item_name  : itm.item_name,
                                            battery    : level
                                        });
                                    }
                                }
                            }
                        }
                        low.sort((a, b) => a.battery - b.battery);
                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify({ threshold, low_battery_devices: low }));
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
                            }
                            results.push({ thing_id: device.thing_id, thing_name: device.thing_name, commands: sent });
                        }

                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify({ success: true, results }));
                    }

                    // Admin tools — handled internally
                    if (adminEnabled && MCP_ADMIN_TOOL_NAMES.has(toolName)) {
                        try {
                            if (toolName === 'get_flows') {
                                const r       = await adminApi('GET', '/flows');
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

                            if (toolName === 'get_flow') {
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

                        const hours  = Number(args.hours) || 24;
                        const fromMs = Date.now() - hours * 3600000;
                        try {
                            const docs = await new Promise((resolve, reject) => {
                                node.queryHistory(targetThing.id, itemId, fromMs, Date.now(), (err, d) => err ? reject(err) : resolve(d));
                            });
                            node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                            return toolOk(JSON.stringify({
                                thing_id  : targetThing.id,
                                thing_name: targetThing.name,
                                item_id   : itemId,
                                hours,
                                count     : docs.length,
                                data      : docs.map(d => ({ ts: d.ts, state: d.state }))
                            }));
                        } catch (e) {
                            return toolOk(JSON.stringify({ error: 'History query failed: ' + e.message }));
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
                            return toolOk(result);
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

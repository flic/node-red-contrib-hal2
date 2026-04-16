const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

// ── MCP tool definitions ──────────────────────────────────────────────────────

const MCP_TOOLS = [
    {
        name        : 'get_all_states',
        description : 'Returns the current state of all devices/things connected to this event handler. ' +
                      'Each device has thing_id, thing_name, type_name and a list of items with item_id, item_name, ha_type and current value.',
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
        name        : 'set_light',
        description : 'Control a specific light or lamp. Identify the device by thing_id OR thing_name ' +
                      '(both available from get_all_states). thing_name supports partial, case-insensitive match. ' +
                      'If multiple devices match the name, all of them are controlled. ' +
                      'You can turn it on/off and/or set brightness/color_temp in one call.',
        inputSchema : {
            type       : 'object',
            properties : {
                thing_id   : { type: 'string',  description: 'Exact thing node ID (from get_all_states). Takes priority over thing_name.' },
                thing_name : { type: 'string',  description: 'Partial, case-insensitive name match (e.g. "kontor" matches "Kontor Spotlights").' },
                on         : { type: 'boolean', description: 'true = turn on, false = turn off' },
                brightness : { type: 'number',  description: 'Brightness 0–100 (percent)', minimum: 0, maximum: 100 },
                color_temp : { type: 'number',  description: 'Color temperature in Kelvin (e.g. 2700 = warm white, 4000 = neutral, 6500 = cool white)' }
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
            const listenerCount = this.listenerCount("command_" + id);
            console.log('[hal2EventHandler] publishCommand: thing=' + id + ', item=' + itemid + ', payload=' + JSON.stringify(payload) + ', listeners=' + listenerCount);
            this.emit("command_" + id, itemid, payload);
        };

        node.publishUpdate = function (thingtypeid, thingid, itemid, payload) {
            if (thingtypeid !== null) {
                node.debug("Update event: Thingtype " + thingtypeid + " Item " + itemid);
                this.emit("update_" + thingtypeid, thingtypeid, thingid, itemid, payload);
            }
            node.debug("Update event: Thing " + thingid + " Item " + itemid);
            this.emit("update_" + thingid, thingtypeid, thingid, itemid, payload);
        };

        node.publishLog = function (payload) {
            node.debug("Log event");
            this.emit("log_", payload);
        };

        // ── MCP ───────────────────────────────────────────────────────────────

        const mcpPrefix = (config.httpPathPrefix || '').replace(/\/$/, '');

        node.log('MCP enabled: ' + !!config.mcpEnabled + ', prefix: "' + mcpPrefix + '"');

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

            async function validateToken(token) {
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

            function getAllStates() {
                const devices = [];
                RED.nodes.eachNode(function (cfg) {
                    if (cfg.type !== 'hal2Thing') return;
                    const thing = RED.nodes.getNode(cfg.id);
                    if (!thing || !thing.eventHandler || thing.eventHandler.id !== node.id) return;
                    const tt = thing.thingType;
                    if (!tt || !tt.items) return;

                    const items = [];
                    for (const i in tt.items) {
                        const itm = tt.items[i];
                        if (itm.id === '1') continue; // skip heartbeat alive item
                        items.push({
                            item_id   : itm.id,
                            item_name : itm.name,
                            ha_type   : itm.haType || '',
                            value     : (thing.state[itm.id] !== undefined) ? thing.state[itm.id] : 'no value'
                        });
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
                const thing = RED.nodes.getNode(thingId);
                if (!thing || thing.type !== 'hal2Thing') {
                    return { error: 'Thing not found: ' + thingId };
                }
                if (!thing.eventHandler || thing.eventHandler.id !== node.id) {
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
                    return respond({
                        protocolVersion : '2024-11-05',
                        capabilities    : { tools: {} },
                        serverInfo      : { name: mcpServerName, version: '1.0.0' }
                    });
                }

                if (method === 'notifications/initialized') {
                    return res.status(204).send('');
                }

                // ── tools/list ────────────────────────────────────────────────
                if (method === 'tools/list') {
                    const tools = [...MCP_TOOLS];
                    if (adminEnabled) tools.push(...MCP_TOOLS_ADMIN);
                    return respond({ tools });
                }

                // ── tools/call ────────────────────────────────────────────────
                if (method === 'tools/call') {
                    const toolName = params.name;
                    const args     = params.arguments || {};

                    node.status({ fill: 'blue', shape: 'dot', text: toolName });

                    // get_all_states
                    if (toolName === 'get_all_states') {
                        const states = getAllStates();
                        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                        return toolOk(JSON.stringify(states, null, 2));
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

                    // set_light
                    if (toolName === 'set_light') {
                        console.log('[hal2EventHandler] set_light called, args=' + JSON.stringify(args));

                        // Use getAllStates() so search is consistent with what Claude sees
                        const allStates = getAllStates();
                        let matched = [];
                        if (args.thing_id) {
                            matched = allStates.filter(d => d.thing_id === args.thing_id);
                            console.log('[hal2EventHandler] set_light by id "' + args.thing_id + '": matched=' + matched.length);
                        } else if (args.thing_name) {
                            const needle = args.thing_name.toLowerCase();
                            matched = allStates.filter(d => d.thing_name && d.thing_name.toLowerCase().includes(needle));
                            console.log('[hal2EventHandler] set_light by name "' + args.thing_name + '": candidates=' + allStates.map(d => d.thing_name).join(', ') + ' → matched=' + matched.length);
                        }

                        if (matched.length === 0) {
                            node.status({ fill: 'red', shape: 'dot', text: 'error' });
                            return toolOk(JSON.stringify({ error: 'No matching thing found', thing_id: args.thing_id, thing_name: args.thing_name, available: allStates.map(d => ({ thing_id: d.thing_id, thing_name: d.thing_name })) }));
                        }

                        const results = [];
                        for (const device of matched) {
                            const sent = [];
                            for (const itm of device.items) {
                                const ht = (itm.ha_type || '').toLowerCase();
                                console.log('[hal2EventHandler] set_light item: "' + itm.item_name + '" ha_type="' + ht + '"');
                                if ((ht === 'light' || ht === 'switch') && args.on !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.on);
                                    sent.push({ item_id: itm.item_id, item_name: itm.item_name, value: args.on });
                                }
                                if (ht === 'dimmer' && args.brightness !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.brightness);
                                    sent.push({ item_id: itm.item_id, item_name: itm.item_name, value: args.brightness });
                                }
                                if (ht === 'color temperature' && args.color_temp !== undefined) {
                                    node.publishCommand(device.thing_id, itm.item_id, args.color_temp);
                                    sent.push({ item_id: itm.item_id, item_name: itm.item_name, value: args.color_temp });
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

                    return rpcErr(-32601, 'Unknown tool: ' + toolName);
                }

                return rpcErr(-32601, 'Unknown method: ' + (method || 'null'));
            });

            node.status({ fill: 'green', shape: 'dot', text: 'ready' });
        }

        // ── Close ─────────────────────────────────────────────────────────────

        node.on('close', function () {
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
            adminToken           : { type: 'password' }
        }
    });
};

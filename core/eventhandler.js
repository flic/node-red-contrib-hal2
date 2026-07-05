const http            = require('http');
const https           = require('https');
const crypto          = require('crypto');
const analyzePatterns = require('./analyzePatterns');
const common          = require('../lib/common');
const { createMcpAuth } = require('./mcp-auth');

console.log('[hal2EventHandler] module loaded, version check: ' + new Date().toISOString());

const {
    MCP_TOOLS, MCP_TOOLS_ADMIN, MCP_ADMIN_TOOL_NAMES,
    TOOL_HARDWARE_REQUIREMENTS, expandHaTypeFilter, deriveCategories
} = require('./mcp-tools');

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
        this.groups         = config.groups || [];
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
            // Keep refs so both timers can be cleared on close — otherwise every redeploy
            // leaks a live interval that keeps running against stale nodes.
            node.hbTimeout  = setTimeout(checkHeartbeat, 5000);
            node.hbInterval = setInterval(checkHeartbeat, this.heartbeat * 1000);
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

        // ── Group engine ────────────────────────────────────────────────────────
        // Groups are no longer separate nodes. Their identity (name, haType, notes,
        // ratelimit) lives here on the EventHandler; membership lives per item on each
        // hal2Thing (thing.groups = [{item, group}]). This engine resolves membership
        // and wires, per group: a command listener that broadcasts to members, and
        // update listeners that re-emit member changes under the group id (carrying the
        // real member thing/item so event nodes get member context).
        //
        // Back-compat: legacy hal2Group nodes are folded in automatically (in memory)
        // by reading their config — old flows keep working with no file changes and no
        // manual step. tools/migrate-groups.js makes this permanent (and removes the
        // dead nodes). The group's node id is reused as the group id throughout, so
        // Action/Event references keep pointing at the same id either way.

        node.groupWirings = [];

        function commandCapableItem(item) {
            const t = item && item.type;
            return (t === 'both' || t === 'command' || t === 'loopback_both' || t === 'loopback_command');
        }

        // groupId -> { ratelimit, legacy } merged from the registry and any legacy
        // hal2Group nodes belonging to this handler. The registry wins on collision
        // (i.e. once a group has been migrated, its hal2Group node is ignored).
        function buildGroupDefs() {
            const defs = new Map();
            for (const g of node.groups) {
                if (g && g.id) defs.set(g.id, { ratelimit: Number(g.ratelimit) || 0, legacy: false });
            }
            RED.nodes.eachNode(function (cfg) {
                if (cfg.type !== 'hal2Group' || cfg.eventHandler !== node.id) return;
                if (defs.has(cfg.id)) return;
                defs.set(cfg.id, { ratelimit: Number(cfg.ratelimit) || 0, legacy: true });
            });
            return defs;
        }

        function buildGroupMembers() {
            // groupId -> [{ thing, item }]
            const members = new Map();
            const add = function (groupId, thing, item) {
                if (!members.has(groupId)) members.set(groupId, []);
                members.get(groupId).push({ thing: thing, item: item });
            };
            // New model: membership declared per item on each thing.
            RED.nodes.eachNode(function (cfg) {
                if (cfg.type !== 'hal2Thing') return;
                const thing = RED.nodes.getNode(cfg.id);
                if (!thing || !thing.eventHandler || thing.eventHandler.id !== node.id) return;
                if (!Array.isArray(thing.groups)) return;
                for (const m of thing.groups) {
                    if (m && m.group) add(m.group, thing.id, m.item);
                }
            });
            // Legacy model: hal2Group nodes (folded in memory, unless already migrated).
            RED.nodes.eachNode(function (cfg) {
                if (cfg.type !== 'hal2Group' || cfg.eventHandler !== node.id) return;
                if (node.groups.some(g => g.id === cfg.id)) return;
                const list = Array.isArray(cfg.group) ? cfg.group : [];
                for (const m of list) {
                    if (m && m.thing) add(cfg.id, m.thing, m.item);
                }
            });
            return members;
        }

        function unwireGroups() {
            for (const w of node.groupWirings) {
                node.unsubscribe(w.event, w.id, w.listener);
            }
            node.groupWirings = [];
        }

        function wireGroups() {
            unwireGroups();   // idempotent — safe to re-run on every flows:started
            const members = buildGroupMembers();
            const defs    = buildGroupDefs();
            let legacyCount = 0;
            for (const [groupId, def] of defs) {
                const groupMembers = members.get(groupId) || [];
                const ratelimit    = def.ratelimit;
                if (def.legacy) legacyCount += 1;

                // Command: broadcast to all command-capable members, rate limited.
                // Reuses queueSend with a per-group context (it only reads
                // ratelimit / eventHandler / status), so each group keeps its own pace.
                const commandListener = function (itemid, payload) {
                    const queue = [];
                    for (const m of groupMembers) {
                        const thing = RED.nodes.getNode(m.thing);
                        if (!thing || !thing.thingType || !Array.isArray(thing.thingType.items)) continue;
                        const item = thing.thingType.items.find(it => it.id === m.item);
                        if (!item || !commandCapableItem(item)) continue;
                        queue.push({ thing: m.thing, item: m.item, payload: payload });
                    }
                    if (queue.length === 0) return;
                    common.queueSend({ ratelimit: ratelimit, eventHandler: node, status: function () {} }, queue);
                };
                node.subscribe('command', groupId, commandListener);
                node.groupWirings.push({ event: 'command', id: groupId, listener: commandListener });

                // Update: re-emit member changes under the group id, keeping the real
                // member thing/item so event nodes can show which member changed.
                const updateListener = function (thingtypeid, thingid, itemid, payload) {
                    const isMember = groupMembers.some(m => m.thing === thingid && m.item === itemid);
                    if (!isMember) return;
                    node.emit('update_' + groupId, thingtypeid, thingid, itemid, payload);
                };
                const uniqueThings = [...new Set(groupMembers.map(m => m.thing))];
                for (const t of uniqueThings) {
                    node.subscribe('update', t, updateListener);
                    node.groupWirings.push({ event: 'update', id: t, listener: updateListener });
                }
            }
            node.debug('Group engine wired ' + defs.size + ' group(s)');
            if (legacyCount > 0) {
                node.warn('Group engine: auto-handling ' + legacyCount + ' legacy hal2Group node(s) in memory. ' +
                    'Run tools/migrate-groups.js to make this permanent and remove the deprecated nodes.');
            }
        }

        // Wire after every (re)start, once all things have registered so membership
        // can be resolved. on() (not once) keeps groups correct across redeploys where
        // this config node instance survives but member things changed.
        RED.events.on('flows:started', wireGroups);

        node.on('close', function () {
            RED.events.removeListener('flows:started', wireGroups);
            unwireGroups();
        });

        // ── MCP ───────────────────────────────────────────────────────────────

        const mcpPrefix = (config.httpPathPrefix || '').replace(/\/$/, '');

        node.log('MCP enabled: ' + !!config.mcpEnabled + ', prefix: "' + mcpPrefix + '", location: "' + (config.locationName || '') + '"');

            const mcpServerUrl  = config.mcpServerUrl  || '';
            // Identity provider (OIDC issuer) base URL. Stored under the legacy key `pocketidUrl`
            // for backward compatibility, but it can point at any OIDC provider — its real
            // endpoints are auto-discovered (see getOidcConfig below).
            const issuerUrl     = (config.pocketidUrl || '').replace(/\/$/, '');
            const mcpServerName = config.mcpServerName || 'hal2-mcp';
            // Redirect URI(s) the DCR shim advertises (space/newline/comma-separated). These must
            // also be whitelisted on the IdP client. Defaults to the Claude.ai MCP callback.
            const redirectUris  = (config.mcpRedirectUris || 'https://claude.ai/api/mcp/auth_callback')
                                    .split(/[\s,]+/).map(s => s.trim()).filter(Boolean);

            node.log('MCP init: serverUrl=' + mcpServerUrl + ', issuer=' + issuerUrl);
            const tokenTTL      = Number(config.tokenCacheTTL || 300) * 1000;
            // Optional audience enforcement. When set, the token's `aud` must match. Left empty
            // by default so existing IdP setups that don't scope `aud` keep working — issuer is
            // always enforced regardless (see validateToken).
            const tokenAudience = (config.mcpAudience || '').trim();
            const adminEnabled  = config.adminToolsEnabled === true;
            const adminPort     = Number(config.adminPort || 1880);
            const mcpScopesStr  = (config.mcpScopes || 'openid profile email').trim();
            const mcpScopesArr  = mcpScopesStr.split(/\s+/).filter(Boolean);
            const adminClaim    = (config.adminRequiredClaim || 'groups').trim();
            // Default 'admin' only when never set (undefined). Empty string is respected
            // as "allow any authenticated user" per the UI help text.
            const adminValue    = (config.adminRequiredValue === undefined ? 'admin' : config.adminRequiredValue).trim();

            function isAdmin(claims) {
                if (!adminValue) return true;
                if (!claims) return false;
                const v = claims[adminClaim];
                if (Array.isArray(v)) return v.includes(adminValue);
                return v === adminValue;
            }

            // ── Admin API helper ───────────────────────────────────────────────

            function adminApi(method, path, body) {
                const token = (node.credentials && node.credentials.adminToken) || '';
                const hdrs  = token ? { 'Authorization': 'Bearer ' + token } : {};
                return httpRequest(method, 'localhost', adminPort, path, hdrs, body);
            }

            // ── MCP auth (OIDC discovery, JWKS, token validation, Bearer middleware) ──
            // See core/mcp-auth.js. External deps injected so the module stays testable.
            const auth = createMcpAuth({
                issuerUrl, tokenTTL, tokenAudience, mcpServerUrl,
                localDebugToken: (node.credentials && node.credentials.localDebugToken) || '',
                httpGet,
                log:  msg => node.log(msg),
                warn: msg => node.warn(msg)
            });
            const { requireBearer, getOidcConfig } = auth;
            if (issuerUrl) { getOidcConfig().catch(() => {}); }   // warm the cache (non-blocking)

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
                    // Always present (empty object when the device has no metadata) so consumers
                    // can rely on the key existing.
                    deviceEntry.metadata = (typeof thing.getMetadata === 'function') ? thing.getMetadata() : (thing.metadata || {});
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

            // Shared: compact item list for self-describing "available_items" in error responses,
            // so a failed thing/item lookup tells the caller what to pick (no full get_all_states dump).
            function thingItemsSummary(thing) {
                const items = (thing && thing.thingType && thing.thingType.items) || [];
                return items.map(it => {
                    const o = {
                        item_id  : it.id,
                        item_name: it.name,
                        ha_type  : it.haType || (it.id === '1' ? 'binary_sensor' : ''),
                        history  : !!it.history
                    };
                    if (it.type === 'status') o.read_only = true;
                    if (Array.isArray(it.tags) && it.tags.length) o.tags = it.tags;   // disambiguate same-ha_type items
                    return o;
                });
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
                const item = (thing.thingType.items || []).find(i => i.id === itemId);
                if (!item) {
                    return { error: 'No item with id "' + itemId + '" in thing "' + thing.name + '" — pick a controllable item from available_items (item is the control within the device, not the device name).',
                             thing_id: thingId, thing_name: thing.name, available_items: thingItemsSummary(thing) };
                }
                if (item.type === 'status') {
                    return { error: 'Item "' + item.name + '" is read-only (status) and cannot be controlled.',
                             thing_id: thingId, thing_name: thing.name, available_items: thingItemsSummary(thing) };
                }
                node.publishCommand(thingId, itemId, value);
                return { success: true, thing_name: thing.name, item_id: itemId, value };
            }

            // ── Auth middleware helper ─────────────────────────────────────────
            node.requireBearer = requireBearer;

        // ── Shared tool dispatcher (used by the /mcp route and the hal2Api node) ──
        // Returns a uniform shape: { ok:true, text } | { ok:true, content } | { ok:false, code, message }
        // Tool-result shims — pure, shared by every dispatcher below.
        const toolOk  = function (text)   { return { ok: true, text: text }; };
        const respond = function (result) { return { ok: true, content: result.content }; };
        const rpcErr  = function (code, message) { return { ok: false, code: code, message: message }; };

        // Built-in tool handlers, grouped by concern. Each returns a tool result when it handles
        // the named tool, or undefined to let the next dispatcher try. node.callTool (below) is a
        // thin coordinator over these.
        async function dispatchReadTools(toolName, args, claims, opts) {
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
                        } else if (fields === 'items') {
                            // Compact item index for cheap id lookup — no values, metadata, notes or tags.
                            paged = paged.map(d => ({
                                thing_id  : d.thing_id,
                                thing_name: d.thing_name,
                                type_name : d.type_name,
                                items     : (d.items || []).map(i => ({
                                    item_id  : i.item_id,
                                    item_name: i.item_name,
                                    ha_type  : i.ha_type,
                                    ...(i.history ? { history: true } : {})
                                }))
                            }));
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
                            if (!item) return toolOk(JSON.stringify({
                                error          : 'No item with id "' + args.item_id + '" in thing "' + device.thing_name + '" — pick from available_items (item is the measurement/control within the device, not the device name).',
                                thing_id       : device.thing_id,
                                thing_name     : device.thing_name,
                                available_items: device.items.map(i => ({
                                    item_id  : i.item_id,
                                    item_name: i.item_name,
                                    ha_type  : i.ha_type,
                                    ...(i.history ? { history: true } : {})
                                }))
                            }));
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
                    return undefined;
        }

        async function dispatchControlTools(toolName, args, claims, opts) {
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
                    return undefined;
        }

        async function dispatchAdminTools(toolName, args, claims, opts) {
                    // Admin tools — handled internally
                    if (MCP_ADMIN_TOOL_NAMES.has(toolName)) {
                        if (!opts.adminEnabled) return rpcErr(-32601, 'Unknown tool: ' + toolName);
                        // Admin tools require a verified admin claim. Callers with no claims at all
                        // (e.g. hal2Api invoked without msg.claims) are rejected — the adminEnabled
                        // flag alone must never be sufficient to reach get_flow/deploy_flow. To use
                        // admin tools via hal2Api, the flow must set an explicit admin claim on the
                        // message (e.g. msg.claims = { groups: ['admin'] }).
                        if (!claims || !isAdmin(claims)) {
                            node.status({ fill: 'red', shape: 'ring', text: 'forbidden' });
                            return rpcErr(-32000, 'Access denied: the "' + toolName + '" tool requires admin privileges, '
                                + 'which your token does not have. This is a permission restriction, not a tool error.');
                        }
                        // Flow IDs go straight into the admin HTTP path; constrain to the
                        // Node-RED id charset so a crafted id can't traverse or inject into it.
                        if (args.id !== undefined && !/^[A-Za-z0-9._-]+$/.test(String(args.id))) {
                            return rpcErr(-32602, 'Invalid flow id');
                        }
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
                                        lines.push('- **' + tab.label + '**' + (tab.disabled ? ' [disabled]' : ''));
                                        lines.push('  ID: `' + tab.id + '`  |  Nodes: ' + count);
                                    });
                                    node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                                    return toolOk(lines.join('\n'));
                                }
                                const r = await adminApi('GET', '/flow/' + args.id);
                                if (r.status === 404) {
                                    node.status({ fill: 'green', shape: 'dot', text: 'ready' });
                                    return toolOk('Flow \'' + args.id + '\' not found.');
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
                                    return toolOk('Flow \'' + args.label + '\' deployed. ID: ' + (r.body.id || tabId));
                                }
                                return toolOk('Deploy failed (' + r.status + '): ' + JSON.stringify(r.body));
                            }
                        } catch (e) {
                            node.status({ fill: 'red', shape: 'ring', text: 'admin error' });
                            return toolOk('Admin call error: ' + e.message);
                        }
                    }
                    return undefined;
        }

        async function dispatchHistoryTools(toolName, args, claims, opts) {
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

                        // itemFail returns the thing's items (shared thingItemsSummary helper), so a
                        // failed item lookup is self-describing — no full get_all_states dump needed.
                        const itemFail = (msg) => toolOk(JSON.stringify({
                            error          : msg,
                            thing_id       : targetThing.id,
                            thing_name     : targetThing.name,
                            available_items: thingItemsSummary(targetThing)
                        }));

                        const ttItems = targetThing.thingType.items || [];
                        let itemId = args.item_id;

                        // Resolve by ha_type and/or tag when the device is known but the exact item
                        // isn't (e.g. thing_name="Sjövatten" + ha_type="temperature", or a sauna
                        // sensor with two temperatures → ha_type="temperature" + tag="ute").
                        if (!itemId && !args.item_name && (args.ha_type || args.tag)) {
                            let matches = ttItems;
                            if (args.ha_type) {
                                const wanted = expandHaTypeFilter(args.ha_type);
                                matches = matches.filter(it => it.haType && wanted.has(it.haType.toLowerCase()));
                            }
                            if (args.tag) {
                                const t = String(args.tag).toLowerCase();
                                matches = matches.filter(it => Array.isArray(it.tags) && it.tags.some(x => String(x).toLowerCase() === t));
                            }
                            const crit = [
                                args.ha_type ? ('ha_type "' + args.ha_type + '"') : null,
                                args.tag     ? ('tag "' + args.tag + '"')         : null
                            ].filter(Boolean).join(' + ');
                            if (matches.length === 0) {
                                return itemFail('No item matching ' + crit + ' in thing "' + targetThing.name + '".');
                            }
                            const histMatches = matches.filter(it => it.history);
                            const pick = histMatches.length ? histMatches : matches;
                            if (pick.length > 1) {
                                return itemFail('Multiple items match ' + crit + ' — narrow it with a tag, or specify item_id from available_items.');
                            }
                            itemId = pick[0].id;
                        }

                        if (!itemId && args.item_name) {
                            const needle = args.item_name.toLowerCase();
                            const found  = ttItems.find(i => i.name.toLowerCase().includes(needle));
                            if (!found) {
                                return itemFail('No item matching "' + args.item_name + '" in thing "' + targetThing.name + '". Note: thing and item are separate namespaces — the device is "' + targetThing.name + '"; pick an item from available_items (or pass ha_type).');
                            }
                            if (!found.history) return itemFail('History not enabled for item "' + found.name + '".');
                            itemId = found.id;
                        }

                        if (itemId) {
                            const found = ttItems.find(i => i.id === itemId);
                            if (!found)         return itemFail('No item with id "' + itemId + '" in thing "' + targetThing.name + '".');
                            if (!found.history) return itemFail('History not enabled for item "' + found.name + '".');
                        } else {
                            return itemFail('Provide item_id, item_name, or ha_type. See available_items for this thing.');
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

                        // Optional server-side downsampling: aggregate numeric values into time buckets.
                        const numericPrecision = Math.max(0, Math.min(6, Number(args.numeric_precision) || 2));
                        const bucketSeconds = (Number(args.bucket_seconds) > 0) ? Math.floor(Number(args.bucket_seconds)) : null;
                        const bucketMode = bucketSeconds ? 'seconds' : String(args.bucket || 'raw').toLowerCase();
                        if (['raw', 'minute', 'hour', 'day', 'seconds'].indexOf(bucketMode) === -1) {
                            return toolOk(JSON.stringify({ error: 'Invalid bucket. Use "raw", "minute", "hour", "day", or bucket_seconds.' }));
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

                            // Bucketed aggregation (numeric items) — done server-side so the caller
                            // gets compact per-interval stats instead of all raw samples.
                            if (bucketMode !== 'raw') {
                                // Bucket start, aligned to local time (TZ-aware via Date) for minute/hour/day;
                                // epoch-aligned for an explicit bucket_seconds.
                                const bucketStartMs = (ts) => {
                                    if (bucketSeconds) { const w = bucketSeconds * 1000; return Math.floor(ts / w) * w; }
                                    const d = new Date(ts);
                                    if (bucketMode === 'minute')      d.setSeconds(0, 0);
                                    else if (bucketMode === 'hour')   d.setMinutes(0, 0, 0);
                                    else if (bucketMode === 'day')     d.setHours(0, 0, 0, 0);
                                    return d.getTime();
                                };
                                // Local ISO with offset, so a "day" bucket reads as local midnight (e.g. ...T00:00:00+02:00).
                                const localIso = (ms) => {
                                    const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
                                    const off = -d.getTimezoneOffset(), sg = off >= 0 ? '+' : '-', a = Math.abs(off);
                                    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' +
                                           p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
                                           sg + p(Math.floor(a / 60)) + ':' + p(a % 60);
                                };

                                const buckets = new Map();
                                let numericTotal = 0;
                                for (const d of docs) {
                                    if (typeof d.state !== 'number' || !isFinite(d.state)) continue;
                                    numericTotal++;
                                    const key = bucketStartMs(d.ts);
                                    let b = buckets.get(key);
                                    if (!b) { b = { count: 0, sum: 0, min: Infinity, max: -Infinity }; buckets.set(key, b); }
                                    b.count++; b.sum += d.state;
                                    if (d.state < b.min) b.min = d.state;
                                    if (d.state > b.max) b.max = d.state;
                                }

                                if (numericTotal === 0) {
                                    return toolOk(JSON.stringify({ error: 'Aggregation supports numeric items only — use bucket="raw" for non-numeric items.' }));
                                }
                                if (buckets.size > 5000) {
                                    return toolOk(JSON.stringify({ error: 'Too many buckets (' + buckets.size + '). Use a coarser bucket (hour/day) or a shorter range.' }));
                                }

                                const f = Math.pow(10, numericPrecision);
                                const round = (v) => Math.round(v * f) / f;
                                const out = [...buckets.entries()].sort((x, y) => x[0] - y[0]).map(([startMs, b]) => ({
                                    start: localIso(startMs),
                                    count: b.count,
                                    avg  : round(b.sum / b.count),
                                    min  : round(b.min),
                                    max  : round(b.max)
                                }));
                                return toolOk(JSON.stringify({
                                    thing_id     : targetThing.id,
                                    thing_name   : targetThing.name,
                                    item_id      : itemId,
                                    from         : new Date(fromMs).toISOString(),
                                    to           : new Date(toMs).toISOString(),
                                    bucket       : bucketSeconds ? (bucketSeconds + 's') : bucketMode,
                                    numeric      : true,
                                    total_buckets: out.length,
                                    buckets      : out
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
                    return undefined;
        }

        node.callTool = async function (toolName, args, claims, opts) {
            args = args || {};
            opts = opts || {};

            const notConfigured = getNotConfiguredError(toolName);
            if (notConfigured) {
                console.log('[hal2EventHandler] tools/call: ' + toolName + ' not_configured at ' + (config.locationName || ''));
                return toolOk(JSON.stringify(notConfigured));
            }

            let r;
            r = await dispatchReadTools(toolName, args, claims, opts);    if (r !== undefined) return r;
            r = await dispatchControlTools(toolName, args, claims, opts); if (r !== undefined) return r;
            r = await dispatchAdminTools(toolName, args, claims, opts);   if (r !== undefined) return r;
            r = await dispatchHistoryTools(toolName, args, claims, opts); if (r !== undefined) return r;

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
                        node.emit('mcp_tool_' + toolName, { args, _mcpCallId: callId, _mcpClaims: claims });
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
        };

            if (config.mcpEnabled) {

            // ── HTTP hardening middleware ──────────────────────────────────────
            // The MCP routes live on RED.httpNode, exposed to the internet behind a proxy.
            // Per-IP rate limiting (sliding 60s window) and a Content-Length cap blunt
            // brute-force, DCR spam and oversized-payload (deploy_flow) abuse. Node-RED's own
            // body parser also applies; this is a cheap early guard.
            const rlStore = {};
            function rateLimit(bucket, perMinute) {
                return (req, res, next) => {
                    const ip  = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
                    const key = bucket + '|' + ip;
                    const now = Date.now();
                    const win = now - 60000;
                    const hits = (rlStore[key] || []).filter(t => t > win);
                    if (hits.length >= perMinute) {
                        res.set('Retry-After', '60');
                        return res.status(429).json({ error: 'rate_limited' });
                    }
                    hits.push(now);
                    rlStore[key] = hits;
                    if (Object.keys(rlStore).length > 5000) {          // bound memory
                        for (const k of Object.keys(rlStore)) {
                            if (!rlStore[k].some(t => t > win)) delete rlStore[k];
                        }
                    }
                    next();
                };
            }
            function maxBody(bytes) {
                return (req, res, next) => {
                    if (Number(req.headers['content-length'] || 0) > bytes) {
                        return res.status(413).json({ error: 'payload_too_large' });
                    }
                    next();
                };
            }

            // ── OAuth: /.well-known/oauth-protected-resource ───────────────────

            node.log('MCP registering route: GET ' + mcpPrefix + '/.well-known/oauth-protected-resource');
            RED.httpNode.get(mcpPrefix + '/.well-known/oauth-protected-resource', rateLimit('wk', 120), (_req, res) => {
                res.status(200).json({
                    resource                 : mcpServerUrl,
                    authorization_servers    : [mcpServerUrl],
                    bearer_methods_supported : ['header'],
                    scopes_supported         : mcpScopesArr
                });
            });

            // ── OAuth: /.well-known/oauth-authorization-server ────────────────

            node.log('MCP registering route: GET ' + mcpPrefix + '/.well-known/oauth-authorization-server');
            RED.httpNode.get(mcpPrefix + '/.well-known/oauth-authorization-server', rateLimit('wk', 120), async (_req, res) => {
                const oidc = await getOidcConfig();
                res.status(200).json({
                    issuer                                : mcpServerUrl,
                    authorization_endpoint                : oidc.authorization_endpoint,
                    token_endpoint                        : oidc.token_endpoint,
                    userinfo_endpoint                     : oidc.userinfo_endpoint,
                    registration_endpoint                 : mcpServerUrl + mcpPrefix + '/oauth/register',
                    jwks_uri                              : oidc.jwks_uri,
                    scopes_supported                      : mcpScopesArr,
                    response_types_supported              : ['code'],
                    grant_types_supported                 : ['authorization_code', 'refresh_token'],
                    code_challenge_methods_supported      : ['S256'],
                    token_endpoint_auth_methods_supported : ['client_secret_post', 'none']
                });
            });

            // ── DCR: /oauth/register ──────────────────────────────────────────

            node.log('MCP registering route: POST ' + mcpPrefix + '/oauth/register');
            RED.httpNode.post(mcpPrefix + '/oauth/register', rateLimit('register', 20), (req, res) => {
                const clientId     = (node.credentials && node.credentials.pocketidClientId)     || '';
                const clientSecret = (node.credentials && node.credentials.pocketidClientSecret) || '';
                const requested       = req.body || {};
                // Never echo attacker-controlled redirect_uris. Constrain any requested URIs to the
                // configured allowlist so this endpoint can't be used to poison the OAuth callback;
                // fall back to the full configured set when none (valid) were requested.
                const requestedUris = Array.isArray(requested.redirect_uris) ? requested.redirect_uris : [];
                const allowed = requestedUris.filter(u => redirectUris.includes(u));
                if (requestedUris.length && !allowed.length) {
                    return res.status(400).json({
                        error: 'invalid_redirect_uri',
                        error_description: 'requested redirect_uris are not allowed'
                    });
                }
                const clientRedirects = allowed.length ? allowed : redirectUris;
                res.status(201).json({
                    client_id                  : clientId,
                    client_secret              : clientSecret,
                    client_id_issued_at        : Math.floor(Date.now() / 1000),
                    redirect_uris              : clientRedirects,
                    grant_types                : ['authorization_code', 'refresh_token'],
                    response_types             : ['code'],
                    token_endpoint_auth_method : 'client_secret_post',
                    scope                      : mcpScopesStr
                });
            });

            // ── MCP: /mcp ─────────────────────────────────────────────────────

            node.log('MCP registering route: POST ' + mcpPrefix + '/mcp');
            RED.httpNode.post(mcpPrefix + '/mcp', rateLimit('mcp', 300), maxBody(1024 * 1024), async (req, res) => {
                // Bearer token validation
                const claims = await requireBearer(req, res);
                if (!claims) return;

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
                                              ...(adminEnabled && isAdmin(claims) ? MCP_TOOLS_ADMIN : [])
                                          ].map(t => t.name).join(', ') + '.'
                    });
                }

                if (method === 'notifications/initialized') {
                    return res.status(204).send('');
                }

                // ── tools/list ────────────────────────────────────────────────
                if (method === 'tools/list') {
                    const tools = MCP_TOOLS.filter(t => !getNotConfiguredError(t.name));
                    if (adminEnabled && isAdmin(claims)) tools.push(...MCP_TOOLS_ADMIN);
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
                    node.status({ fill: 'blue', shape: 'dot', text: params.name });
                    const out = await node.callTool(params.name, params.arguments || {}, claims, { adminEnabled: adminEnabled });
                    node.status({ fill: out.ok ? 'green' : 'red', shape: 'dot', text: out.ok ? 'ready' : 'error' });
                    if (out.ok && out.content) return respond({ content: out.content });
                    if (out.ok)                return toolOk(out.text);
                    // Tool-level failures (permission denied, bad args, unknown tool) are surfaced as
                    // an isError tool result so the message reaches the model. A JSON-RPC error here
                    // gets swallowed by MCP clients into a generic "tool execution failed".
                    return respond({ content: [{ type: 'text', text: out.message || 'Tool call failed' }], isError: true });
                }

                return rpcErr(-32601, 'Unknown method: ' + (method || 'null'));
            });

            node.status({ fill: 'green', shape: 'dot', text: 'ready' });
        }

        // ── Close ─────────────────────────────────────────────────────────────

        node.on('close', function () {
            // Stop the heartbeat timers so a redeploy doesn't leave them running.
            if (node.hbTimeout)  { clearTimeout(node.hbTimeout);   node.hbTimeout  = null; }
            if (node.hbInterval) { clearInterval(node.hbInterval); node.hbInterval = null; }

            // Reject any pending dynamic tool calls
            for (const [, pending] of Object.entries(node.mcpPendingCalls)) {
                clearTimeout(pending.timer);
                pending.reject(new Error('Event handler closing'));
            }
            node.mcpPendingCalls = {};

            node.log('MCP close: mcpEnabled=' + !!config.mcpEnabled);
            if (config.mcpEnabled) {
                auth.clearCache();
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

// The 3.x → 4.0 conversion of hal2's removed nodes, hal2MCPServer and hal2Group, as pure functions. Loaded both by the editor
// plugin (plugins/convert.html, as a <script> from this module's resources) and by the tests, so
// it is written to run unchanged in a browser and under Node.
//
// 4.0.0 removed hal2MCPServer. An embedded one only routed tools to its event handler, so its
// tool call/result nodes now point at that event handler directly. A standalone one was a server
// of its own, which is what node-red-contrib-mcp-server's MCP Server is: with that package
// installed, the server and its nodes become that package's, keeping their ids — so wires, the
// references between them and stored credentials all carry over. Without it, standalone servers
// are left as they are and the notes say what is missing.
//
// hal2Group was deprecated in 3.x, when a group's identity moved to the event handler and its
// membership to each Thing's items; the event handler folded the nodes in at runtime. 4.0.0
// removed both the node and the folding, so convertGroups does what tools/migrate-groups.js did:
// the group's node id becomes the registry id, so Action/Event references keep resolving.
(function (root) {
    'use strict';

    var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
    var copy = function (n) { var c = {}; for (var k in n) { if (own(n, k)) { c[k] = n[k]; } } return c; };
    var pick = function (n, keys) { var c = {}; keys.forEach(function (k) { if (own(n, k)) { c[k] = n[k]; } }); return c; };

    // Fields an MCP node carries over unchanged. z, x, y, g, wires and name are layout and
    // identity; the rest is what the tool is.
    var PLACE = ['id', 'z', 'x', 'y', 'g', 'name', 'wires', 'd'];
    var IN_FIELDS  = PLACE.concat(['toolName', 'description', 'inputSchema', 'topic', 'timeout', 'requiredValue', 'exposeClaims']);
    var OUT_FIELDS = PLACE.concat(['emptyMessage']);
    var CALL_FIELDS = PLACE.concat(['field', 'fieldType']);

    // ── hal2Group → the event handler's registry ──────────────────────────────────────────────

    // A group's HAType from its members' items: one shared type, or a shared On/Off family
    // (switch ≡ light); anything mixed or unknown is 'other', the mode that accepts any item.
    function deriveHaType(members, byId) {
        var types = {}, count = 0;
        members.forEach(function (m) {
            var thing = byId[m.thing];
            var tt = thing && thing.type === 'hal2Thing' ? byId[thing.thingType] : null;
            var item = tt && Array.isArray(tt.items) ? tt.items.filter(function (it) { return it.id === m.item; })[0] : null;
            var ht = (item && item.haType) || '';
            if (!own(types, ht)) { types[ht] = true; count += 1; }
        });
        var known = Object.keys(types).filter(Boolean);
        if (count === 1 && known.length === 1) { return known[0]; }
        var family = function (ht) { return (ht === 'switch' || ht === 'light') ? 'onoff' : ht; };
        if (known.length && known.length === count
            && known.every(function (ht) { return family(ht) === family(known[0]); })) { return known[0]; }
        return 'other';
    }

    var newId = function () {
        var id = '';
        while (id.length < 16) { id += Math.floor(Math.random() * 16).toString(16); }
        return id;
    };

    // A wired group node becomes what its wires meant: an Action broadcasting to the group (its
    // input), an Event on any member change (its output), or both — the Action keeps the id, so
    // wires into it still land, and a new Event carries the output wires.
    function groupAction(g) {
        return { id: g.id, type: 'hal2Action', z: g.z, x: g.x, y: g.y, name: g.name, eventHandler: g.eventHandler,
            commandset: [{ category: 'hal2Group', thing: g.id, item: g.id, value: 'payload', type: 'msg', onchange: false }],
            ratelimit: 0, passthru: false, outputs: 0, wires: [] };
    }
    function groupEvent(id, g, y, name, wires) {
        return { id: id, type: 'hal2Event', z: g.z, x: g.x, y: y, name: name, eventHandler: g.eventHandler, topic: '',
            thing: g.id, typeSel: 'hal2Group', item: g.id,
            operator: 'always', change: '0', compareValue: '', compareType: 'num',
            outputValue: 'payload', outputType: 'state',
            ratelimit: false, ratetype: 'all', rate: '1', rateUnits: 'hour',
            delay: false, delayExtend: false, delayReset: false, delayValue: 5,
            wires: (wires && wires.length) ? wires : [[]] };
    }

    // → { flows, changed: [ids], notes: [text] }. Never mutates its input.
    function convertGroups(flows) {
        flows = flows || [];
        var byId = {};
        flows.forEach(function (n) { if (n && n.id) { byId[n.id] = n; } });
        var out = {}, changed = [], notes = [], extra = [], drop = {}, skipped = [];
        // Copy-on-write: a node is copied the first time the conversion changes it.
        var edit = function (n) {
            if (!out[n.id]) { out[n.id] = copy(n); changed.push(n.id); }
            return out[n.id];
        };

        flows.forEach(function (g) {
            if (!g || g.type !== 'hal2Group') { return; }
            var eh = byId[g.eventHandler];
            if (!eh || eh.type !== 'hal2EventHandler') { skipped.push(g.name || g.id); return; }
            var members = Array.isArray(g.group) ? g.group : [];

            var e = edit(eh);
            e.groups = Array.isArray(e.groups) ? e.groups.slice() : [];
            if (!e.groups.some(function (x) { return x && x.id === g.id; })) {
                e.groups.push({ id: g.id, name: g.name || g.id, haType: deriveHaType(members, byId),
                    ratelimit: Number(g.ratelimit) || 0, notes: g.notes || '' });
            }
            members.forEach(function (m) {
                var thing = byId[m.thing];
                if (!thing || thing.type !== 'hal2Thing') { return; }
                var t = edit(thing);
                t.groups = Array.isArray(t.groups) ? t.groups.slice() : [];
                if (!t.groups.some(function (x) { return x.item === m.item && x.group === g.id; })) {
                    t.groups.push({ item: m.item, group: g.id });
                }
            });

            var input  = g.input  === true || Number(g.inputs)  > 0;
            var output = g.output === true || Number(g.outputs) > 0;
            var wires  = Array.isArray(g.wires) ? g.wires : [];
            changed.push(g.id);
            if (!input && !output) { drop[g.id] = true; }
            else if (input && !output) { out[g.id] = groupAction(g); }
            else if (output && !input) { out[g.id] = groupEvent(g.id, g, g.y, g.name, wires); }
            else {
                out[g.id] = groupAction(g);
                var ev = groupEvent(newId(), g, (g.y || 0) + 40, (g.name || 'Group') + ' (event)', wires);
                extra.push(ev); changed.push(ev.id);
            }
        });

        var converted = changed.filter(function (id) { return byId[id] && byId[id].type === 'hal2Group'; }).length;
        if (converted) {
            notes.push('Group nodes moved to the event handler\'s Groups tab, and membership to each Thing\'s items: '
                + converted + ' group(s). A wired group became an Action and/or an Event node.');
        }
        if (skipped.length) {
            notes.push('Not converted, because no event handler is set on them: ' + skipped.join(', ')
                + '. Set one, then convert again.');
        }
        var result = flows.filter(function (n) { return !(n && drop[n.id]); })
            .map(function (n) { return (n && out[n.id]) || n; }).concat(extra);
        return { flows: result, changed: changed, notes: notes };
    }

    // flows: the whole configuration (GET /flows). opts.mcpServerInstalled: whether
    // @frtnbach/node-red-contrib-mcp-server ≥ 3 is installed (its ftb-mcp-server type registered).
    // → { flows, changed: [ids], notes: [text], pending: [names of standalone servers left as they are] }
    function convertFlows(flows, opts) {
        opts = opts || {};
        var grouped = convertGroups(flows);
        flows = grouped.flows;
        var byId = {};
        (flows || []).forEach(function (n) { if (n && n.id) { byId[n.id] = n; } });

        var servers = {}, notes = grouped.notes.slice(), pending = [], changed = grouped.changed.slice();
        (flows || []).forEach(function (n) {
            if (n && n.type === 'hal2MCPServer') { servers[n.id] = n; }
        });
        var serverName = function (s) { return s.name || ('/mcp/' + (s.path || 'server')); };

        // What each 3.x server becomes. Standalone ones only when mcp-server is there to take them.
        var plan = {};
        Object.keys(servers).forEach(function (id) {
            var s = servers[id];
            if (s.mode === 'embedded') { plan[id] = 'embedded'; }
            else if (opts.mcpServerInstalled) { plan[id] = 'standalone'; }
            else { pending.push(serverName(s)); }
        });

        var out = [];
        (flows || []).forEach(function (n) {
            if (!n || typeof n !== 'object') { out.push(n); return; }
            var target = n.mcpServer && plan[n.mcpServer];
            var s = n.mcpServer && servers[n.mcpServer];

            if (n.type === 'hal2MCPServer') {
                if (plan[n.id] === 'embedded') { changed.push(n.id); return; }    // nothing left to do
                if (plan[n.id] === 'standalone') {
                    var e = byId[n.eventHandler] || {};
                    var conv = pick(n, PLACE.concat(['instructions']));
                    conv.type = 'ftb-mcp-server';
                    delete conv.wires;
                    conv.path = n.path || '';
                    conv.serverUrl = e.mcpServerUrl || '';
                    conv.filterHost = e.mcpFilterHost === true;
                    conv.issuerUrl = e.pocketidUrl || '';
                    conv.audience = e.mcpAudience || '';
                    conv.extraScopes = e.mcpExtraScopes || '';
                    conv.tokenCacheTTL = e.tokenCacheTTL || 300;
                    // The claim only mattered with a value list; without one, the new default.
                    conv.requiredClaim = n.requiredValue ? (n.requiredClaim || 'groups') : 'sub';
                    conv.requiredValue = n.requiredValue || '';
                    conv.requiredScope = n.requiredScope || '';
                    conv.serverName = '';
                    conv.localDebugGroups = '';
                    out.push(conv); changed.push(n.id); return;
                }
                out.push(n); return;
            }

            if ((n.type === 'hal2MCPIn' || n.type === 'hal2MCPOut') && target === 'embedded') {
                var c = copy(n);
                c.eventHandler = s.eventHandler;
                delete c.mcpServer;
                out.push(c); changed.push(n.id); return;
            }
            if (n.type === 'hal2MCPIn' && target === 'standalone') {
                var i = pick(n, IN_FIELDS);
                i.type = 'ftb-mcp-in'; i.mcpServer = n.mcpServer; i.validateArgs = true;
                out.push(i); changed.push(n.id); return;
            }
            if (n.type === 'hal2MCPOut' && target === 'standalone') {
                var o = pick(n, OUT_FIELDS);
                o.type = 'ftb-mcp-out'; o.mcpServer = n.mcpServer;
                out.push(o); changed.push(n.id); return;
            }
            if (n.type === 'hal2Api' && n.mcpServer) {
                if (target === 'embedded') {
                    var a = copy(n); delete a.mcpServer; delete a.allowAdminTools;
                    out.push(a); changed.push(n.id); return;
                }
                if (target === 'standalone') {
                    var call = pick(n, CALL_FIELDS);
                    call.type = 'ftb-mcp-call'; call.mcpServer = n.mcpServer;
                    out.push(call); changed.push(n.id); return;
                }
            }
            out.push(n);
        });

        // What the user has to know, beyond what was converted.
        var standalone = Object.keys(plan).filter(function (id) { return plan[id] === 'standalone'; });
        if (standalone.length) {
            notes.push('Standalone servers become MCP Servers of @frtnbach/node-red-contrib-mcp-server: '
                + standalone.map(function (id) { return serverName(servers[id]); }).join(', ') + '. '
                + 'Each is now a resource of its own at <Server URL>/mcp/<path>: the reverse proxy must pass '
                + '/mcp/<path> and /.well-known/oauth-protected-resource/mcp/<path>, the identity provider needs that '
                + 'resource, and clients connected to them must sign in again. Arguments are now checked against '
                + 'each tool\'s schema; switch Validate off on a tool whose schema does not describe what it takes.');
        }
        if (pending.length) {
            notes.push('Not converted, because @frtnbach/node-red-contrib-mcp-server 3 or later is not installed: '
                + pending.join(', ') + '. Install it, then convert again.');
        }
        var admin = (flows || []).filter(function (n) { return n && n.type === 'hal2EventHandler' && n.adminToolsEnabled === true; });
        if (admin.length) {
            notes.push('Admin tools (get_flow, deploy_flow) are gone from ' + admin.map(function (n) { return n.locationName || n.name || n.id; }).join(', ')
                + '. Administer Node-RED with the MCP Admin node of @frtnbach/node-red-contrib-mcp-server.');
        }
        return { flows: out, changed: changed, notes: notes, pending: pending };
    }

    // Whether anything in these flows still needs the conversion.
    function needsConversion(flows) {
        return (flows || []).some(function (n) {
            return n && (n.type === 'hal2MCPServer' || n.type === 'hal2Group'
                || ((n.type === 'hal2MCPIn' || n.type === 'hal2MCPOut') && n.mcpServer && !n.eventHandler)
                || (n.type === 'hal2Api' && n.mcpServer));
        });
    }

    var api = { convertFlows: convertFlows, convertGroups: convertGroups, needsConversion: needsConversion };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
    else { root.hal2Convert4 = api; }
})(typeof window !== 'undefined' ? window : this);

'use strict';

const assert = require('node:assert');
const { convertFlows, needsConversion } = require('../resources/convert');

// A location like docker01: an event handler, one standalone server with a tool and a hal2Api,
// one embedded server with a tool, and a node that has nothing to do with MCP.
function fixture() {
    return [
        { id: 'tab', type: 'tab', label: 'MCP' },
        { id: 'eh', type: 'hal2EventHandler', locationName: 'Hemma', mcpServerUrl: 'https://mcp.example.com',
          mcpFilterHost: true, pocketidUrl: 'https://id.example.com', mcpAudience: 'https://mcp.example.com/mcp',
          mcpExtraScopes: 'mcp:read', tokenCacheTTL: 120 },
        { id: 'sa', type: 'hal2MCPServer', name: 'media', mode: 'standalone', eventHandler: 'eh', path: 'media',
          requiredScope: 'media', instructions: 'Media tools.' },
        { id: 'em', type: 'hal2MCPServer', mode: 'embedded', eventHandler: 'eh' },
        { id: 'i1', type: 'hal2MCPIn', z: 'tab', x: 10, y: 20, mcpServer: 'sa', toolName: 'seerr_search',
          description: 'd', inputSchema: '{}', timeout: 30, requiredValue: '', exposeClaims: false, wires: [['o1']] },
        { id: 'o1', type: 'hal2MCPOut', z: 'tab', mcpServer: 'sa', emptyMessage: 'none', wires: [] },
        { id: 'c1', type: 'hal2Api', z: 'tab', mcpServer: 'sa', allowAdminTools: false, field: 'payload', fieldType: 'msg', wires: [['f1']] },
        { id: 'i2', type: 'hal2MCPIn', z: 'tab', mcpServer: 'em', toolName: 'fw', wires: [['o2']] },
        { id: 'o2', type: 'hal2MCPOut', z: 'tab', mcpServer: 'em', wires: [] },
        { id: 'c2', type: 'hal2Api', z: 'tab', mcpServer: 'em', allowAdminTools: true, wires: [[]] },
        { id: 'f1', type: 'function', z: 'tab', wires: [[]] }
    ];
}
const byId = flows => Object.fromEntries(flows.map(n => [n.id, n]));

describe('resources/convert', function () {
    it('turns a standalone server and its nodes into mcp-server\'s, keeping ids and wires', function () {
        const { flows, changed } = convertFlows(fixture(), { mcpServerInstalled: true });
        const n = byId(flows);
        assert.deepStrictEqual(n.sa, {
            id: 'sa', name: 'media', instructions: 'Media tools.', type: 'ftb-mcp-server', path: 'media',
            serverUrl: 'https://mcp.example.com', filterHost: true, issuerUrl: 'https://id.example.com',
            audience: 'https://mcp.example.com/mcp', extraScopes: 'mcp:read', tokenCacheTTL: 120,
            requiredClaim: 'sub', requiredValue: '', requiredScope: 'media', serverName: '', localDebugGroups: ''
        });
        assert.strictEqual(n.i1.type, 'ftb-mcp-in');
        assert.strictEqual(n.i1.mcpServer, 'sa');
        assert.strictEqual(n.i1.validateArgs, true);
        assert.deepStrictEqual([n.i1.x, n.i1.y, n.i1.wires], [10, 20, [['o1']]]);
        assert.deepStrictEqual([n.o1.type, n.o1.emptyMessage], ['ftb-mcp-out', 'none']);
        assert.deepStrictEqual([n.c1.type, n.c1.field, n.c1.wires], ['ftb-mcp-call', 'payload', [['f1']]]);
        assert.ok(!('allowAdminTools' in n.c1));
        for (const id of ['sa', 'i1', 'o1', 'c1']) { assert.ok(changed.includes(id), id); }
    });

    it('keeps the claim a server matched on only when it had a value list', function () {
        const flows = fixture();
        byId(flows).sa.requiredValue = 'family';
        byId(flows).sa.requiredClaim = 'groups';
        const sa = byId(convertFlows(flows, { mcpServerInstalled: true }).flows).sa;
        assert.deepStrictEqual([sa.requiredClaim, sa.requiredValue], ['groups', 'family']);
    });

    it('points embedded tools at the event handler and removes the server', function () {
        const { flows } = convertFlows(fixture(), { mcpServerInstalled: true });
        const n = byId(flows);
        assert.ok(!n.em, 'the embedded server is gone');
        for (const id of ['i2', 'o2']) {
            assert.strictEqual(n[id].type, id === 'i2' ? 'hal2MCPIn' : 'hal2MCPOut');
            assert.strictEqual(n[id].eventHandler, 'eh');
            assert.ok(!('mcpServer' in n[id]));
        }
        assert.strictEqual(n.c2.type, 'hal2Api');
        assert.ok(!('mcpServer' in n.c2) && !('allowAdminTools' in n.c2));
    });

    it('without mcp-server converts embedded only, and says what is left', function () {
        const { flows, notes, pending } = convertFlows(fixture(), { mcpServerInstalled: false });
        const n = byId(flows);
        assert.strictEqual(n.sa.type, 'hal2MCPServer');
        assert.strictEqual(n.i1.type, 'hal2MCPIn');
        assert.strictEqual(n.i2.eventHandler, 'eh');
        assert.deepStrictEqual(pending, ['media']);
        assert.ok(notes.some(t => t.includes('not installed') && t.includes('media')));
        assert.ok(needsConversion(flows));
    });

    it('tells about the new resource, and about admin tools that are gone', function () {
        const flows = fixture();
        byId(flows).eh.adminToolsEnabled = true;
        const { notes } = convertFlows(flows, { mcpServerInstalled: true });
        assert.ok(notes.some(t => t.includes('/.well-known/oauth-protected-resource/mcp/<path>') && t.includes('media')));
        assert.ok(notes.some(t => t.includes('Admin tools') && t.includes('Hemma') && t.includes('MCP Admin')));
    });

    it('keeps a 3.x server without a path on /mcp/server, off hal2\'s own /mcp', function () {
        const flows = fixture();
        delete byId(flows).sa.path;
        assert.strictEqual(byId(convertFlows(flows, { mcpServerInstalled: true }).flows).sa.path, 'server');
    });

    it('renames the 3.x access claim, so an event handler gating on groups keeps doing so', function () {
        const flows = fixture();
        byId(flows).eh.adminRequiredClaim = 'groups';
        assert.ok(needsConversion([byId(flows).eh]));
        const { flows: out, changed } = convertFlows(flows, { mcpServerInstalled: true });
        const eh = byId(out).eh;
        assert.deepStrictEqual([eh.accessClaim, 'adminRequiredClaim' in eh], ['groups', false]);
        assert.strictEqual(changed.filter(id => id === 'eh').length, 1);
        assert.ok(!needsConversion([eh]));
    });

    it('says that embedded tools are now write tools', function () {
        const { notes } = convertFlows(fixture(), { mcpServerInstalled: true });
        assert.ok(notes.some(t => t.includes('write tools') && t.includes('fw')));
    });

    it('leaves nothing to convert, changes nothing on a second run, and does not mutate its input', function () {
        const input = fixture();
        const before = JSON.stringify(input);
        const first = convertFlows(input, { mcpServerInstalled: true });
        assert.strictEqual(JSON.stringify(input), before);
        assert.ok(needsConversion(input));
        assert.ok(!needsConversion(first.flows));
        const second = convertFlows(first.flows, { mcpServerInstalled: true });
        assert.deepStrictEqual(second.changed, []);
        assert.deepStrictEqual(second.notes, []);
        assert.deepStrictEqual(second.flows, first.flows);
    });
});

describe('resources/convert groups', function () {
    const { convertGroups } = require('../resources/convert');
    function groupFixture() {
        return [
            { id: 'eh', type: 'hal2EventHandler', groups: [{ id: 'old', name: 'Already', haType: 'light' }] },
            { id: 'ttl', type: 'hal2ThingType', items: [{ id: 'i1', haType: 'light' }, { id: 'i2', haType: 'switch' }, { id: 'i3', haType: 'dimmer' }] },
            { id: 'th1', type: 'hal2Thing', thingType: 'ttl' },
            { id: 'th2', type: 'hal2Thing', thingType: 'ttl', groups: [{ item: 'i1', group: 'old' }] },
            { id: 'gp', type: 'hal2Group', name: 'Lamps', eventHandler: 'eh', ratelimit: '200',
              group: [{ thing: 'th1', item: 'i1' }, { thing: 'th2', item: 'i2' }] },
            { id: 'gin', type: 'hal2Group', name: 'In', eventHandler: 'eh', z: 't', x: 1, y: 2, input: true,
              group: [{ thing: 'th1', item: 'i3' }] },
            { id: 'gout', type: 'hal2Group', name: 'Out', eventHandler: 'eh', z: 't', output: true, wires: [['w']],
              group: [{ thing: 'th1', item: 'i1' }, { thing: 'th1', item: 'i3' }] },
            { id: 'gboth', type: 'hal2Group', name: 'Both', eventHandler: 'eh', z: 't', y: 10, input: true, output: true, wires: [['w']], group: [] },
            { id: 'gnoeh', type: 'hal2Group', name: 'Orphan', eventHandler: 'missing', group: [] },
            { id: 'act', type: 'hal2Action', commandset: [{ category: 'hal2Group', thing: 'gp' }] }
        ];
    }

    it('registers each group on its event handler under its own id, with a derived HAType', function () {
        const { flows } = convertGroups(groupFixture());
        const eh = byId(flows).eh;
        assert.deepStrictEqual(eh.groups.map(g => [g.id, g.haType]),
            [['old', 'light'], ['gp', 'light'], ['gin', 'dimmer'], ['gout', 'other'], ['gboth', 'other']]);
        assert.strictEqual(eh.groups[1].ratelimit, 200);
    });

    it('moves membership onto the things\' items, keeping what was there', function () {
        const n = byId(convertGroups(groupFixture()).flows);
        assert.deepStrictEqual(n.th2.groups, [{ item: 'i1', group: 'old' }, { item: 'i2', group: 'gp' }]);
        assert.deepStrictEqual(n.th1.groups.map(m => m.group), ['gp', 'gin', 'gout', 'gout']);
    });

    it('drops an unwired group and turns wired ones into Action and Event nodes with the same id', function () {
        const { flows, changed } = convertGroups(groupFixture());
        const n = byId(flows);
        assert.ok(!n.gp);
        assert.strictEqual(n.gin.type, 'hal2Action');
        assert.deepStrictEqual(n.gin.commandset[0], { category: 'hal2Group', thing: 'gin', item: 'gin', value: 'payload', type: 'msg', onchange: false });
        assert.deepStrictEqual([n.gout.type, n.gout.typeSel, n.gout.thing, n.gout.wires], ['hal2Event', 'hal2Group', 'gout', [['w']]]);
        assert.strictEqual(n.gboth.type, 'hal2Action');
        const extra = flows.filter(x => x.type === 'hal2Event' && x.thing === 'gboth');
        assert.strictEqual(extra.length, 1);
        assert.deepStrictEqual([extra[0].wires, extra[0].y, extra[0].name], [[['w']], 50, 'Both (event)']);
        assert.ok(changed.includes(extra[0].id));
        assert.deepStrictEqual(n.act, groupFixture().find(x => x.id === 'act'));
    });

    it('keeps a wired group\'s disabled flag and group box on what it becomes', function () {
        const flows = groupFixture();
        Object.assign(flows.find(n => n.id === 'gboth'), { d: true, g: 'box' });
        const out = convertGroups(flows).flows.filter(n => n.id === 'gboth' || n.thing === 'gboth');
        assert.strictEqual(out.length, 2);
        for (const n of out) { assert.deepStrictEqual([n.d, n.g], [true, 'box'], n.type); }
        assert.ok(!('d' in byId(convertGroups(groupFixture()).flows).gin));
    });

    it('leaves a group without an event handler, and says so', function () {
        const { flows, notes } = convertGroups(groupFixture());
        assert.strictEqual(byId(flows).gnoeh.type, 'hal2Group');
        assert.ok(notes.some(t => t.includes('Orphan')));
        assert.ok(notes.some(t => t.includes('4 group(s)')));
    });

    it('is part of convertFlows and needsConversion, and does not mutate its input', function () {
        const input = groupFixture();
        const before = JSON.stringify(input);
        assert.ok(needsConversion(input));
        const r = convertFlows(input, { mcpServerInstalled: false });
        assert.strictEqual(JSON.stringify(input), before);
        assert.ok(r.changed.includes('gp') && r.changed.includes('eh'));
        assert.deepStrictEqual(convertGroups(r.flows.filter(x => x.id !== 'gnoeh')).changed, []);
    });
});

'use strict';
// get_all_states shapes its answer three ways, and the modes are not simply more and less of one
// another: summary and items each choose what a caller needs to tell two devices apart. That
// choice was made inline in the dispatch, where nothing could reach it, and `room` was quietly
// left out of both — present in `full`, absent from the mode almost every call uses. Since the
// room left the name, a summary listing of five things called "Golvspot" is unusable without it.
//
// So the projection is a pure function now, and these tests are what say which fields each mode
// owes its caller.

const assert = require('node:assert');
const { projectDevices } = require('../core/mcp-tools');

const DEVICES = [
    {
        id: 't1', name: 'Golvspot', type_id: 'tt1', type_name: 'Zigbee Light',
        alive: true, last_change: '2026-09-03T10:00:00.000Z',
        room: 'Kontor', notes: 'behind the desk', tags: ['inne'],
        categories: ['light'], metadata: { ip: '10.0.0.5' },
        items: [
            { item_id: 'on', item_name: 'On', ha_type: 'switch', device_class: 'light', value: true },
            { item_id: 'bri', item_name: 'Brightness', ha_type: 'dimmer', value: 40, history: true }
        ]
    },
    {
        id: 't2', name: 'Golvspot', type_id: 'tt1', type_name: 'Zigbee Light',
        alive: true, last_change: null, categories: ['light'], metadata: {},
        items: [{ item_id: 'on', item_name: 'On', ha_type: 'switch', value: false }]
    },
    // A scene: no room, and that is a complete answer rather than a missing one.
    {
        id: 't3', name: 'Natt', type_id: 'tt2', type_name: 'Scene',
        alive: true, last_change: null, metadata: {},
        items: [{ item_id: 'go', item_name: 'Activate', ha_type: 'scene' }]
    }
];

describe('projectDevices', function () {
    describe('summary — the default, and the orientation mode', function () {
        const out = projectDevices(DEVICES, 'summary');

        it('carries the room, which is what tells two devices of the same name apart', function () {
            // The regression this file exists for. Both things are called "Golvspot"; without the
            // room the list cannot be acted on, and the room is exactly what the rename moved out
            // of the name.
            assert.strictEqual(out[0].room, 'Kontor');
            assert.strictEqual(out[0].name, out[1].name, 'the fixture must keep the names colliding');
        });

        it('omits the key entirely when a device has no room', function () {
            // Not null: absence is the answer for a scene, and a null would read as unfinished.
            assert.ok(!('room' in out[2]), 'a scene should carry no room key at all');
        });

        it('keeps the other fields that disambiguate, and nothing heavy', function () {
            assert.deepStrictEqual(Object.keys(out[0]).sort(),
                ['alive', 'categories', 'id', 'last_change', 'name', 'notes', 'room', 'tags', 'type_name']);
            assert.ok(!('items' in out[0]) && !('metadata' in out[0]),
                'summary must stay lightweight');
        });

        it('is what an absent fields argument selects', function () {
            assert.deepStrictEqual(projectDevices(DEVICES), out);
            assert.deepStrictEqual(projectDevices(DEVICES, undefined), out);
        });

        it('reports a never-changed device as null rather than dropping the key', function () {
            assert.strictEqual(out[1].last_change, null);
        });
    });

    describe('items — the id index', function () {
        const out = projectDevices(DEVICES, 'items');

        it('carries the room too: picking an id out of colliding names is the whole job', function () {
            assert.strictEqual(out[0].room, 'Kontor');
            assert.ok(!('room' in out[2]));
        });

        it('strips notes, tags, values and metadata — room is not one of those', function () {
            assert.deepStrictEqual(Object.keys(out[0]).sort(), ['id', 'items', 'name', 'room', 'type_name']);
            assert.ok(out[0].items.every(i => !('value' in i)));
        });

        it('flags an item with history and stays silent about one without', function () {
            assert.deepStrictEqual(out[0].items[1],
                { item_id: 'bri', item_name: 'Brightness', ha_type: 'dimmer', history: true });
            assert.ok(!('history' in out[0].items[0]));
        });
    });

    describe('full', function () {
        it('hands the entries back as they were built, room included', function () {
            const out = projectDevices(DEVICES, 'full');
            assert.deepStrictEqual(out, DEVICES);
            assert.strictEqual(out[0].room, 'Kontor');
        });
    });

    it('does not mutate the entries it was given', function () {
        const before = JSON.parse(JSON.stringify(DEVICES));
        projectDevices(DEVICES, 'summary');
        projectDevices(DEVICES, 'items');
        assert.deepStrictEqual(DEVICES, before);
    });

    it('survives an empty or missing device list', function () {
        assert.deepStrictEqual(projectDevices([], 'summary'), []);
        assert.deepStrictEqual(projectDevices(undefined, 'items'), []);
        assert.deepStrictEqual(projectDevices(undefined, 'full'), []);
    });
});

describe('get_all_states says in its description that room comes back', function () {
    const { MCP_TOOLS } = require('../core/mcp-tools');
    const tool = MCP_TOOLS.find(t => t.name === 'get_all_states');

    it('documents room as an output field, not only as a filter', function () {
        // A field nothing describes is a field no assistant reads. The parameter was documented
        // from the start; the field it filters on was not mentioned anywhere.
        assert.ok(/carries room when it has one/.test(tool.description),
            'the description never says room is returned');
        assert.ok(tool.inputSchema.properties.room, 'room must remain a filter as well');
    });
});

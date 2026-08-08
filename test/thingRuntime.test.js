'use strict';
// core/thing.js needs a Node-RED runtime, so it is loaded against a stub RED rather than
// required for its exports. Only the paths that do not need the event bus are exercised:
// metadata mappings, and the `store` handed to a ThingType's functions.

const assert = require('node:assert');
const path = require('node:path');

const THING = path.join(__dirname, '..', 'core', 'thing.js');

// Builds a Thing wired to the given ThingType, and returns it along with the context store it
// persists into, so a test can check what would survive a restart.
function makeThing(thingType, thingConfig) {
    const ctxStore = {};
    const nodeContext = { get: k => ctxStore[k], set: (k, v) => { ctxStore[k] = v; } };

    const eventHandler = {
        publishUpdate: () => {}, publishLog: () => {},
        subscribe: () => {}, unsubscribe: () => {},
        ingressLibrary: [], egressLibrary: []
    };

    let registered = null;
    const RED = {
        nodes: {
            createNode(node, config) {
                node.id = config.id;
                node.context = () => nodeContext;
                node.on = (ev, fn) => { if (ev === 'input') { node._input = fn; } };
                node.status = s => { node._status = s; };
                node.debug = () => {}; node.warn = () => {}; node.error = () => {};
                node.send = () => {};
            },
            getNode: id => (id === 'tt1' ? thingType : eventHandler),
            registerType: (name, fn) => { registered = fn; }
        },
        util: {
            cloneMessage: m => JSON.parse(JSON.stringify(m)),
            generateId: () => 'id',
            getMessageProperty: (msg, prop) => msg[prop]
        },
        httpAdmin: { get() {}, delete() {} },
        auth: { needsPermission: () => (() => {}) },
        library: { register() {} }
    };

    delete require.cache[require.resolve(THING)];
    require(THING)(RED);

    const node = {};
    registered.call(node, Object.assign({
        id: 'thing1', thingType: 'tt1', eventHandler: 'eh1', name: 'Kontor ESP',
        attributes: [], groups: []
    }, thingConfig));

    return { node, ctxStore };
}

const esphomeType = () => ({
    id: 'tt1',
    name: 'ESPHome Device',
    contextStore: 'memory',
    nodestatus: '',
    nodestatusType: 'function',
    statusFn: "return 'rssi=' + item['WiFi RSSI'] + ' seen=' + (store.get('seen') || 0);",
    filterFunction: 'f_count',
    items: [
        { name: 'WiFi RSSI', id: 'i_rssi', type: 'status',
          topicFilters: [{ field: 'topic', matchType: 'StrEnd', value: '/device/wifi' }],
          ingress: 'in_rssi' }
    ],
    metadata: [
        { name: 'WiFi', key: 'wifi',
          topicFilters: [{ field: 'topic', matchType: 'StrEnd', value: '/device/wifi' }],
          ingress: 'in_wifi' },
        { name: 'Device', key: 'device',
          topicFilters: [{ field: 'topic', matchType: 'StrEnd', value: '/device/status' }],
          ingress: 'in_version' }
    ],
    ingress: [
        { id: 'f_count',  fn: "store.set('seen', (store.get('seen') || 0) + 1); return true;" },
        { id: 'in_rssi',  fn: "if (msg.payload && msg.payload.rssi != null) { return Number(msg.payload.rssi); }" },
        { id: 'in_wifi',  fn: "if (!msg.payload || typeof msg.payload !== 'object') { return null; }\nreturn { ip: msg.payload.ip, ssid: msg.payload.ssid, bssid: msg.payload.bssid };" },
        { id: 'in_version', fn: "if (msg.payload && msg.payload.version) { return { version: msg.payload.version }; }" }
    ],
    egress: [],
    hbCheck: false, hbType: 'lwt', outputs: 0
});

const thingConfig = {
    topicPrefix: 'esphome/kontor',
    topicFilters: [{ field: 'topic', matchType: 'mqtt', value: 'esphome/kontor/#' }]
};

describe('hal2Thing metadata mappings', function () {
    it('routes a matching topic into metadata, flattened under the mapping key', function () {
        const { node } = makeThing(esphomeType(), thingConfig);
        node._input({ topic: 'esphome/kontor/device/wifi',
                      payload: { ip: '192.168.240.182', ssid: 'ftb-iot', bssid: 'AC:8B:A9:26:5F:09', rssi: -85 } });
        assert.deepStrictEqual(node.getMetadata(), {
            'wifi.ip': '192.168.240.182',
            'wifi.ssid': 'ftb-iot',
            'wifi.bssid': 'AC:8B:A9:26:5F:09'
        });
    });

    it('still feeds the items from the same message', function () {
        // The wifi topic carries both a fact (ssid) and a measurement (rssi); one message has to
        // be able to land in both places.
        const { node } = makeThing(esphomeType(), thingConfig);
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { ip: '10.0.0.5', rssi: -46 } });
        assert.strictEqual(node.state.i_rssi, -46);
    });

    it('merges a second mapping without disturbing the first', function () {
        const { node } = makeThing(esphomeType(), thingConfig);
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { ip: '10.0.0.5', ssid: 'iot' } });
        node._input({ topic: 'esphome/kontor/device/status', payload: { version: '2026.7.2', uptime: 962.8 } });
        assert.strictEqual(node.getMetadata()['device.version'], '2026.7.2');
        assert.strictEqual(node.getMetadata()['wifi.ssid'], 'iot');
    });

    it('drops a leaf the source stopped sending', function () {
        const { node } = makeThing(esphomeType(), thingConfig);
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { ip: '10.0.0.5', ssid: 'iot' } });
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { ip: '10.0.0.5' } });
        assert.strictEqual(node.getMetadata()['wifi.ssid'], undefined);
        assert.strictEqual(node.getMetadata()['wifi.ip'], '10.0.0.5');
    });

    it('leaves metadata alone for a topic no mapping matches', function () {
        const { node } = makeThing(esphomeType(), thingConfig);
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { ip: '10.0.0.5' } });
        const before = JSON.stringify(node.getMetadata());
        node._input({ topic: 'esphome/kontor/online', payload: true });
        assert.strictEqual(JSON.stringify(node.getMetadata()), before);
    });

    it('redraws the status after a metadata-only message', function () {
        // Nothing else would: no item changed, so without this the status line would keep
        // showing a store value the filter function has already moved on from.
        const { node } = makeThing(esphomeType(), thingConfig);
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { ip: '10.0.0.5', rssi: -46 } });
        node._input({ topic: 'esphome/kontor/device/status', payload: { version: '2026.7.2' } });
        assert.strictEqual(node._status.text, 'rssi=-46 seen=2');
    });
});

describe('hal2Thing function store', function () {
    it('is injected into the filter function and kept between messages', function () {
        const { node } = makeThing(esphomeType(), thingConfig);
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { rssi: -46 } });
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { rssi: -47 } });
        assert.strictEqual(node.getStore().seen, 2);
    });

    it('is injected into the status function', function () {
        const { node } = makeThing(esphomeType(), thingConfig);
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { rssi: -46 } });
        assert.strictEqual(node._status.text, 'rssi=-46 seen=1');
    });

    it('persists through the context store, so it survives a restart', function () {
        const { node, ctxStore } = makeThing(esphomeType(), thingConfig);
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { rssi: -46 } });
        assert.deepStrictEqual(ctxStore.store, { seen: 1 });
    });

    it('starts from whatever the context store already held', function () {
        const type = esphomeType();
        const { node } = makeThing(type, thingConfig);
        node.store.seen = 41;                      // stand in for a value restored at startup
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { rssi: -46 } });
        assert.strictEqual(node.getStore().seen, 42);
    });

    it('clearStore empties it, and the functions keep working afterwards', function () {
        const { node } = makeThing(esphomeType(), thingConfig);
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { rssi: -46 } });
        node.clearStore();
        assert.deepStrictEqual(node.getStore(), {});
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { rssi: -46 } });
        assert.strictEqual(node.getStore().seen, 1);
    });

    it('clearStore with a key removes only that key', function () {
        const { node } = makeThing(esphomeType(), thingConfig);
        node._input({ topic: 'esphome/kontor/device/wifi', payload: { rssi: -46 } });
        node.getStore().other = 'keep';
        node.clearStore('seen');
        assert.deepStrictEqual(node.getStore(), { other: 'keep' });
    });
});

'use strict';
// core/thing.html's Items section is browser code, so it runs here in a sandbox against a stub
// jQuery, the same approach test/gateEditor.test.js takes. What is under test is the round trip:
// a Thing type's items plus whatever is already stored are rendered, and oneditsave reads the
// rendered blocks back into `groups` and `itemFacts`. Getting that wrong silently drops group
// memberships that run in production, and it is not visible by reading.
//
// The stub models enough of a DOM to carry the data — creation, nesting, val/data, find/each.
// It does not model jQuery, so this proves the data flow and not the rendering: whether the row
// *looks* right is still a question only the editor can answer.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'core', 'thing.html'), 'utf8');
const source = html.match(/<script type="text\/javascript">([\s\S]*?)<\/script>/)[1];

// resources/hal.js run once for real, so the pure helpers the section relies on are the shipped
// ones rather than stubs. It is browser code with no exports, so it is evaluated in its own
// sandbox and the wanted names lifted out — the approach test/halEditorHelpers.test.js takes.
const HAL = { console };
HAL.self = HAL;
HAL.window = HAL;
vm.createContext(HAL);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'resources', 'hal.js'), 'utf8'), HAL);

function makeEl(tag, attrs) {
    const el = {
        tag,
        attrs: attrs || {},
        children: [],
        _val: undefined,
        _data: {},
        _text: '',
        handlers: {}
    };
    const api = {
        el,
        appendTo(parent) { parent.el ? parent.el.children.push(el) : parent.children.push(el); return api; },
        append(child) { el.children.push(child.el || child); return api; },
        text(t) { if (t === undefined) { return el._text; } el._text = String(t); return api; },
        html(h) { el._html = h; return api; },
        // Faithful on the one point the drop hazard turns on: jQuery's .val() against a select
        // with no matching <option> selects nothing, and .val() then reads back null. A stub that
        // simply stored the value would make the test agree with itself.
        val(v) {
            if (v === undefined) { return el._val; }
            const opts = el.children.filter(c => c.tag === 'option');
            el._val = (el.tag === 'select' && opts.length && !opts.some(o => o._val === v)) ? null : v;
            return api;
        },
        data(k, v) { if (v === undefined) { return el._data[k]; } el._data[k] = v; return api; },
        click(fn) { el.handlers.click = fn; return api; },
        change(fn) { el.handlers.change = fn; return api; },
        toggle() { return api; },
        remove() { el.removed = true; return api; },
        empty() { el.children = []; return api; },
        find(sel) { return collect(el, sel); },
        each(fn) { fn.call(api, 0, api); return api; },
        // The dialog's other sections (topic filters, attributes) are editableLists. They are
        // not under test, so the stub only has to let their setup run without throwing.
        editableList(arg) { return arg === 'items' ? { each() {} } : api; },
        show() { return api; }, hide() { return api; }, css() { return api; },
        prop() { return api; }, attr() { return api; }, addClass() { return api; },
        removeClass() { return api; }, trigger(ev) {
            if (el.handlers[ev]) { el.handlers[ev].call(api); }
            return api;
        }
    };
    el.api = api;
    return api;
}

// Depth-first walk collecting elements whose class attribute names `sel` (".cls" only — the
// selectors this section uses are all single class names).
function descendants(el, out) {
    for (const c of el.children) {
        if (c.removed) { continue; }
        out.push(c);
        descendants(c, out);
    }
    return out;
}
function collect(el, sel) {
    const cls = sel.replace(/^\./, '');
    const hits = descendants(el, []).filter(c => String(c.attrs.class || '').split(/\s+/).includes(cls));
    return {
        each(fn) { hits.forEach((h, i) => fn.call(h.api, i, h.api)); },
        val() { return hits.length ? hits[0]._val : undefined; },
        length: hits.length
    };
}

function run({ items, groups, node, overrides }) {
    const container = makeEl('div', { id: 'thing-facts-container' });
    const inputs = {
        '#node-input-thingType': makeEl('input').val('tt1'),
        '#node-input-eventHandler': makeEl('input').val('eh1'),
        '#node-input-tags': makeEl('input').val('')
    };

    const $ = function (sel, attrs) {
        // $(this) inside an .each() — hand back the element itself, not a fresh one.
        if (sel && typeof sel === 'object' && sel.el) { return sel; }
        if (typeof sel === 'string' && sel.startsWith('<')) {
            return makeEl(sel.replace(/[<>/]/g, '').split(' ')[0], attrs);
        }
        if (sel === '#thing-facts-container') { return container; }
        if (sel === '#thing-facts-container .thing-fact-item') {
            return collect(container.el, '.thing-fact-item');
        }
        if (inputs[sel]) { return inputs[sel]; }
        // Everything else in the dialog is out of scope for this test.
        return makeEl('div');
    };

    const RED = {
        nodes: {
            registerType(name, def) { RED._def = def; },
            node: id => (id === 'tt1' ? { items } : { groups }),
            filterNodes: () => []
        },
        _def: null
    };

    // oneditprepare runs the whole dialog, not just the section under test, so every hal*
    // helper it might reach is stubbed to a no-op. The names are read out of resources/hal.js
    // rather than listed here, so a new helper does not break this test on the day it lands.
    const helperSrc = fs.readFileSync(path.join(__dirname, '..', 'resources', 'hal.js'), 'utf8');
    const sandbox = { RED, $, jQuery: $, console };
    for (const m of helperSrc.matchAll(/^function (hal\w+)/gm)) {
        sandbox[m[1]] = () => [];
    }
    // The decision helpers get their real implementations. A blanket `() => []` returns something
    // truthy, which made every group read as refused — and the tests still passed, because the
    // orphan path then kept each stored membership and marked it. Twelve greens for the wrong
    // reason. These four decide what the section under test does, so they cannot be stubs.
    for (const name of ['halStatusItem', 'halCommandItem', 'halGroupPolicy', 'halGroupCapabilityRefusal']) {
        sandbox[name] = HAL[name];
    }
    sandbox.halGroupAccepts = (overrides && overrides.halGroupAccepts) || (() => true);
    sandbox.halParseTags = () => [];
    sandbox.hal2DeviceClass = require('../resources/device-class');
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);

    const def = RED._def;
    def.oneditprepare.call(node);
    return { def, node, container };
}

// oneditsave assigns arrays created inside the sandbox, whose Array prototype is not this
// realm's — deepStrictEqual rejects them however equal the contents are. Compare the data.
const plain = x => JSON.parse(JSON.stringify(x));

// `type` is what decides whether an item reports, accepts commands, or both, and the section
// reads it — so the fixture carries it. Without it every item read as neither, every group read
// as refused, and the whole suite went green through the orphan path instead of the happy one.
const ITEMS = [
    { id: '1',   name: 'Alive',    haType: '',       type: 'status' },
    { id: 'on1', name: 'Eluttag',  haType: 'switch', type: 'both' },
    { id: 'on2', name: 'Taklampa', haType: 'switch', type: 'both' },
    { id: 'bri', name: 'Light',    haType: 'dimmer', type: 'both' },
    // The item this feature exists for: a Zigbee2MQTT Color Light's On reports and takes no
    // commands. Appended, so the index-based assertions above it keep addressing the same rows.
    { id: 'ro',  name: 'On',       haType: 'switch', type: 'status' }
];
const GROUPS = [{ id: 'g1', name: 'Alla lampor', haType: 'light' }];

describe('core/thing.html — the Items section', function () {
    it('renders every item of the type, including ones nothing has been said about', function () {
        const node = { groups: [], itemFacts: [] };
        const { container } = run({ items: ITEMS, groups: GROUPS, node });
        const blocks = collect(container.el, '.thing-fact-item');
        // 'Alive' (id '1') is excluded; the rest are always present, which is the whole
        // point — you can see what an item presents as without adding a row first.
        assert.strictEqual(blocks.length, 4);
    });

    it('carries a stored device class back out unchanged', function () {
        const node = {
            groups: [],
            itemFacts: [{ item: 'on2', kind: 'device_class', value: 'light' }]
        };
        const { def } = run({ items: ITEMS, groups: GROUPS, node });
        def.oneditsave.call(node);
        assert.deepStrictEqual(plain(node.itemFacts),
            [{ item: 'on2', kind: 'device_class', value: 'light' }]);
    });

    it('cannot give one item two device classes', function () {
        const node = {
            groups: [],
            // Even handed duplicates, the render collapses them to the item's one control.
            itemFacts: [
                { item: 'on2', kind: 'device_class', value: 'light' },
                { item: 'on2', kind: 'device_class', value: 'fan' }
            ]
        };
        const { def } = run({ items: ITEMS, groups: GROUPS, node });
        def.oneditsave.call(node);
        const forOn2 = plain(node.itemFacts).filter(f => f.item === 'on2');
        assert.strictEqual(forOn2.length, 1, 'one item, one class');
    });

    it('preserves group membership across the round trip', function () {
        const node = {
            groups: [{ item: 'on2', group: 'g1' }, { item: 'bri', group: 'g1' }],
            itemFacts: []
        };
        const { def } = run({ items: ITEMS, groups: GROUPS, node });
        def.oneditsave.call(node);
        assert.deepStrictEqual(
            plain(node.groups).sort((a, b) => a.item.localeCompare(b.item)),
            [{ item: 'bri', group: 'g1' }, { item: 'on2', group: 'g1' }],
            'membership that runs in production must survive the redesign');
    });

    it('keeps the two stores apart', function () {
        const node = {
            groups: [{ item: 'on2', group: 'g1' }],
            itemFacts: [{ item: 'on2', kind: 'device_class', value: 'light' }]
        };
        const { def } = run({ items: ITEMS, groups: GROUPS, node });
        def.oneditsave.call(node);
        assert.deepStrictEqual(plain(node.groups), [{ item: 'on2', group: 'g1' }]);
        assert.deepStrictEqual(plain(node.itemFacts),
            [{ item: 'on2', kind: 'device_class', value: 'light' }]);
    });

    describe('the device class control', function () {
        // It is only worth asking where the ha_type leaves the question open — a switch. Offering
        // it on every row made the exceptional case look like the norm.
        it('appears on a switch', function () {
            const node = { groups: [], itemFacts: [] };
            const { container } = run({ items: ITEMS, groups: GROUPS, node });
            const blocks = [];
            collect(container.el, '.thing-fact-item').each((i, api) => blocks.push(api));
            const onSwitch = blocks[0].find('.thing-fact-class');   // on1, ha_type switch
            assert.strictEqual(onSwitch.length, 1);
        });

        it('is absent on an item whose ha_type already answers it', function () {
            const node = { groups: [], itemFacts: [] };
            const { container } = run({ items: ITEMS, groups: GROUPS, node });
            const blocks = [];
            collect(container.el, '.thing-fact-item').each((i, api) => blocks.push(api));
            // ITEMS[3] is 'bri' (dimmer); blocks skip the Alive item, so index 2.
            assert.strictEqual(blocks[2].find('.thing-fact-class').length, 0);
        });

        it('still appears where one is stored anyway, so it is not dropped in silence', function () {
            const node = {
                groups: [],
                // A dimmer carrying a declaration — possible from the wider vocabulary this
                // replaced. Hiding the control would delete it on the next Done.
                itemFacts: [{ item: 'bri', kind: 'device_class', value: 'light' }]
            };
            const { def } = run({ items: ITEMS, groups: GROUPS, node });
            def.oneditsave.call(node);
            assert.deepStrictEqual(plain(node.itemFacts),
                [{ item: 'bri', kind: 'device_class', value: 'light' }]);
        });
    });

    it('marks a membership that the declared class contradicts, and keeps it', function () {
        // Vardagsrum Dubbelbrytare: On1 drives the socket and was in "all lights" anyway. Declaring
        // it an outlet must surface that, not delete it — the row is the only place it shows.
        const node = {
            groups: [{ item: 'on1', group: 'g1' }],
            itemFacts: [{ item: 'on1', kind: 'device_class', value: 'outlet' }]
        };
        const { def } = run({
            items: ITEMS, groups: GROUPS, node,
            overrides: { halGroupAccepts: (g, i, c) => (c ? c === g : true) }
        });
        def.oneditsave.call(node);
        assert.deepStrictEqual(plain(node.groups), [{ item: 'on1', group: 'g1' }],
            'the contradiction must be visible, not quietly removed');
    });

    describe('a membership whose group no longer fits', function () {
        // The rule is about to be tightened, which is exactly what turns a stored pairing
        // incompatible. The row must keep it rather than delete it on the next Done.
        const strict = { halGroupAccepts: (g, i) => g === i };

        it('keeps it, so tightening the rule cannot delete data silently', function () {
            const node = {
                groups: [{ item: 'bri', group: 'g1' }],   // dimmer item in a light group
                itemFacts: []
            };
            const { def } = run({ items: ITEMS, groups: GROUPS, node, overrides: strict });
            def.oneditsave.call(node);
            assert.deepStrictEqual(plain(node.groups), [{ item: 'bri', group: 'g1' }],
                'an incompatible membership must survive until someone removes it deliberately');
        });

        it('drops one whose group is gone, since there is nothing to keep', function () {
            const node = { groups: [{ item: 'bri', group: 'deleted' }], itemFacts: [] };
            const { def } = run({ items: ITEMS, groups: GROUPS, node });
            def.oneditsave.call(node);
            assert.deepStrictEqual(plain(node.groups), []);
        });
    });

    it('writes nothing for a Thing where nothing was declared', function () {
        const node = { groups: [], itemFacts: [] };
        const { def } = run({ items: ITEMS, groups: GROUPS, node });
        def.oneditsave.call(node);
        assert.deepStrictEqual(plain(node.itemFacts), []);
        assert.deepStrictEqual(plain(node.groups), []);
    });
});

// Rows in render order, minus the heartbeat item the section filters out.
function blocksOf(container) {
    const out = [];
    collect(container.el, '.thing-fact-item').each((i, api) => out.push(api));
    return out;
}
// The option labels of a block's group selects, one array per row. Every child of a select here
// is an option, so they are taken wholesale rather than filtered by tag: the stub's tag parsing
// turns `<option></option>` into "optionoption", and filtering on 'option' silently found none.
function optionsOf(blockApi) {
    const out = [];
    blockApi.find('.thing-fact-group').each(function (i, api) {
        out.push(api.el.children.map(o => o._text));
    });
    return out;
}

// Rows are indexed by render order, which skips the heartbeat item — so on1, on2, bri, ro.
const ROW = { on1: 0, on2: 1, bri: 2, ro: 3 };

// Press the row's "+ Add group" link, which is where the choice is actually made.
function addGroupRow(blockApi) {
    let clicked = false;
    blockApi.find('.thing-fact-add-group').each(function (i, api) {
        api.el.handlers.click({ preventDefault() {} });
        clicked = true;
    });
    assert.ok(clicked, 'no + Add group link on this row');
}

describe('core/thing.html — what an item can do', function () {
    // A group that takes only what can be commanded. Both flags absent elsewhere in this file,
    // which is the point: that reads as accepting everything.
    const CMD_ONLY = [{ id: 'g1', name: 'Alla lampor', haType: 'light', acceptsState: false }];

    it('says so on the row when an item only reports', function () {
        const node = { groups: [], itemFacts: [] };
        const { container } = run({ items: ITEMS, groups: GROUPS, node });
        const blocks = blocksOf(container);
        assert.strictEqual(blocks[ROW.ro].find('.thing-fact-capability').length, 1, 'ro is status-only');
        let text = '';
        blocks[ROW.ro].find('.thing-fact-capability').each((i, api) => { text = api.text(); });
        assert.match(text, /state only/);
    });

    it('stays silent on the ordinary item that does both', function () {
        // Printing it on every row would bury the one row that matters.
        const node = { groups: [], itemFacts: [] };
        const { container } = run({ items: ITEMS, groups: GROUPS, node });
        for (const key of ['on1', 'on2', 'bri']) {
            assert.strictEqual(blocksOf(container)[ROW[key]].find('.thing-fact-capability').length, 0,
                key + ' does both and should say nothing');
        }
    });

    it('does not offer a command-only group to an item that only reports', function () {
        // Pressing "+ Add group" is the moment the mistake was made, so the test presses it. An
        // earlier version of this only checked that no row existed yet, which was true whether
        // or not the group was being filtered — it passed with the feature removed.
        const node = { groups: [], itemFacts: [] };
        const { container } = run({ items: ITEMS, groups: CMD_ONLY, node });
        addGroupRow(blocksOf(container)[ROW.ro]);
        const rows = optionsOf(blocksOf(container)[ROW.ro]);
        assert.strictEqual(rows.length, 1, 'a row should have been added');
        assert.deepStrictEqual(rows[0], ['\u2014 no compatible group \u2014'],
            'the group takes only what can be commanded, and this item cannot be');
    });

    it('offers it to an item that can be commanded, from the same press', function () {
        // The other half: the filter has to be a filter, not a blanket refusal.
        const node = { groups: [], itemFacts: [] };
        const { container } = run({ items: ITEMS, groups: CMD_ONLY, node });
        addGroupRow(blocksOf(container)[ROW.on2]);
        assert.deepStrictEqual(optionsOf(blocksOf(container)[ROW.on2])[0], ['Alla lampor (light)']);
    });

    it('still offers it to an item that both reports and accepts commands', function () {
        // An item that does both can serve as the group's target, so refusing it would leave a
        // command group unable to hold an ordinary switch.
        const node = { groups: [{ item: 'on2', group: 'g1' }], itemFacts: [] };
        const { container } = run({ items: ITEMS, groups: CMD_ONLY, node });
        const rows = optionsOf(blocksOf(container)[ROW.on2]);
        assert.strictEqual(rows.length, 1);
        assert.ok(!rows[0].some(t => /incompatible/.test(t)),
            'a both-capable item belongs in a command group without complaint');
    });

    describe('a membership the group no longer admits', function () {
        // The mistake being fixed, after the fact: On is already in the group, and the group is
        // then declared command-only. The pairing is wrong and has to be visible — deleting it
        // on the next Done is how the original mistake stayed invisible for so long.
        const node = () => ({ groups: [{ item: 'ro', group: 'g1' }], itemFacts: [] });

        it('keeps it through a save rather than dropping it in silence', function () {
            const n = node();
            const { def } = run({ items: ITEMS, groups: CMD_ONLY, node: n });
            def.oneditsave.call(n);
            assert.deepStrictEqual(plain(n.groups), [{ item: 'ro', group: 'g1' }],
                'a membership must survive until someone removes it deliberately');
        });

        it('marks it with the reason, so the row says which contract it fails', function () {
            const n = node();
            const { container } = run({ items: ITEMS, groups: CMD_ONLY, node: n });
            const rows = optionsOf(blocksOf(container)[ROW.ro]);
            assert.strictEqual(rows.length, 1);
            assert.ok(rows[0].some(t => /incompatible: state only/.test(t)),
                'expected the reason in the label, got ' + JSON.stringify(rows[0]));
        });
    });

    it('leaves every membership alone while both flags are ticked', function () {
        // The no-migration guarantee, at the level that matters: a group carrying neither flag
        // behaves exactly as it did before the flags existed.
        const n = { groups: [{ item: 'ro', group: 'g1' }, { item: 'on2', group: 'g1' }], itemFacts: [] };
        const { container, def } = run({ items: ITEMS, groups: GROUPS, node: n });
        def.oneditsave.call(n);
        assert.deepStrictEqual(
            plain(n.groups).sort((a, b) => a.item.localeCompare(b.item)),
            [{ item: 'on2', group: 'g1' }, { item: 'ro', group: 'g1' }]);
        for (const key of ['on2', 'ro']) {
            const rows = optionsOf(blocksOf(container)[ROW[key]]);
            assert.ok(!rows[0].some(t => /incompatible/.test(t)),
                key + ' must not be marked by a group that accepts everything');
        }
    });
});

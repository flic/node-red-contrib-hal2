'use strict';
// The control_* tools each answer "nothing was written" themselves, and their handlers sit in one
// long dispatch in core/eventhandler.js where every tail looks identical:
//
//     node.status({ fill: 'green', ... });
//     return toolOk(JSON.stringify({ success: true, results }));
//
// A patch aimed at one of them landed in another exactly because of that — set_light's guard went
// into control_fan, complete with a message about lights, and neither the unit tests nor a manual
// check of the decision helpers noticed, because nothing exercised the response. So this test
// reads the source: every tool that fans a command out to items must refuse when it wrote to
// none, and must do it in words about its own item types.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'eventhandler.js'), 'utf8');

// Each tool's handler runs from its own `toolName === 'x'` to the next one's.
function handlerBlock(tool) {
    // Anchor on `if (toolName === …` only: set_light's handler opens
    // `if (toolName === 'set_light' || toolName === 'control_light')`, and matching the second
    // alternative as a handler of its own would cut the block to a few characters.
    const anchors = [...SRC.matchAll(/if \(toolName === '(\w+)'/g)];
    const at = anchors.findIndex(m => m[1] === tool);
    assert.ok(at >= 0, `no handler for ${tool}`);
    const start = anchors[at].index;
    const end = at + 1 < anchors.length ? anchors[at + 1].index : SRC.length;
    return SRC.slice(start, end);
}

// tool → words its refusal must contain, being the item types it actually writes to.
const TOOLS = {
    control_fan: ['"fan"'],
    control_cover: ['"cover"'],
    control_spa: ['"heater"', '"circulation pump"', '"airjets"'],
    control_climate: ['"ac mode"', '"target temperature"'],
    set_light: ['"light"', 'device_class']
};

describe('control_* tools refuse instead of reporting an empty success', function () {
    for (const [tool, words] of Object.entries(TOOLS)) {
        describe(tool, function () {
            const block = handlerBlock(tool);

            it('guards its success answer on having written something', function () {
                assert.ok(/if \(!results\.some\(r => r\.commands\.length\)\)/.test(block),
                    `${tool} can still answer success with an empty command list`);
                assert.ok(block.includes('nothingToCommand('),
                    `${tool} does not build a refusal`);
            });

            it('refuses in words about its own item types', function () {
                // The check that catches a guard patched into the wrong handler.
                for (const w of words) {
                    assert.ok(block.includes(w),
                        `${tool}'s refusal never mentions ${w} — is this the right handler's message?`);
                }
            });

            it('names the things it matched, so the caller can see what they carry', function () {
                assert.ok(/nothingToCommand\(matched/.test(block),
                    `${tool} refuses without saying which things it looked at`);
            });
        });
    }

    it('gives no two tools the same refusal text', function () {
        // Identical wording in two handlers is the signature of a copy landing in the wrong one.
        const messages = Object.keys(TOOLS).map(t => {
            const m = handlerBlock(t).match(/nothingToCommand\([^,]+,\s*\n?\s*'([^']*)'/);
            return m ? m[1] : null;
        });
        assert.ok(messages.every(Boolean), 'a tool builds its refusal without a message');
        assert.strictEqual(new Set(messages).size, messages.length,
            'two tools share a refusal message');
    });
});

describe('nothingToCommand', function () {
    const { nothingToCommand } = require('../core/mcp-tools');

    it('reports the items with their class, which is what is usually missing', function () {
        const out = nothingToCommand([{
            thing_id: 't1', thing_name: 'Kök Taklampa',
            items: [{ item_id: 'on', item_name: 'On', ha_type: 'switch' }]
        }], 'needs a light.');
        assert.strictEqual(out.error, 'nothing_to_command');
        assert.ok(out.message.endsWith('needs a light.'));
        assert.deepStrictEqual(out.things[0].items, [
            { item_id: 'on', item_name: 'On', ha_type: 'switch', device_class: null }
        ]);
    });

    it('survives a thing with no items rather than throwing mid-answer', function () {
        assert.deepStrictEqual(nothingToCommand([{ thing_id: 't', thing_name: 'x' }], 'n').things[0].items, []);
        assert.deepStrictEqual(nothingToCommand(undefined, 'n').things, []);
    });
});

'use strict';
// Every editor that offers a Thing has to label it with halThingLabel, so the room shows as
// "[Kontor] Taklampa". Since the room left the name, two Things may legitimately share one, and a
// dropdown listing the bare name offers the same entry twice with no way to tell them apart.
//
// Seven editors do this and they were converted with a search-and-replace over the shape
//     .append($("<option></option>").val(x.id).text(x.name))
// which missed hal2Event's main Thing list — that one built its option as an HTML string, so the
// pattern did not match and the node shipped without room labels. Nothing failed; the list simply
// read wrong, and it was found by using the editor.
//
// So this asserts the property rather than the shape: no editor may put a Thing's name into a
// dropdown except through halThingLabel.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..', 'core');
const EDITORS = fs.readdirSync(CORE).filter(f => f.endsWith('.html'));

// The editors that offer a Thing to pick. thing.html is not one of them — it *is* the Thing, and
// labels itself through the same helper in its `label:` callback.
const OFFERS_THINGS = ['event.html', 'value.html', 'gate.html', 'action.html',
                       'group.html', 'bayes.html'];

describe('every Thing dropdown carries the room', function () {
    for (const file of OFFERS_THINGS) {
        const src = fs.readFileSync(path.join(CORE, file), 'utf8');

        describe(file, function () {
            it('is still an editor that lists Things', function () {
                // Guards the list above: if an editor stops using thingsList this test would
                // otherwise keep passing while asserting nothing.
                assert.match(src, /thingsList\[/, `${file} no longer lists Things — update this test`);
            });

            it('labels them through halThingLabel', function () {
                assert.match(src, /halThingLabel\(RED, thingsList\[/,
                    `${file} lists Things without labelling them`);
            });

            it('never puts a Thing name into an option directly', function () {
                // The miss this file exists for. Both spellings: the interpolated HTML string
                // hal2Event used, and a .text() handed the bare name.
                const raw = [
                    /\+\s*thingsList\[\w+\]\.name/,          // "..." + thingsList[t].name + "..."
                    /\.text\(\s*thingsList\[\w+\]\.name\s*\)/ // .text(thingsList[t].name)
                ];
                for (const re of raw) {
                    assert.ok(!re.test(src),
                        `${file} builds an option from a Thing's bare name (${re})`);
                }
            });
        });
    }

    it('leaves group and type lists alone', function () {
        // Groups and ThingTypes have no room, and an earlier pass wrapped those in halThingLabel
        // too before it was caught in review. Labelling them would print a bare name through a
        // room lookup that can never find one — harmless, but it says something untrue about
        // what the entry is.
        for (const file of EDITORS) {
            const src = fs.readFileSync(path.join(CORE, file), 'utf8');
            assert.ok(!/halThingLabel\(RED, (groupsList|thingTypeList)\[/.test(src),
                `${file} labels a group or type as though it had a room`);
        }
    });
});

'use strict';
// The Event handler carries two flat registries — rooms and groups — and each is addressed by
// name, so in each a repeated name is a fault. They are configured by two editableLists that look
// nothing alike, and the rule was added to one of them months before the other: the room check
// went in on its own, and the groups needed it too, discovered by eye.
//
// So this reads the editor source and asserts both registries carry both halves of the rule: the
// validate that refuses the deploy, and the live marking that says which row to fix. A third
// registry, or a dropped half, fails here rather than being noticed later.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'core', 'eventhandler.html'), 'utf8');

const REGISTRIES = {
    rooms:  { marker: 'hal2ehSyncRoomNames',  field: 'node-config-eh-room-name-property' },
    groups: { marker: 'hal2ehSyncGroupNames', field: 'node-config-eh-group-name-property' }
};

describe('rooms and groups are held to the same name rule', function () {
    for (const [registry, { marker, field }] of Object.entries(REGISTRIES)) {
        describe(registry, function () {
            it('refuses a deploy that would store a duplicate', function () {
                // Anchored on the property name, so a validate on the other registry cannot
                // satisfy this one — the failure mode when the same line is copied.
                const decl = SRC.match(new RegExp(registry + ':\\s*\\{[^}]*\\}', 's'));
                assert.ok(decl, `no ${registry} default found`);
                assert.match(decl[0], /validate:/, `${registry} has no validate`);
                assert.match(decl[0], /halDuplicateNames\(/,
                    `${registry}'s validate does not check for duplicate names`);
            });

            it('marks the colliding row while it is being typed', function () {
                assert.ok(SRC.includes(marker + '('), `${registry} never calls ${marker}`);
                assert.match(SRC, new RegExp("\\.on\\('input', " + marker + "\\)"),
                    `${registry}'s name field does not mark as it is typed`);
                assert.match(SRC, new RegExp('removeItem: ' + marker),
                    `${registry} does not re-check after a row is removed — ` +
                    'a deletion can resolve a collision');
            });

            it('marks through the class Node-RED marks an invalid field with', function () {
                // Not a colour of this dialog's own: input-error is themed, and it is what the
                // editor's own "that name is taken" checks use. An earlier version painted its
                // own amber border, which read as a different kind of problem.
                const fn = SRC.match(new RegExp('function ' + marker + '[\\s\\S]*?\\n            \\}'));
                assert.ok(fn, `${marker} is not defined`);
                assert.ok(fn[0].includes(field), `${marker} does not address ${registry}' name field`);
            });
        });
    }

    it('shares one duplicate check rather than one per registry', function () {
        // Two registries, one rule. The room check existed alone first and the temptation on the
        // second was to write it again beside it.
        const defined = [...SRC.matchAll(/function (hal2eh\w*Duplicate\w*)/g)].map(m => m[1]);
        assert.deepStrictEqual(defined, ['hal2ehMarkDuplicateNames'],
            'expected exactly one marking helper, found ' + JSON.stringify(defined));
    });

    it('compares names the way the tools do', function () {
        // The helper is hal.js's and tested there; this is the wiring assertion that the editor
        // uses that helper and not an inline comparison of its own.
        assert.ok(!/\.name\s*===\s*\w+\.name/.test(SRC),
            'a raw name comparison has crept back into the editor');
    });
});

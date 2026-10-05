const DEFAULT_TOPIC = 'hal2/<site>/event/<room>/<thing>/<item>';

module.exports = function(RED) {

    // A `/`, `+` or `#` inside a name would otherwise fork the topic hierarchy or inject an
    // MQTT wildcard into a PUBLISH topic (undefined behaviour on most brokers) — those, and any
    // run of whitespace, collapse to one `_`. A segment left empty (e.g. a Thing with no room)
    // becomes `_` rather than vanishing, so the topic's depth stays constant for a subscriber
    // matching on it with wildcards (e.g. `hal2/+/event/+/+/+`). Everything else — case, å/ä/ö —
    // passes through: MQTT is UTF-8 end to end, and reading the topic as the name is the point.
    function topicSegment(v) {
        const s = (v === undefined || v === null) ? '' : String(v).trim().replace(/[/+#\s]+/g, '_');
        return s || '_';
    }

    function hal2Emit(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.eventHandler   = RED.nodes.getNode(config.eventHandler);
        node.filters        = Array.isArray(config.filters) ? config.filters : [];
        // The editor prefills new nodes with DEFAULT_TOPIC, so an empty string here means the
        // user cleared it on purpose — msg.topic is then left unset below, not defaulted back.
        // undefined/null only happens for a node that predates this field (import, old flow).
        node.topicTemplate  = (typeof config.topic === 'string') ? config.topic : DEFAULT_TOPIC;

        if (!node.eventHandler) { return; }

        // Set once at node start (process start or redeploy) so a receiver can tell "new
        // session, seq resets" from "packets lost mid-session". Epoch ms, like every other
        // timestamp in the envelope — orderable as a plain number, no parsing needed.
        node.boot = Date.now();
        node.seq  = 0;

        // Guards against the one case a single logical update can reach this node's listener
        // twice: publishUpdate emits on both the thingtype channel and the thing channel for
        // the same eventmsg, synchronously, with nothing interleaved between the two calls —
        // so two filter rows (e.g. an "all things" row and a specific "thing" row) can each
        // cause a separate, synchronous invocation of the same listener for one update.
        node.lastMsgId = null;

        // Every item of every hal2Thing that belongs to this EventHandler, grouped by
        // thingType id. Needed to resolve "all things" / "ha_type" filter rows (which have
        // no channel of their own) into the set of thingType channels that cover them, and to
        // look up an item's ha_type for the envelope and for ha_type-scoped rows.
        function thingTypeIdsForThisHandler() {
            const ids = new Set();
            RED.nodes.eachNode(function (cfg) {
                if (cfg.type !== 'hal2Thing') { return; }
                const thing = RED.nodes.getNode(cfg.id);
                if (!thing || !thing.eventHandler || thing.eventHandler.id !== node.eventHandler.id) { return; }
                if (thing.thingType && thing.thingType.id) { ids.add(thing.thingType.id); }
            });
            return ids;
        }

        const channels = new Set();
        let needsThingTypes = false;
        for (const row of node.filters) {
            if (row.scope === 'all' || row.scope === 'hatype') { needsThingTypes = true; }
            else if (row.target)                               { channels.add(row.target); }
        }
        if (needsThingTypes) { for (const id of thingTypeIdsForThisHandler()) { channels.add(id); } }

        // { name, haType } for a Thing-scoped item, or null when the thing/item can no longer
        // be resolved (e.g. deleted since deploy).
        function resolveItem(thingId, itemId) {
            const thing = RED.nodes.getNode(thingId);
            if (!thing || !thing.thingType || !Array.isArray(thing.thingType.items)) { return null; }
            const itm = thing.thingType.items.find(i => i.id === itemId);
            return itm ? { name: itm.name, haType: itm.haType || '' } : null;
        }

        function rowMatches(row, thingTypeId, thingId, itemId, event) {
            const isGroup = !!event.group;
            if (row.mode === 'change' && event.state == event.laststate) { return false; }

            switch (row.scope) {
                case 'all':
                    return !isGroup && (!row.item || row.item === itemId);
                case 'thingtype':
                    return !isGroup && thingTypeId === row.target && (!row.item || row.item === itemId);
                case 'thing':
                    return !isGroup && thingId === row.target && (!row.item || row.item === itemId);
                case 'hatype': {
                    if (isGroup) { return false; }
                    const itm = resolveItem(thingId, itemId);
                    return !!itm && itm.haType === row.target;
                }
                case 'group':
                    return isGroup && thingId === row.target;
                default:
                    return false;
            }
        }

        function buildEnvelope(thingTypeId, thingId, itemId, event) {
            const envelope = {
                v:   1,
                type: 'event',
                boot: node.boot,
                seq:  ++node.seq,
                ts:   Date.now()
            };
            if (node.eventHandler.locationName) { envelope.site = node.eventHandler.locationName; }

            let lastChangeMs;
            if (event.group) {
                const def = node.eventHandler.groups.find(g => g.id === thingId);
                envelope.group = { id: thingId, name: event.group.name, ha_type: (def && def.haType) || '' };
                lastChangeMs = event.group.last_change;
            } else {
                envelope.thing = { id: thingId, name: event.thing.name };
                if (event.thing.room) { envelope.thing.room = event.thing.room; }
                const itm = resolveItem(thingId, itemId);
                envelope.item = { id: itemId, name: event.item.name, ha_type: (itm && itm.haType) || '' };
                lastChangeMs = event.item.last_change;
            }

            envelope.new = event.state;
            envelope.old = event.laststate;
            envelope.last_change = (typeof lastChangeMs === 'number') ? lastChangeMs : null;
            if (event.logtype) { envelope.origin = event.logtype; }

            return envelope;
        }

        // <site>/<room>/<thing>/<item> from the envelope just built, not from the raw event —
        // the envelope already picked the group-vs-thing/item branch once, so this only has to
        // read it back, not repeat that decision. For a group, <thing> is its name and <item>
        // its ha_type, the same stand-in used for the group's own `item` concept elsewhere.
        function buildTopic(envelope) {
            const room  = envelope.thing ? envelope.thing.room : '';
            const thing = envelope.thing ? envelope.thing.name : envelope.group.name;
            const item  = envelope.item  ? envelope.item.name : envelope.group.ha_type;
            // Lowercased whole, not per segment: a mixed-case Thing/Room name is the common
            // case, and a subscriber matching the topic literally (not just wildcards) needs
            // one predictable case throughout — including the static parts of a custom template.
            return node.topicTemplate
                .replace(/<site>/g,  topicSegment(envelope.site))
                .replace(/<room>/g,  topicSegment(room))
                .replace(/<thing>/g, topicSegment(thing))
                .replace(/<item>/g,  topicSegment(item))
                .toLowerCase();
        }

        node.listener = function (thingTypeId, thingId, itemId, event) {
            if (!event || event._msgid === node.lastMsgId) { return; }
            for (const row of node.filters) {
                if (rowMatches(row, thingTypeId, thingId, itemId, event)) {
                    node.lastMsgId = event._msgid;
                    const envelope = buildEnvelope(thingTypeId, thingId, itemId, event);
                    const msg = { payload: envelope };
                    if (node.topicTemplate) { msg.topic = buildTopic(envelope); }
                    node.send(msg);
                    return;
                }
            }
        };

        for (const channel of channels) {
            node.eventHandler.subscribe('update', channel, node.listener);
        }

        node.on('close', function () {
            for (const channel of channels) {
                node.eventHandler.unsubscribe('update', channel, node.listener);
            }
        });
    }

    RED.nodes.registerType('hal2Emit', hal2Emit);
};

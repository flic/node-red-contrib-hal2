'use strict';
// Shaping and lookup for the get_groups / control_group MCP tools.
//
// Pure, so the part with judgement in it is testable without a running Node-RED: what a group
// entry says about itself, and how a group is found from a name or an id. The dispatchers in
// core/eventhandler.js supply the registry and the live state and do the talking.

// One group as the tools report it. `info` is an entry from node.getGroups(); `state` is the
// record from node.getGroupState(), absent for a group that has no configured function;
// `computed` is a { value, live, members } read for a function asked for on the fly.
//
// The distinction the whole design rests on: `readable` and `controllable` are independent.
// A sensor group has a value and takes no commands; a scene group is the reverse. Reading uses
// the state-capable members, commanding the command-capable ones, and they are different sets.
//
// `readable` means the group can be read at all — it has members that carry state. Whether it
// has a *configured* function is a separate matter: without one it has no standing value, but
// any function can still be asked for. Conflating the two would hide seven readable groups
// behind the fact that nobody had picked a default for them.
function groupEntry(info, state, msToIso, computed) {
    const readable = info.stateMembers > 0;
    const entry = {
        group_id     : info.id,
        name         : info.name,
        readable     : readable,
        controllable : info.commandMembers > 0
    };
    if (info.haType) { entry.ha_type = info.haType; }

    if (readable) {
        entry.members = info.stateMembers;

        if (computed) {
            // A function asked for on this call. The engine keeps a record per function, so
            // the timestamps are this function's own rather than the default's.
            if (computed.value !== undefined) { entry.value = computed.value; }
            entry.function    = computed.fn;
            entry.live        = computed.live;
            entry.last_change = (computed.last_change && msToIso) ? msToIso(computed.last_change) : null;
            // Only when the function covered part of the group — on a mixed group `average`
            // uses the dimmers and ignores the switches, and a mean over 10 of 39 members
            // presented as the group's value is the kind of number that gets believed.
            if (typeof computed.used === 'number' && computed.used < computed.live) {
                entry.used = computed.used;
            }
            if (info.aggregate && info.aggregate !== computed.fn) {
                entry.configured_function = info.aggregate;
            }
        } else if (info.aggregate) {
            // No value key at all when nothing is reporting, rather than null — a null would
            // read as "the value is nothing", a different claim from "nobody is answering".
            if (state && state.state !== undefined) { entry.value = state.state; }
            entry.function    = info.aggregate;
            entry.members     = state ? state.members : info.stateMembers;
            entry.live        = state ? state.live : 0;
            entry.last_change = (state && msToIso) ? msToIso(state.last_change) : null;
        }
        // Neither: readable, but nobody has picked a default and none was asked for. members
        // says it is worth asking; the tool description says how.
    }

    // Whose value it is — only for latest, min and max, where one member owns it — and who
    // moved it last. Absent rather than null where neither question has an answer.
    var prov = computed || state;
    if (readable && prov) {
        if (prov.source)          { entry.source = prov.source; }
        if (prov.last_changed_by) { entry.last_changed_by = prov.last_changed_by; }
    }

    if (info.notes) { entry.notes = info.notes; }
    if (Array.isArray(info.tags) && info.tags.length) { entry.tags = info.tags; }
    return entry;
}

// `expandHaType` is injected so this stays free of the catalog: core/eventhandler.js passes
// mcp-tools' expandHaTypeFilter, which is what makes ha_type="light" match a dimmer group here
// exactly as it matches a dimmer device in get_all_states.
// Why a requested function does not apply to these members, or null when it does. Asking a
// temperature group whether all its members are true is not a question that answers false —
// it is a question that does not apply, and saying so is the only useful reply. A function
// that fits *some* members is a different matter: that answers, and reports how many.
function functionMismatch(info, fn, kinds, suitable) {
    if (!fn) { return null; }
    if (kinds.reporting === 0) {
        return {
            error   : 'Group "' + info.name + '" has no member reporting a value right now',
            group_id: info.id,
            members : info.stateMembers
        };
    }
    if ((suitable || []).indexOf(fn) >= 0) { return null; }

    const holds = kinds.numbers && kinds.booleans
        ? kinds.numbers + ' report numbers and ' + kinds.booleans + ' report true/false'
        : kinds.numbers ? 'its ' + kinds.numbers + ' reporting members hold numbers'
                        : 'its ' + kinds.booleans + ' reporting members hold true/false';
    return {
        error   : '"' + fn + '" does not apply to group "' + info.name + '"'
                  + (info.haType ? ' (ha_type ' + info.haType + ')' : '') + ': ' + holds + '.',
        group_id: info.id,
        suitable_functions: suitable || []
    };
}

function matchesFilters(info, args, expandHaType) {
    if (args.group_id && info.id !== args.group_id) { return false; }
    if (args.group_name) {
        const q = String(args.group_name).toLowerCase();
        if (!String(info.name || '').toLowerCase().includes(q)) { return false; }
    }
    if (args.ha_type) {
        const wanted = expandHaType ? expandHaType(args.ha_type)
                                    : new Set([String(args.ha_type).toLowerCase()]);
        if (!wanted.has(String(info.haType || '').toLowerCase())) { return false; }
    }
    if (args.tag) {
        const wanted = String(args.tag).toLowerCase();
        if (!(info.tags || []).some(t => String(t).toLowerCase() === wanted)) { return false; }
    }
    return true;
}

// Find one group by exact id or partial name. Returns { group } or { error } — never throws,
// and an error always carries the alternatives, the way get_state answers with available_items
// rather than leaving the caller to guess.
function resolveGroup(groups, args) {
    const listing = groups.map(g => ({ group_id: g.id, name: g.name }));

    if (args.group_id) {
        const hit = groups.find(g => g.id === args.group_id);
        if (hit) { return { group: hit }; }
        return { error: { error: 'No group with id "' + args.group_id + '"', available_groups: listing } };
    }

    if (args.group_name) {
        const q = String(args.group_name).toLowerCase();
        const hits = groups.filter(g => String(g.name || '').toLowerCase().includes(q));
        if (hits.length === 1) { return { group: hits[0] }; }
        if (hits.length === 0) {
            return { error: { error: 'No group matching "' + args.group_name + '"', available_groups: listing } };
        }
        // Several matches is not a coin toss: commanding the wrong group is not recoverable
        // by reading the answer, so say which ones and let the caller pick.
        return { error: {
            error   : 'Several groups match "' + args.group_name + '" — use group_id to pick one',
            matches : hits.map(g => ({ group_id: g.id, name: g.name }))
        } };
    }

    return { error: { error: 'Provide group_id or group_name', available_groups: listing } };
}

// Can this group be commanded at all? Returns null when it can, or the refusal to send back.
function commandRefusal(group, groups) {
    if (group.commandMembers > 0) { return null; }
    return {
        error       : 'Group "' + group.name + '" has no members that accept commands — it only reports.',
        group_id    : group.id,
        controllable_groups: groups.filter(g => g.commandMembers > 0).map(g => ({ group_id: g.id, name: g.name }))
    };
}

module.exports = { groupEntry, matchesFilters, resolveGroup, commandRefusal, functionMismatch };

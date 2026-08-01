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
            // A function asked for on this call. No last_change: that is tracked for the
            // configured function only, and reporting the wrong one would be worse than none.
            if (computed.value !== undefined) { entry.value = computed.value; }
            entry.function = computed.fn;
            entry.live     = computed.live;
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

    if (info.notes) { entry.notes = info.notes; }
    if (Array.isArray(info.tags) && info.tags.length) { entry.tags = info.tags; }
    return entry;
}

// `expandHaType` is injected so this stays free of the catalog: core/eventhandler.js passes
// mcp-tools' expandHaTypeFilter, which is what makes ha_type="light" match a dimmer group here
// exactly as it matches a dimmer device in get_all_states.
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

module.exports = { groupEntry, matchesFilters, resolveGroup, commandRefusal };

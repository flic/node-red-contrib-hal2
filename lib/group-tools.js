'use strict';
// Shaping and lookup for the get_groups / control_group MCP tools.
//
// Pure, so the part with judgement in it is testable without a running Node-RED: what a group
// entry says about itself, and how a group is found from a name or an id. The dispatchers in
// core/eventhandler.js supply the registry and the live state and do the talking.

// One group as the tools report it. `info` is an entry from node.getGroups(); `state` is the
// record from node.getGroupState(), absent for a group that carries no value.
//
// The distinction the whole design rests on: `readable` and `controllable` are independent.
// A sensor group has a value and takes no commands; a scene group is the reverse. Reading uses
// the state-capable members, commanding the command-capable ones, and they are different sets.
function groupEntry(info, state, msToIso) {
    const readable = !!info.aggregate;
    const entry = {
        group_id     : info.id,
        name         : info.name,
        readable     : readable,
        controllable : info.commandMembers > 0
    };
    if (info.haType) { entry.ha_type = info.haType; }

    if (readable) {
        // No value key at all when nothing is reporting, rather than null — a null would read
        // as "the value is nothing", which is a different claim from "nobody is answering".
        if (state && state.state !== undefined) { entry.value = state.state; }
        entry.function    = info.aggregate;
        entry.members     = state ? state.members : info.stateMembers;
        entry.live        = state ? state.live : 0;
        entry.last_change = (state && msToIso) ? msToIso(state.last_change) : null;
    }

    if (info.notes) { entry.notes = info.notes; }
    if (Array.isArray(info.tags) && info.tags.length) { entry.tags = info.tags; }
    return entry;
}

function matchesFilters(info, args) {
    if (args.group_name) {
        const q = String(args.group_name).toLowerCase();
        if (!String(info.name || '').toLowerCase().includes(q)) { return false; }
    }
    if (args.ha_type) {
        if (String(info.haType || '').toLowerCase() !== String(args.ha_type).toLowerCase()) { return false; }
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

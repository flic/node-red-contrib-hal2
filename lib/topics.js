'use strict';
// Topic / message-field filter matching for hal2Thing. Pure MQTT wildcard matching, topic
// prefix resolution, per-field matchers and the and/or filter runner — extracted so routing
// logic can be unit-tested. The message-property getter is injected so the module has no
// Node-RED dependency.

function matchTopic(ts, t) {
    if (ts == '#') {
        return true;
    }
    /* The following allows shared subscriptions (as in MQTT v5)
       http://docs.oasis-open.org/mqtt/mqtt/v5.0/cs02/mqtt-v5.0-cs02.html#_Toc514345522
       4.8.2 describes shares like $share/{ShareName}/{filter}. */
    else if (ts.startsWith('$share')) {
        ts = ts.replace(/^\$share\/[^#+/]+\/(.*)/g, '$1');
    }
    var re = new RegExp('^' + ts.replace(/([\[\]\?\(\)\\\\$\^\*\.|])/g, '\\$1').replace(/\+/g, '[^/]+').replace(/\/#$/, '(\/.*)?') + '$');
    return re.test(t);
}

function fixTopic(topicstring, configuredTopic) {
    var topic = topicstring;
    if (topic.startsWith('.')) {
        topic = topic.replace('.', configuredTopic);
    }
    if (topic.startsWith('/')) {
        topic = configuredTopic + topic;
    }
    return topic;
}

// a = msg value, b = filter pattern
var TOPIC_MATCHERS = {
    'str':        function (a, b) { return a === b; },
    're':         function (a, b) { return (new RegExp(b)).test(a + ''); },
    'mqtt':       function (a, b) { return matchTopic(b, a); },
    'StrStart':   function (a, b) { return (a + '').startsWith(b); },
    'StrEnd':     function (a, b) { return (a + '').endsWith(b); },
    'StrContain': function (a, b) { return (a + '').includes(b); }
};

// Run a list of field filters against a message. `getProp(msg, field)` reads the message
// property (inject RED.util.getMessageProperty). mode 'or' matches if any filter passes,
// otherwise all must pass. Empty/absent filters always match.
function applyFilters(msg, filters, mode, topicPrefix, getProp) {
    if (!filters || filters.length === 0) return true;
    for (var i = 0; i < filters.length; i++) {
        var f = filters[i];
        var val = getProp(msg, f.field);
        var filterVal = f.value;
        if (f.field === 'topic' && f.matchType === 'str' && topicPrefix) {
            filterVal = fixTopic(filterVal, topicPrefix);
        }
        var fn = TOPIC_MATCHERS[f.matchType];
        var matched = fn ? fn(val, filterVal) : false;
        if (mode === 'or') { if (matched) return true; }
        else               { if (!matched) return false; }
    }
    return mode !== 'or';
}

module.exports = { matchTopic, fixTopic, TOPIC_MATCHERS, applyFilters };

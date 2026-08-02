module.exports = function(RED) {
    const { createBayes } = require('../lib/bayes');
    const scale = require('../resources/bayes-scale');
    const bayesTime = require('../resources/bayes-time');
    const bayesLabel = require('../resources/bayes-label');

    function hal2Bayes(config) {
        RED.nodes.createNode(this, config);
        this.eventHandler = RED.nodes.getNode(config.eventHandler);
        var node = this;

        const num = (v, dflt) => {
            if (v === '' || v === null || v === undefined) { return dflt; }
            const n = Number(v);
            return isNaN(n) ? dflt : n;
        };
        const sec = (v, dflt) => num(v, dflt) * 1000;

        // ---- normalize config (editor stores strings, times in seconds) ----
        const prior = Math.min(0.999, Math.max(0.001, num(config.prior, 0.2)));
        const clamp = num(config.clamp, 6);
        const nodeHalfLifeMs = sec(config.halfLife, 1200);

        const cfg = {
            prior,
            pOn:        num(config.pOn, 0.85),
            pOff:       num(config.pOff, 0.30),
            clamp,
            halfLifeMs: nodeHalfLifeMs,
            latch:      config.latch === true,
            maxHoldMs:  num(config.maxHold, 0) * 3600e3,   // hours; 0/blank = never
            rules: (config.rules || []).map((r, idx) => {
                // Effective LR: advanced raw override, else the strength word; the
                // direction folds in as the reciprocal.
                let lr = num(r.lr, 0) > 0 ? num(r.lr, 0) : scale.strengthLr(r.strength);
                if (r.direction === 'false') { lr = 1 / lr; }
                // A scaled weight follows the measured value instead of being constant. The
                // value that scales it has to be unambiguous, so it is restricted to
                // single-step rules; the sign lives in the shares, so `direction` is not
                // applied. Shares are entered as percentages.
                let scaleSpec = null;
                if (r.strength === 'scaled' && r.scale) {
                    if ((r.steps || []).length !== 1) {
                        node.warn('A scaled weight needs a single-step rule — using a fixed strength instead');
                    } else {
                        scaleSpec = {
                            fromValue: num(r.scale.fromValue, 0), fromShare: num(r.scale.fromShare, 0) / 100,
                            toValue:   num(r.scale.toValue, 0),   toShare:   num(r.scale.toShare, 0) / 100
                        };
                    }
                }
                const halfLifeMs = num(r.halfLife, 0) > 0
                    ? sec(r.halfLife, 1200)
                    : scale.fadeSeconds(r.fade) * 1000;
                const steps = (r.steps || []).map((s, si) => {
                    const src = ['thing', 'group', 'flow', 'global', 'env', 'time'].indexOf(s.src) >= 0 ? s.src : 'thing';
                    let pattern = ['cycle', 'is', 'isOrBecomes', 'becomes'].indexOf(s.pattern) >= 0 ? s.pattern : 'is';
                    // Polled sources have no change event, so an edge on them could only be
                    // sampled on the tick and would be missed outright between two ticks. A
                    // group is not polled — it emits on the bus exactly like a thing — so it
                    // keeps every pattern.
                    const polled = src !== 'thing' && src !== 'group';
                    if (polled && (pattern === 'cycle' || pattern === 'becomes')) {
                        node.warn('A ' + src + ' step cannot detect changes — treating it as a condition');
                        pattern = 'is';
                    }
                    // Nothing can drive a polled source at the head of a rule: there is no
                    // subscription to wake it and no previous step to be "soon" after, so
                    // 'isOrBecomes' there would never fire at all.
                    if (polled && si === 0 && pattern === 'isOrBecomes') { pattern = 'is'; }
                    // Waiting for the clock to cross into a window is never useful, so a time
                    // step is always a plain condition wherever it sits.
                    if (src === 'time') { pattern = 'is'; }
                    return {
                        src, thing: s.thing, item: s.item, group: s.group,
                        groupFunction: s.groupFunction || '', prop: s.prop,
                        start: s.start, end: s.end,
                        days: Array.isArray(s.days) ? s.days.map(Number) : undefined,
                        operator: s.operator, value: s.value, valueType: s.valueType || 'str',
                        pattern,
                        cycleMaxMs: sec(s.cycleMax, 180),
                        windowMs: sec(s.window, 120)
                    };
                }).filter(s => {
                    if (s.src === 'thing') { return s.thing && s.item; }
                    if (s.src === 'group') { return !!s.group; }
                    if (s.src === 'time')  { return bayesTime.parseHHMM(s.start) !== null &&
                                                    bayesTime.parseHHMM(s.end) !== null; }
                    return s.prop;
                });
                // Ids key the rule map and every step hit, so a missing one would collapse
                // every rule onto the same entry. Fall back to the position in the list.
                return { id: r.id || ('rule' + idx), lr, halfLifeMs, steps,
                         scale: scaleSpec && steps.length === 1 ? scaleSpec : null };
            }).filter(r => r.steps.length > 0)
        };

        // ---- rule labels ----
        // The snapshot names rules rather than showing ids, and only this layer can turn a
        // thing id into "Office Sensor". The phrasing itself lives in resources/bayes-label.js
        // so the editor can adopt the same wording later.
        function stepNames(step) {
            switch (step.src) {
                case 'group': {
                    // The registry, not the state record: a group with no default value has no
                    // record, and labelling it by its id helps nobody.
                    const groups = (node.eventHandler && typeof node.eventHandler.getGroups === 'function')
                        ? node.eventHandler.getGroups() : [];
                    const g = groups.find(x => x.id === step.group);
                    return { source: (g && g.name) || step.group };
                }
                case 'flow':   return { source: 'flow.' + step.prop };
                case 'global': return { source: 'global.' + step.prop };
                case 'env':    return { source: 'env.' + step.prop };
                case 'time':   return { window: bayesTime.describe(step) };
                default: {
                    const thing = RED.nodes.getNode(step.thing);
                    if (!thing || !thing.thingType || !Array.isArray(thing.thingType.items)) {
                        return { source: step.thing };
                    }
                    const item = thing.thingType.items.find(i => i.id === step.item);
                    return { source: thing.name + (item ? ' · ' + item.name : '') };
                }
            }
        }
        function labelRules() {
            for (const rule of cfg.rules) {
                rule.label = bayesLabel.describeRule(rule, rule.steps.map(stepNames));
            }
        }
        // Once now, in case this node is deployed on its own and everything it refers to is
        // already up, and again on flows:started when a full deploy has registered the things.
        labelRules();

        // Like hal2Event: a blank topic leaves msg.topic alone rather than inventing one.
        const topic          = config.topic || '';
        const withTopic      = (msg, suffix) => {
            if (topic !== '') { msg.topic = topic + (suffix || ''); }
            return msg;
        };
        const tickMs         = Math.max(5, num(config.tickInterval, 30)) * 1000;
        const snapshotOnTick = config.snapshotOnTick === true;
        // 'change' (default) emits output 1 only when the binary result flips;
        // 'evaluation' re-asserts the current state on every evaluation.
        const emitOn         = config.emitOn === 'evaluation' ? 'evaluation' : 'change';

        const est = createBayes(cfg);

        // ---- persistence (pattern: event.js contextStore usage) ----
        const nodeContext  = node.context();
        const contextStore = node.eventHandler ? node.eventHandler.contextStore : '';
        est.restore(nodeContext.get('bayes', contextStore), Date.now());
        function persist() { nodeContext.set('bayes', est.serialize(), contextStore); }

        // Thing items arrive by subscription; flow/global/env are read on demand, which is
        // why they are restricted to condition steps (see the pattern guard above).
        function resolveState(step) {
            switch (step.src) {
                // Undefined when no live member is reporting, or when the step's function does
                // not fit the members — both of which the estimator treats as "no evidence".
                case 'group': {
                    if (!node.eventHandler) { return undefined; }
                    // The step's own function, or the group's default. Either way a fresh read:
                    // the step is re-read on every wake-up regardless.
                    if (step.groupFunction && typeof node.eventHandler.readGroup === 'function') {
                        const read = node.eventHandler.readGroup(step.group, step.groupFunction);
                        return read ? read.value : undefined;
                    }
                    const rec = typeof node.eventHandler.getGroupState === 'function'
                        ? node.eventHandler.getGroupState(step.group) : null;
                    return rec ? rec.state : undefined;
                }
                case 'flow':   return node.context().flow.get(step.prop);
                case 'global': return node.context().global.get(step.prop);
                case 'env':    return process.env[step.prop];
                // A boolean, so the existing is-true / is-false operator gives inside/outside.
                case 'time':   return bayesTime.inWindow(new Date(), step);
                default: {
                    const thing = RED.nodes.getNode(step.thing);
                    return thing && thing.state ? thing.state[step.item] : undefined;
                }
            }
        }

        function showStatus(result) {
            node.status({
                fill: result.binary ? 'green' : 'grey', shape: result.held ? 'ring' : 'dot',
                text: (result.binary ? 'on' : 'off') + ' (' + result.p.toFixed(2) + ')' +
                      (result.held ? ' held' : '')
            });
        }

        function snapshotPayload(result) {
            return {
                p: Number(result.p.toFixed(4)), logOdds: Number(result.logOdds.toFixed(4)),
                share: result.share, binary: result.binary, held: result.held,
                rules: result.rules
            };
        }

        // Evaluate + emit + persist. `emitSnapshot` controls output 2.
        function run(emitSnapshot) {
            const result = est.evaluate(resolveState, Date.now());
            persist();
            showStatus(result);
            const change = (result.changed || emitOn === 'evaluation')
                ? withTopic({ payload: result.binary, probability: Number(result.p.toFixed(4)),
                              changed: result.changed })
                : null;
            const snapshot = (emitSnapshot || result.changed)
                ? withTopic({ payload: snapshotPayload(result) }, '/snapshot')
                : null;
            if (change || snapshot) { node.send([change, snapshot]); }
            return result;
        }

        // ---- sensor subscriptions: one listener per distinct thing id ----
        // Map thing id → item id → [{ ruleId, stepIndex }].
        const byThing = {};
        cfg.rules.forEach(rule => {
            rule.steps.forEach((step, i) => {
                // Polled sources are read, not subscribed. A group emits on the bus under its
                // own id and carries one value, so it subscribes exactly like a thing whose
                // item id happens to be the group id.
                if (step.src !== 'thing' && step.src !== 'group') { return; }
                const id   = step.src === 'group' ? step.group : step.thing;
                const item = step.src === 'group' ? step.group : step.item;
                const t = (byThing[id] = byThing[id] || {});
                (t[item] = t[item] || []).push({ ruleId: rule.id, stepIndex: i });
            });
        });
        const subscriptions = [];
        for (const thingId of Object.keys(byThing)) {
            const items = byThing[thingId];
            const listener = function(thingtypeid, thingid, itemid, event) {
                const hits = items[itemid];
                if (!hits) { return; }
                est.handleEvent(hits, event.state, Date.now(), resolveState);
                run(true);
            };
            node.eventHandler && node.eventHandler.subscribe('update', thingId, listener);
            subscriptions.push({ thingId, listener });
        }

        // ---- decay/expiry tick ----
        node.tickId = setInterval(function() {
            est.tick(Date.now(), resolveState);
            run(snapshotOnTick);
        }, tickMs);

        // Initial evaluation once all nodes are registered (things resolvable) — which is also
        // the first moment the labels can name anything.
        const onStarted = function() { labelRules(); run(false); };
        RED.events.on('flows:started', onStarted);

        // ---- msg input: escape hatches ----
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };
            if (msg.topic === 'reset') {
                est.reset();
            } else if (msg.topic === 'evidence') {
                const p = (msg.payload && typeof msg.payload === 'object') ? msg.payload : { lr: msg.payload };
                if (!est.inject(p.lr, p.halfLife ? Number(p.halfLife) * 1000 : null, Date.now())) {
                    return done(new Error('evidence needs payload.lr > 0 (≠ 1)'));
                }
            } else {
                // anything else → emit a snapshot on output 2
                const result = est.evaluate(resolveState, Date.now());
                persist();
                showStatus(result);
                send([null, withTopic({ payload: snapshotPayload(result) }, '/snapshot')]);
                return done();
            }
            run(true);
            done();
        });

        node.on('close', function() {
            for (const s of subscriptions) {
                node.eventHandler && node.eventHandler.unsubscribe('update', s.thingId, s.listener);
            }
            clearInterval(node.tickId);
            RED.events.removeListener('flows:started', onStarted);
        });
    }
    RED.nodes.registerType("hal2Bayes", hal2Bayes);
};

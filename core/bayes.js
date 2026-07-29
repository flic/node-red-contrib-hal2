module.exports = function(RED) {
    const { createBayes } = require('../lib/bayes');
    const scale = require('../resources/bayes-scale');
    const bayesTime = require('../resources/bayes-time');

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
                const halfLifeMs = num(r.halfLife, 0) > 0
                    ? sec(r.halfLife, 1200)
                    : scale.fadeSeconds(r.fade) * 1000;
                const steps = (r.steps || []).map((s, si) => {
                    const src = ['thing', 'flow', 'global', 'env', 'time'].indexOf(s.src) >= 0 ? s.src : 'thing';
                    let pattern = ['cycle', 'is', 'isOrBecomes', 'becomes'].indexOf(s.pattern) >= 0 ? s.pattern : 'is';
                    // Polled sources have no change event, so an edge on them could only be
                    // sampled on the tick and would be missed outright between two ticks.
                    if (src !== 'thing' && (pattern === 'cycle' || pattern === 'becomes')) {
                        node.warn('A ' + src + ' step cannot detect changes — treating it as a condition');
                        pattern = 'is';
                    }
                    // Nothing can drive a polled source at the head of a rule: there is no
                    // subscription to wake it and no previous step to be "soon" after, so
                    // 'isOrBecomes' there would never fire at all.
                    if (src !== 'thing' && si === 0 && pattern === 'isOrBecomes') { pattern = 'is'; }
                    return {
                        src, thing: s.thing, item: s.item, prop: s.prop,
                        start: s.start, end: s.end,
                        days: Array.isArray(s.days) ? s.days.map(Number) : undefined,
                        operator: s.operator, value: s.value, valueType: s.valueType || 'str',
                        pattern,
                        cycleMaxMs: sec(s.cycleMax, 180),
                        windowMs: sec(s.window, 120)
                    };
                }).filter(s => {
                    if (s.src === 'thing') { return s.thing && s.item; }
                    if (s.src === 'time')  { return bayesTime.parseHHMM(s.start) !== null &&
                                                    bayesTime.parseHHMM(s.end) !== null; }
                    return s.prop;
                });
                // Pre-'is' configs expressed the continuous case as a lone 'becomes'
                // step; that is exactly a level check, so carry it over unchanged.
                if (steps.length === 1 && steps[0].pattern === 'becomes') { steps[0].pattern = 'is'; }
                // Ids key the rule map and every step hit, so a missing one would collapse
                // every rule onto the same entry. Fall back to the position in the list.
                return { id: r.id || ('rule' + idx), lr, halfLifeMs, steps };
            }).filter(r => r.steps.length > 0)
        };

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
        est.restore(nodeContext.get('bayes', contextStore));
        function persist() { nodeContext.set('bayes', est.serialize(), contextStore); }

        // Thing items arrive by subscription; flow/global/env are read on demand, which is
        // why they are restricted to condition steps (see the pattern guard above).
        function resolveState(step) {
            switch (step.src) {
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
                binary: result.binary, held: result.held,
                activeRules: result.activeRules, terms: result.terms, fsm: result.fsm
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
                if (step.src !== 'thing') { return; }   // polled sources are read, not subscribed
                const t = (byThing[step.thing] = byThing[step.thing] || {});
                (t[step.item] = t[step.item] || []).push({ ruleId: rule.id, stepIndex: i });
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

        // Initial evaluation once all nodes are registered (things resolvable).
        const onStarted = function() { run(false); };
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

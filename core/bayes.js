module.exports = function(RED) {
    const { createBayes } = require('../lib/bayes');

    function hal2Bayes(config) {
        RED.nodes.createNode(this, config);
        this.eventHandler = RED.nodes.getNode(config.eventHandler);
        var node = this;

        const num = (v, dflt) => { const n = Number(v); return isNaN(n) ? dflt : n; };
        const sec = (v, dflt) => num(v, dflt) * 1000;

        // ---- normalize config (editor stores strings, times in seconds) ----
        const prior = Math.min(0.999, Math.max(0.001, num(config.prior, 0.2)));
        const cfg = {
            prior,
            pOn:               num(config.pOn, 0.85),
            pOff:              num(config.pOff, 0.30),
            clamp:             num(config.clamp, 6),
            halfLifeMs:        sec(config.halfLife, 1200),
            candidateRow:      config.candidateRow || '',
            candidateWindowMs: sec(config.candidateWindow, 300),
            observations: (config.observations || []).map(r => ({
                id: r.id, name: r.name || r.id, thing: r.thing, item: r.item,
                type: r.type === 'state' ? 'state' : 'event',
                operator: r.operator, value: r.value, valueType: r.valueType || 'str',
                lr: num(r.lr, 1),
                halfLifeMs: r.halfLife !== '' && r.halfLife !== undefined ? sec(r.halfLife, 1200) : null,
                onlyAsCandidate: r.onlyAsCandidate === true
            })),
            composites: (config.composites || []).map(c => ({
                id: c.id, name: c.name || c.id,
                armRow: c.armRow, armPattern: c.armPattern === 'edge' ? 'edge' : 'cycle',
                cycleMaxMs: sec(c.cycleMax, 180),
                confirmRow: c.confirmRow, confirmWindowMs: sec(c.confirmWindow, 120),
                confirmDuringArm: c.confirmDuringArm !== false,
                lr: num(c.lr, 1),
                onlyAsCandidate: c.onlyAsCandidate === true
            }))
        };
        const topic          = config.topic || ('bayes/' + (config.name || node.id));
        const tickMs         = Math.max(5, num(config.tickInterval, 30)) * 1000;
        const snapshotOnTick = config.snapshotOnTick === true;
        const outThing       = config.outThing || '';
        const outItem        = config.outItem || '';
        const outProbItem    = config.outProbItem || '';

        // Drop composites whose row references no longer exist (defensive; editor validates too).
        const rowIds = new Set(cfg.observations.map(r => r.id));
        cfg.composites = cfg.composites.filter(c => {
            const ok = rowIds.has(c.armRow) && rowIds.has(c.confirmRow);
            if (!ok) { node.warn('Sequence "' + c.name + '" references a removed observation row — disabled'); }
            return ok;
        });

        if (cfg.candidateRow && !rowIds.has(cfg.candidateRow)) {
            node.warn('Candidate trigger row no longer exists — candidacy degrades to "output off" only');
            cfg.candidateRow = '';
        }

        // Feedback-loop guard: never write the estimate onto one of its own inputs.
        let writeBack = outThing !== '' && outItem !== '';
        if (writeBack && cfg.observations.some(r => r.thing === outThing && (r.item === outItem || r.item === outProbItem))) {
            node.warn('Output item is also an observation source — write-back disabled to avoid a feedback loop');
            writeBack = false;
        }

        const est = createBayes(cfg);

        // ---- persistence (pattern: event.js contextStore usage) ----
        const nodeContext  = node.context();
        const contextStore = node.eventHandler ? node.eventHandler.contextStore : '';
        est.restore(nodeContext.get('bayes', contextStore));
        function persist() { nodeContext.set('bayes', est.serialize(), contextStore); }

        function resolveState(row) {
            const thing = RED.nodes.getNode(row.thing);
            return thing && thing.state ? thing.state[row.item] : undefined;
        }

        function showStatus(result) {
            node.status({
                fill: result.binary ? 'green' : 'grey', shape: 'dot',
                text: (result.binary ? 'on' : 'off') + ' (' + result.p.toFixed(2) + ')'
            });
        }

        let lastWritten = {};
        function writeEstimate(result) {
            if (!writeBack) { return; }
            const out = RED.nodes.getNode(outThing);
            if (!out || typeof out.updateState !== 'function') { return; }
            if (lastWritten.binary !== result.binary) {
                out.updateState({ topic: '' }, outItem, result.binary, 'ingress');
                lastWritten.binary = result.binary;
            }
            if (outProbItem) {
                const p = Number(result.p.toFixed(2));
                if (lastWritten.p !== p) {
                    out.updateState({ topic: '' }, outProbItem, p, 'ingress');
                    lastWritten.p = p;
                }
            }
        }

        // Evaluate + emit + persist. `emitSnapshot` controls output 2.
        function run(emitSnapshot) {
            const result = est.evaluate(resolveState, Date.now());
            persist();
            showStatus(result);
            writeEstimate(result);
            const change = result.changed
                ? { topic: topic, payload: result.binary, probability: Number(result.p.toFixed(4)) }
                : null;
            const snapshot = (emitSnapshot || result.changed)
                ? { topic: topic + '/snapshot', payload: {
                        p: Number(result.p.toFixed(4)), logOdds: Number(result.logOdds.toFixed(4)),
                        binary: result.binary, activeStateRows: result.activeStateRows,
                        terms: result.terms, fsm: result.fsm } }
                : null;
            if (change || snapshot) { node.send([change, snapshot]); }
            return result;
        }

        // ---- sensor subscriptions: one listener per distinct thing id ----
        const byThing = {};
        for (const row of cfg.observations) {
            if (!row.thing || !row.item) { continue; }
            (byThing[row.thing] = byThing[row.thing] || []).push(row);
        }
        const subscriptions = [];
        for (const thingId of Object.keys(byThing)) {
            const rows = byThing[thingId];
            const listener = function(thingtypeid, thingid, itemid, event) {
                const hit = rows.filter(r => r.item === itemid).map(r => r.id);
                if (!hit.length) { return; }
                est.handleEvent(hit, event.state, Date.now());
                run(true);
            };
            node.eventHandler && node.eventHandler.subscribe('update', thingId, listener);
            subscriptions.push({ thingId, listener });
        }

        // ---- decay/expiry tick ----
        node.tickId = setInterval(function() {
            est.tick(Date.now());
            run(snapshotOnTick);
        }, tickMs);

        // Initial evaluation once all nodes are registered (things resolvable).
        const onStarted = function() { run(false); };
        RED.events.on('flows:started', onStarted);

        // ---- msg input: escape hatches ----
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };
            const now = Date.now();
            if (msg.topic === 'reset') {
                est.reset();
            } else if (msg.topic === 'evidence') {
                const p = (msg.payload && typeof msg.payload === 'object') ? msg.payload : { lr: msg.payload };
                if (!est.inject(p.lr, p.halfLife ? Number(p.halfLife) * 1000 : null, now)) {
                    return done(new Error('evidence needs payload.lr > 0 (≠ 1)'));
                }
            } else if (msg.topic === 'set') {
                est.force(msg.payload === true || msg.payload === 'true');
            } else {
                // anything else → emit a snapshot on output 2
                const result = est.evaluate(resolveState, now);
                send([null, { topic: topic + '/snapshot', payload: {
                    p: Number(result.p.toFixed(4)), logOdds: Number(result.logOdds.toFixed(4)),
                    binary: result.binary, activeStateRows: result.activeStateRows,
                    terms: result.terms, fsm: result.fsm } }]);
                persist();
                showStatus(result);
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

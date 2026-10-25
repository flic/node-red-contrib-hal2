// Runtime half of the 3.x → 4.0 conversion: nothing but the registration. The work happens in
// the editor (plugins/convert.html), whose own requests carry the signed-in user's session, so
// the conversion runs with exactly that user's permissions. Removed in 5.0.0, with
// core/legacy-mcpserver.js.
module.exports = function (RED) {
    RED.plugins.registerPlugin('hal2-convert-4', { type: 'hal2-convert-4' });
};

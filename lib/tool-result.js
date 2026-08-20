'use strict';
// The envelope every tool call answers in, and the one shape hal2Api reads: `ok` decides,
// then `content` (an MCP content array, passed through verbatim) or `text` (a JSON string,
// or plain text for the few tools that produce it), and `code`/`message` on failure.
//
// Defined once because three nodes produce it — the Event handler, a standalone MCP server,
// and anything that grows a callTool later — and a fourth hand-typed copy is how two files
// drift until one of them answers a shape the caller does not read.

const toolOk  = text    => ({ ok: true, text: text });
const respond = result  => ({ ok: true, content: result.content });
const rpcErr  = (code, message) => ({ ok: false, code: code, message: message });

// JSON-RPC's "method not found", which is what an unknown tool name is. Both dispatchers
// answer with it, so a caller cannot tell from the reply which registry it missed.
const unknownTool = name => rpcErr(-32601, 'Unknown tool: ' + name);

module.exports = { toolOk, respond, rpcErr, unknownTool };

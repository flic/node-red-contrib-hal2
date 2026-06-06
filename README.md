# node-red-contrib-hal2 [![npm version](https://badge.fury.io/js/node-red-contrib-hal2.svg)](https://badge.fury.io/js/node-red-contrib-hal2)
A set of nodes to help with basic home automation logic.

**Note:** Even more new examples added

## Install
```bash
cd ~/.node-red
npm install node-red-contrib-hal2
```

## What is it?
**node-red-contrib-hal2** is a set of Node-RED nodes useful for creating home automation flows. The basic component is the Thing node, a virtual representation of a (usually) physical IoT device. This can then be used to trigger events, route traffic based on rules and more.

![Example Items](https://user-images.githubusercontent.com/400673/168665494-db5c244e-6225-4ae0-beed-fab3131e1b0a.png)

1. Store a device state in a **Thing node**
2. Fire an event when the value changes using an **Event node**
3. One or more rules will compare the value and that of other Items in a **Gate node**
4. Output the value to another flow with a **Value node**
5. Send device commands to multiple Things using an **Action node**
6. Log changes using the **Log node**

![Example automation flows](https://user-images.githubusercontent.com/400673/168665539-3984681b-5059-4ed6-b350-683a431841d8.png)

**node-red-contrib-hal2** uses the Node-RED built-in context store to save device state. If you'd like for state to survive a Node-RED restart you'll need to save context data to the file system (default is memory-only). You can choose to save all Node-RED context data to disk or to create a separate context store just for your IoT devices. I would recommend a separate context store for this use. **node-red-contrib-hal2** lets you select which context store to use per thing type. Please take a look at the Node-RED documentation for [instructions on how to configure the context stores](https://nodered.org/docs/user-guide/context#context-stores).

<img width="654" alt="Screenshot 2023-03-19 11.16.03" src="https://user-images.githubusercontent.com/400673/226168861-5af8042f-b8b3-4138-8996-ddb3d37f9d44.png">

Take a look at the example flows and Thing definitions in the https://github.com/flic/node-red-contrib-hal2/tree/main/examples folder for more information.

![Example logging](https://user-images.githubusercontent.com/400673/168665807-aa3aba8f-8b06-4292-bcad-7374e508f59a.png)

## AI & external control

Beyond local automation, hal2 can expose your devices to AI assistants and external systems. The **Event handler** can run a built-in [MCP](https://modelcontextprotocol.io) server, you can define your own AI tools as flows, and the **hal2Api** node offers a plain JSON gateway. All three share one tool catalog, so there is a single source of truth.

### MCP server

The **hal2EventHandler** config node can run an embedded **MCP (Model Context Protocol) server**, letting an AI assistant such as Claude read device state and control your home in natural language. Enable it on the *MCP* tab of the Event handler. The server is OAuth-protected (via [PocketID](https://pocket-id.org)), carries a per-location identifier (e.g. "Home" / "Cabin") so an assistant connected to several homes can tell them apart, and supports a local debug token for development. Experimental - only tested with Claude.AI and PocketID.

It ships with a catalog of built-in tools:

- **Read** — `get_all_states`, `get_state`, `get_history`, `get_scenes`, `get_presence`, `get_alerts`
- **Control** — `set_light`, `control_device`, `control_fan`, `control_cover`, `control_spa`, `control_climate`, `activate_scene`
- **Analyse** — `analyze_patterns`
- **Admin** (opt-in) — `get_flow`, `deploy_flow`

Tools are exposed only when matching hardware is configured at that location — a server with no covers won't advertise `control_cover`. Things and Items can carry free-text **notes** and **tags**, and devices report derived **categories** (light, fan, cover, climate, spa, scene), all of which help the assistant pick the right device. Full parameters and examples are in **[docs/API.md](docs/API.md)**.

### Custom MCP tools (hal2MCPIn / hal2MCPOut)

You can define your own MCP tools as Node-RED flows: a **hal2MCPIn** node registers a tool and fires a message when the assistant calls it, and a **hal2MCPOut** node returns the result. Responses can be text or image/media content, so a tool can return e.g. a camera snapshot. For a fully standalone setup there is also a **hal2MCPServer** node. See `examples/jellyfin-mcp.json` for a worked example.

### JSON API (hal2Api)

The **hal2Api** node turns the same tool catalog into a simple JSON request/response gateway, so external components can query device state and control devices without speaking MCP. Wire it behind an `http in`, MQTT, or any node that produces a JSON message:

```json
// in:  msg.payload
{ "tool": "get_state", "args": { "thing_name": "kitchen" } }

// out: msg.payload
{ "ok": true, "result": { "thing_id": "…", "items": [ … ] } }
```

The full list of tools is auto-generated in **[docs/API.md](docs/API.md)** (`npm run docs:api`). Admin tools (`get_flow`, `deploy_flow`) are only exposed when *Allow admin tools* is enabled on the node. See `examples/json-api.json` for a ready-made HTTP endpoint flow.

## History & pattern analysis

Items can opt in to **history logging**: when enabled on the Event handler (and per Item), value changes are stored in a local **SQLite** database with a configurable retention period. History requires the optional `better-sqlite3` package — install it with `npm install better-sqlite3` in your Node-RED user directory. Without it, history simply stays off and nothing breaks.

History powers two tools:

- **`get_history`** — fetch logged values for an Item over a flexible time window: a rolling `hours` count, an explicit `from`/`to` range, or a point-in-time `at` lookup ("what was it at 08:00?"), with `offset`/`limit` paging.
- **`analyze_patterns`** — scans the history to surface recurring routines, e.g. *"Living Room Light turns on around 07:30, 85% consistent"*, so you can spot automations worth creating.

## Other recent additions

- **Multi-filter on Things and Items** — combine several match conditions on any message field (exact string, regex, MQTT wildcard, starts/ends/contains) with AND/OR logic, replacing the old single-topic filter.
- **Centralised ingress/egress functions** — define message-transform functions once on the Event handler and reuse them across thing types instead of copying them per type.
- **Notes & tags** on Things and Items, plus automatically derived device **categories** — handy for organising devices and for disambiguation by the MCP and JSON API tools.


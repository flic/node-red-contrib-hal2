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

## Groups

Control several Things at once with **Groups**. A group's identity — name, HAType, and a rate limit — lives in a registry on the **Event handler** (*Groups* tab), while membership is set per Item on each Thing (the *Groups* section of the Thing editor: pick an Item, pick a group). A group can then be used as a target in an **Action** node (broadcast a command to every member, paced by the rate limit) or as a source in an **Event** node (fire when any member changes, carrying which Thing/Item actually changed). Each group in the registry has an **info button** that lists its current members.

A group has a **HAType** that sets the command contract for its members. Compatibility is directional: `Switch` and `Light` are interchangeable (both are boolean On/Off), and a `Dimmer` item may also join an On/Off group (turning a dimmer off is well-defined) — but a switch or light cannot join a `Dimmer` group, since an On/Off device can't honour a 0–100 level. The Thing editor only offers compatible groups for each Item, and the Event handler only offers HATypes its existing members can all honour. For genuinely mixed groups there is an **Other** type that accepts any Item.

Groups replace the old standalone `hal2Group` node. Existing flows keep working — the Event handler folds legacy group nodes in automatically — but you should run `node tools/migrate-groups.js <flows.json>` to make the move permanent and then remove the deprecated nodes. The migration preserves group ids, so existing Action/Event references keep resolving untouched.

## AI & external control

Beyond local automation, hal2 can expose your devices to AI assistants and external systems. The **Event handler** can run a built-in [MCP](https://modelcontextprotocol.io) server, you can define your own AI tools as flows, and the **hal2Api** node offers a plain JSON gateway. All three share one tool catalog, so there is a single source of truth.

### MCP server

The **hal2EventHandler** config node can run an embedded **MCP (Model Context Protocol) server**, letting an AI assistant such as Claude read device state and control your home in natural language. Enable it on the *MCP* tab of the Event handler. The server is **OAuth 2.0 protected and works with any standard OIDC identity provider** (its real endpoints are auto-discovered — see [Authentication & reverse proxy](#authentication--reverse-proxy)), carries a per-location identifier (e.g. "Home" / "Cabin") so an assistant connected to several homes can tell them apart, and supports a local debug token for development. Experimental.

It ships with a catalog of built-in tools:

- **Read** — `get_all_states`, `get_state`, `get_history`, `get_scenes`, `get_presence`, `get_alerts`
- **Control** — `set_light`, `control_device`, `control_fan`, `control_cover`, `control_spa`, `control_climate`, `activate_scene`
- **Analyse** — `analyze_patterns`
- **Admin** (opt-in) — `get_flow`, `deploy_flow`

Tools are exposed only when matching hardware is configured at that location — a server with no covers won't advertise `control_cover`. Things and Items can carry free-text **notes** and **tags**, and devices report derived **categories** (light, fan, cover, climate, spa, scene), all of which help the assistant pick the right device. Full parameters and examples are in **[docs/API.md](docs/API.md)**.

### Access control

Two independent, optional gates. Each is a **claim** + **value** pair: an array claim must *contain* the value, a scalar claim must *equal* it, and an empty value leaves the gate open to any authenticated caller.

- **Admin-tools gate** (Event handler → *MCP* tab, `Required claim`/`Required value`): gates only the admin tools (`get_flow`, `deploy_flow`). Ordinary read/control tools stay available to any authenticated caller. Defaults to claim `groups`, value `admin`.
- **Standalone-server gate** (a `hal2MCPServer` node in *Standalone* mode, `Required claim`/`Required value`): gates a whole standalone MCP server. Callers who fail the check still connect (`initialize` succeeds) but see no tools, and any `tools/call` is refused. Defaults to empty — all authenticated users allowed.

Both denials come back as an MCP tool result with `isError: true` and a human-readable reason, so the calling model is told *why* instead of getting a generic "tool execution failed".

### Hostname filtering

Off by default. When **Only serve requests for this hostname** is enabled on the Event handler, its MCP routes only answer requests whose `Host` header matches the hostname in the *MCP server URL*. This lets several Event handlers share the *same* paths (e.g. `/mcp`) on one Node-RED instance, each answering only its own virtual host — useful when one backend fronts several homes on different hostnames. Standalone `hal2MCPServer` nodes inherit the setting from their Event handler. Leave it off for a single server, or when a reverse proxy rewrites the `Host` header.

### Authentication & reverse proxy

The MCP server implements the MCP OAuth flow itself: it advertises itself as a **protected resource**, proxies the **authorization-server metadata** to your identity provider (IdP), and hands the MCP client a fixed, pre-registered client via a small dynamic-client-registration shim. It does **not** run its own login — your IdP does.

**Routes to expose through your reverse proxy.** With the default (empty) *HTTP path prefix*, the Event handler registers these on the public *MCP server URL* — all must be reachable from the MCP client:

| Method & path | Purpose |
|---|---|
| `POST /mcp` | The JSON-RPC MCP endpoint (bearer-token protected) |
| `GET /.well-known/oauth-protected-resource` | Resource metadata (RFC 9728) — points the client at the auth server |
| `GET /.well-known/oauth-protected-resource/mcp` | Same metadata, path-inserted form some clients probe |
| `GET /.well-known/oauth-authorization-server` | Auth-server metadata (RFC 8414) — issuer is hal2, endpoints point at your IdP |
| `POST /oauth/register` | Dynamic client registration shim — returns your pre-registered client |

Each **standalone** `hal2MCPServer` node adds one more endpoint, `POST /mcp/<path>` (e.g. `/mcp/jellyfin`), sharing the same auth. Setting an *HTTP path prefix* shifts every route under it (`/prefix/mcp`, `/prefix/.well-known/…`), so update the proxy to match.

> **Allowlist these paths — don't blanket-proxy everything to Node-RED.** hal2's MCP routes live on Node-RED's shared HTTP server, alongside the flow editor, admin API and any other `http in` endpoints. A catch-all proxy would put *all* of those on the public hostname; hal2 forwards anything it doesn't own to Node-RED, so you can't know what else would be exposed. Route only the specific paths below.

Example with **[Caddy](https://caddyserver.com/)** via [caddy-docker-proxy](https://github.com/lucaslorentz/caddy-docker-proxy) labels (default prefix; drop the `/mcp/*` line if you run no standalone servers):

```yaml
labels:
  caddy_1: mcp.example.com
  caddy_1.reverse_proxy_0: /mcp "{{upstreams 1880}}"
  caddy_1.reverse_proxy_1: /mcp/* "{{upstreams 1880}}"
  caddy_1.reverse_proxy_2: /.well-known/oauth-protected-resource "{{upstreams 1880}}"
  caddy_1.reverse_proxy_3: /.well-known/oauth-protected-resource/mcp "{{upstreams 1880}}"
  caddy_1.reverse_proxy_4: /.well-known/oauth-authorization-server "{{upstreams 1880}}"
  caddy_1.reverse_proxy_5: /oauth/register "{{upstreams 1880}}"
```

`/mcp` (exact) and `/mcp/*` are deliberately **separate** matchers — in Caddy `/mcp/*` does *not* match the bare `/mcp`. To serve several MCP servers on different hostnames from one backend, give each its own `caddy_N` site block and enable [hostname filtering](#hostname-filtering).

**What hal2 expects of the identity provider:**

- An **OIDC provider with discovery** — hal2 reads `‹issuer›/.well-known/openid-configuration` and uses the advertised `authorization_endpoint`, `token_endpoint`, `userinfo_endpoint` and `jwks_uri`. If discovery is unavailable it falls back to PocketID's path layout, so no extra config is needed for either.
- It must issue **JWT access tokens** signed with a key published on its **JWKS** (hal2 verifies tokens locally). Providers that issue *opaque* access tokens are not supported (no introspection path yet).
- A client configured with the **redirect URI(s)** from the *Redirect URIs* setting (default `https://claude.ai/api/mcp/auth_callback`; add more for other MCP clients), grant types `authorization_code` + `refresh_token`, **PKCE (S256)**, and — if a client secret is set — `client_secret_post` auth. Leave the secret empty to run as a **public/PKCE client (recommended)**.

> Tested with the combination **[Caddy](https://caddyserver.com/)** (reverse proxy) + **[PocketID](https://pocket-id.org)** (identity provider) + **Claude.ai** (MCP client). Any spec-compliant OIDC provider issuing JWT access tokens, behind any reverse proxy that forwards the paths above, should work the same way.

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

- **Groups redesigned** — group identity now lives on the Event handler and membership per Item on each Thing, with HAType-aware compatibility (see [Groups](#groups)). Replaces the old `hal2Group` node, with automatic migration.
- **Multi-filter on Things and Items** — combine several match conditions on any message field (exact string, regex, MQTT wildcard, starts/ends/contains) with AND/OR logic, replacing the old single-topic filter.
- **Centralised ingress/egress functions** — define message-transform functions once on the Event handler and reuse them across thing types instead of copying them per type.
- **Notes & tags** on Things and Items, plus automatically derived device **categories** — handy for organising devices and for disambiguation by the MCP and JSON API tools.
- **Metadata** — a per-Thing, machine-managed key/value bag for facts an integration discovers about a device (see below).

## Metadata

Every Thing carries a **metadata** bag: a set of read-only key/value *facts* about the device — for example a model name, serial number or IP address. Unlike **notes** and **tags** (which you write by hand), metadata is **machine-managed**: an integration fills it in, and hal2 stores whatever arrives without interpreting it. This keeps hal2 technology-neutral — it knows nothing about Matter, Thread, Zigbee or IP; it just holds the facts a source provides.

Metadata is updated over a reserved topic on the Thing's own prefix, so any upstream node can set it:

- `‹prefix›/_meta/‹key›` with a value → set/update that key.
- `‹prefix›/_meta/‹key›` with an **empty/null** payload → remove that key (and any nested branch under it).
- `‹prefix›/_meta` with an **object** (or a JSON **string**, which hal2 parses) → **merge**: each key is set, and a key whose value is empty/null is removed. One message can update several keys at once.
- `‹prefix›/_meta` with an **empty/null** payload → clear all metadata.

**Nested objects are flattened** into dot-keys — `{ network: { wifi: { rssi: -60 } } }` is stored as `network.wifi.rssi = -60` (arrays and primitives are kept whole as leaf values). Because every leaf is its own key, partial updates merge precisely (resending `network.wifi.ssid` leaves `network.wifi.rssi` untouched), a nested `null` removes just that leaf, and an empty value on a parent removes its whole branch.

Values are persisted in the Thing's context exactly like state, so they survive a restart. The current metadata is shown in the Thing's edit dialog (values are read-only, but you can delete a single key or **Clear all** — note an active source may re-publish a deleted key), and is exposed to the MCP / JSON API as a `metadata` field in the detailed views — `get_all_states` **full** mode and `get_state` (device) — always present there, as an empty object `{}` when the device has none. It's omitted from the lean `get_all_states` summary and from item-level `get_state`.

For example, the companion [`node-red-contrib-matterjs-bridge`](https://www.npmjs.com/package/node-red-contrib-matterjs-bridge) publishes each Matter device's model and IPv6 address to `matter/‹id›/_meta` — and they appear automatically as Thing metadata, with no hal2-side configuration.


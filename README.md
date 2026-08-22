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

Control and observe several Things at once with **Groups**. A group's identity — name, HAType, value function and rate limit — lives in a registry on the **Event handler** (*Groups* tab), while membership is set per Item on each Thing (the *Groups* section of the Thing editor: pick an Item, pick a group). A group can then be used as a target in an **Action** node, broadcasting a command to every member paced by the rate limit. Each group in the registry has an **info button** that lists its current members.

### A group's own value

A group whose members carry state has a value of its own, which **Value**, **Gate**, **Event** and **Bayes** nodes can read exactly like an Item's — and **each of them chooses how**. The same members answer different questions: *any true* asks "is a lamp on?", *all true* asks "did the command to turn them all on work?", *count true* asks "how many are on?". Two Event nodes can therefore watch the same group for two different things, which one shared value could never do.

What a group reports when nobody asks for anything in particular is **derived from its HAType** — a temperature group averages, a light or switch group answers *any true*. There is nothing to configure; a HAType with no natural summary (Other, the modes, colours) simply has no default, and the reading nodes each pick a function.

| Function | Result |
|---|---|
| `latest` | the most recently updated member's value, whatever its type |
| `min` / `max` | the lowest / highest value |
| `average` / `median` / `sum` | the mean, the middle value, everything added up |
| `range` | highest minus lowest — the spread across the group |
| `any true` / `all true` | at least one / every member is `true` |
| `any false` / `all false` | at least one member is `false` / none is `true` |
| `count true` / `count false` | how many members are `true` / `false` — compare it in a Gate |
| `percent true` | the share that are `true`, 0–100 |

Four rules decide what goes into the calculation:

- **Only members with a state.** A command-only Item has nothing to contribute; a group with none at all cannot be read.
- **No offline members.** A device that has dropped off the network is left out rather than voting with the value it had before it went quiet — so `any true` goes false when the last reachable lamp disappears, instead of reporting a light that may well be dark.
- **Only values of the right kind.** The numeric functions skip anything that is not a number (a boolean member never counts as 1), and the boolean functions are strict about `true` / `false` — hal2 normalises `ON`/`1` in the ThingType's ingress function, so by the time a state reaches a group it is a real boolean or it is not one at all.
- **Nothing eligible means no value.** A group with no live member reporting reads as *undefined*, not `0` or `false`, so a silent group can never be mistaken for a real "off" in a Gate.

A group behaves like an Item in every other respect: it emits on each member update carrying `state` and `laststate`, so an **Event** node's *only on change* filter works the same as it does for a Thing, and `msg.member` says which member moved it. A group's value is derived, so it is never written to the history database and a **Value** node can only read it — use an **Action** node to command a group.

A group has a **HAType** that sets the command contract for its members. Compatibility is directional: `Switch` and `Light` are interchangeable (both are boolean On/Off), and a `Dimmer` item may also join an On/Off group (turning a dimmer off is well-defined) — but a switch or light cannot join a `Dimmer` group, since an On/Off device can't honour a 0–100 level. The Thing editor only offers compatible groups for each Item, and the Event handler only offers HATypes its existing members can all honour. For genuinely mixed groups there is an **Other** type that accepts any Item.

A group with no stateful members stays exactly what it was: a command target, invisible to the reading nodes.

### Groups over MCP

Groups are exposed to assistants as their own pair of tools rather than as parameters on the device
ones, because a group is not a device: it has no items, and reading it is not the inverse of writing
it. **`get_groups`** returns every group with its value and how that value was computed;
**`control_group`** sends one command to every member that can accept one, paced by the group's rate
limit. `get_all_states` carries the same group list alongside `devices`, so orientation takes one
call.

The asymmetry is the thing to hold on to, and the tools say it in as many words: reading a group
uses its **state-capable** members, commanding it uses its **command-capable** ones, and either set
can be empty. A sensor group reads and cannot be commanded; a scene group is the reverse.
Commanding never writes the value — the value follows from what the members report back.

**The function is not fixed.** `get_groups` takes a `function` argument that computes a different
one from the same members for that call only — the same freedom the flow nodes have. The group's
derived default is what `get_all_states` reports and what a call without a `function` returns; the
reply names `configured_function` whenever the two differ, so an ad-hoc reading is never mistaken
for the group's own.

A function that does not apply is **refused rather than answered**: asking a temperature group
whether all its members are true comes back as an error naming what the members hold and listing
the functions that fit. It does not come back as `false`, which is a claim about the group rather
than about the question. Partial coverage is a different matter and is answered: on a mixed group
*average* uses the dimmers and ignores the on/off members, so the reply carries `used` beside
`live` and a mean over 10 of 39 members can be read as what it is.

A group is readable **as soon as it has members that carry state**. Command groups usually are:
switchable devices report back.

**Every function is tracked, not just the default.** The engine keeps a record per function the
group's HAType can serve, so `last_change` and `last_update` are that function's own — a Gate can
ask "has *all true* been steady for ten minutes?" and get a real answer. Deriving them from the
members instead would be wrong for `min`, `max` and `any true`, where a member can change without
moving the value at all: on a nine-sensor group the derived answer was 26 minutes off.

Where one member owns the value — `latest`, `min`, `max` — the reply names it as `source`, so "the
coldest room is the laundry" is one read. A mean or a count belongs to nobody and carries no
`source` rather than an arbitrary one. `last_changed_by` names the member that last moved the
value, which is a different question and only the same one for `latest`.

Give a group **Tags** and **Notes** on the Groups tab and both reach the assistant. This is worth
doing: the name is usually all it has to go on, and "All lights" does not say whether the outdoor
lights are in it. A note does, and `get_groups` takes a `tag` filter so the assistant can ask for
exactly the set it means.

Groups replace the old standalone `hal2Group` node. Existing flows keep working — the Event handler folds legacy group nodes in automatically, though they are command-only until migrated — but you should run `node tools/migrate-groups.js <flows.json>` to make the move permanent and then remove the deprecated nodes. The migration preserves group ids, so existing Action/Event references keep resolving untouched.

## AI & external control

Beyond local automation, hal2 can expose your devices to AI assistants and external systems. The **Event handler** can run a built-in [MCP](https://modelcontextprotocol.io) server, you can define your own AI tools as flows, and the **hal2Api** node offers a plain JSON gateway. All three share one tool catalog, so there is a single source of truth.

### MCP server

> **Breaking change in 3.0.0 — the server reads the token, and nothing else.** hal2 no
> longer takes part in OAuth at all: the dynamic client registration shim, the
> authorization-server metadata routes and the `Client ID`/`Client secret` fields are gone,
> along with the `/userinfo` call that used to fetch group membership on every request.
> What remains is verifying the access token and reading its claims.
>
> **Migration.** Register each MCP client at your identity provider — or point it at a
> Client ID Metadata Document, if the provider resolves those — instead of letting it
> self-register here; a client that self-registered before the upgrade should be removed
> and re-added. Then make sure the claim the access gates match on (`Access claim`, default
> `groups`) is in the **access token** and not only in the ID token or userinfo. If your
> provider cannot put it there — [PocketID currently
> cannot](https://github.com/pocket-id/pocket-id/issues/1389) — leave *Read tools* and
> *Write tools* empty and gate on [required scopes](#the-client-axis-required-scopes) plus
> the provider's own per-client user restrictions instead. A gate whose claim never appears
> refuses everyone, and says so in the log once per client.

The **hal2EventHandler** config node can run an embedded **MCP (Model Context Protocol) server**, letting an AI assistant such as Claude read device state and control your home in natural language. Enable it on the *MCP* tab of the Event handler. The server is **OAuth 2.0 protected and works with any standard OIDC identity provider** (its real endpoints are auto-discovered — see [Authentication & reverse proxy](#authentication--reverse-proxy)), carries a per-location identifier (e.g. "Home" / "Cabin") so an assistant connected to several homes can tell them apart, and supports a local debug token for development. Experimental.

It ships with a catalog of built-in tools:

- **Read** — `get_all_states`, `get_state`, `get_history`, `get_scenes`, `get_presence`, `get_alerts`, `get_groups`, `analyze_patterns`
- **Write** — `set_light`, `control_device`, `control_fan`, `control_cover`, `control_spa`, `control_climate`, `activate_scene`, `control_group`
- **Admin** (opt-in) — `get_flow`, `deploy_flow`

Those three classes are also the unit of [access control](#access-control): a token can be allowed to read the house without being allowed to change it.

Tools are exposed only when matching hardware is configured at that location — a server with no covers won't advertise `control_cover`. Things and Items can carry free-text **notes** and **tags**, and devices report derived **categories** (light, fan, cover, climate, spa, scene), all of which help the assistant pick the right device. Full parameters and examples are in **[docs/API.md](docs/API.md)**.

### Access control

Tools are gated on the **claims in the caller's verified access token**, so one MCP endpoint can serve several people at different privilege levels. A gate is a **claim name** plus a **value list**: the values are comma-separated and matched **any-of** — an array claim must *contain* at least one of them, a scalar claim must *equal* one. An **empty list is no constraint**, which is the default everywhere, so an existing setup keeps behaving exactly as before.

On the Event handler's *MCP* tab, one **Access claim** (default `groups`) carries three lists, checked with **AND**:

| Gate | Covers | Default |
|---|---|---|
| **Read tools** | `get_all_states`, `get_state`, `get_history`, `get_scenes`, `get_presence`, `get_alerts`, `get_groups`, `analyze_patterns` | empty — any authenticated caller |
| **Write tools** | `set_light`, `control_device`, `control_fan`, `control_cover`, `control_spa`, `control_climate`, `activate_scene`, `control_group` | empty — same as read |
| **Admin tools** | `get_flow`, `deploy_flow` (and only when *Enable Node-RED admin tools* is on) | `admin` |

The read list is the floor: a caller who fails it reaches nothing at all. Writes are checked **on top of** it, so `Read tools = family`, `Write tools = ops` gives the whole household visibility while only ops can switch anything. A tool that is in neither set — a future addition, or the undocumented `control_light` alias of `set_light` — is treated as a **write**, so an unclassified tool fails closed rather than slipping through.

### The client axis: required scopes

The lists above answer *what may this user do*. **Read scope** and **Write scope** answer a different question — *what is this client authorized to do on the user's behalf* — and the two are checked with **AND**.

The distinction matters because they are not interchangeable. A group says who is at the keyboard; a scope says how much of that person's authority they delegated to the software holding the token. Collapse them into one field and only one gets consulted: a client granted a read-only scope, driven by someone who may write, would write. The client's grant has to bound the user's rights, not be ignored — that is what delegation means.

Required scopes are added to `scopes_supported` automatically, so there is nothing to repeat in the scopes field and no way to demand a scope that clients are never told to request; they are also named in the `WWW-Authenticate` challenge on a 401, which spec-following clients treat as authoritative.

The scope claim is read the way OAuth defines it ([RFC 6749 §3.3](https://datatracker.ietf.org/doc/html/rfc6749#section-3.3)): a space-delimited string, or an array if your provider sends one. The claim name is not configurable because it is standardised ([RFC 9068](https://datatracker.ietf.org/doc/html/rfc9068)); `scp` is read as a fallback for Microsoft Entra and Okta. The fields themselves are comma-separated any-of lists like the ones above. Empty means no constraint, so an install that never fills them in is unaffected; a configured scope the token does not carry is refused, including when the token has no scope claim at all.

Providers that model APIs as resources — Pocket ID, Auth0 — are where this earns its keep: the IdP grants a client access to the MCP server's resource with a specific set of scopes, and this is where the server enforces what it was handed.

Two further gates layer on the custom-tool side:

- **Standalone-server gate** (`hal2MCPServer` in *Standalone* mode, `Required claim`/`Required value`): gates a whole standalone MCP server and its own claim name, independent of the Event handler's.
- **Per-tool gate** (`hal2MCPIn`, `Tool access`): narrows a single tool further, checked on top of its server's list.

Callers who fail a gate still connect — `initialize` succeeds — but the tools they cannot use are **absent from `tools/list`**, so an assistant is never offered a tool it will then be refused. A direct call to a hidden tool comes back as an MCP tool result with `isError: true` and a human-readable reason, so the model is told *why* rather than getting a generic "tool execution failed".

> The gates apply to the **MCP surface only**, where claims are cryptographically verified. The `hal2Api` node reads `msg.claims` off the message, which any flow can set, so gating it would be decoration rather than a boundary; it keeps its own local *Allow admin tools* checkbox instead.
>
> **Nested claims** are addressed with a dotted path, for providers that don't put roles at the top level of the token: `realm_access.roles` reads Keycloak's realm roles, and any depth works. A key that exists literally always wins, so PocketID's flat `groups` is unaffected. Only strings and arrays of strings match — pointing the claim at a container object grants nothing rather than matching by accident.

### Hostname filtering

Off by default. When **Only serve requests for this hostname** is enabled on the Event handler, its MCP routes only answer requests whose `Host` header matches the hostname in the *MCP server URL*. This lets several Event handlers share the *same* paths (e.g. `/mcp`) on one Node-RED instance, each answering only its own virtual host — useful when one backend fronts several homes on different hostnames. Standalone `hal2MCPServer` nodes inherit the setting from their Event handler. Leave it off for a single server, or when a reverse proxy rewrites the `Host` header.

### Authentication & reverse proxy

The MCP server advertises itself as a **protected resource** and points clients at your identity provider. It does **not** run its own login, and since 3.0.0 it no longer pretends to be an authorization server either.

**Routes to expose through your reverse proxy.** With the default (empty) *HTTP path prefix*, the Event handler registers these on the public *MCP server URL* — all must be reachable from the MCP client:

| Method & path | Purpose |
|---|---|
| `POST /mcp` | The JSON-RPC MCP endpoint (bearer-token protected) |
| `GET /.well-known/oauth-protected-resource` | Resource metadata (RFC 9728) — points the client at the auth server |
| `GET /.well-known/oauth-protected-resource/mcp` | Same metadata, path-inserted form some clients probe |

**This server is a resource server, and nothing else.** It runs no login, holds no client credentials and performs no OAuth flow. It publishes [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) protected-resource metadata naming your identity provider, and clients go there directly — with a [Client ID Metadata Document](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-01) or a pre-registered client ID. Dynamic client registration is deprecated by MCP 2026-07-28 and, as of 3.0.0, is no longer offered here.

**A request is authenticated by the access token alone.** The signature is checked against the provider's JWKS, the issuer is pinned to the discovered provider, expiry is enforced, and the audience must name this server — the MCP endpoint's URL, which is what MCP requires clients to ask for ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html)) and what a provider puts in `aud` for an API.

There is no second call. Nothing is fetched from `/userinfo`: that endpoint serves a client asking about its own user ([OIDC Core §5.3](https://openid.net/specs/openid-connect-core-1_0.html#UserInfo)), not a resource server asking about a token, and a provider may refuse it once the token is bound to this server. **Everything the access gates read must therefore be in the token** — see [RFC 9068 §2.2.3.1](https://www.rfc-editor.org/rfc/rfc9068.html), which is where an authorization server is told to put `groups`, `roles` and `entitlements`. A provider that keeps them in the ID token or userinfo alone will leave the claim gate with nothing to match, and the log will say so, once per client.

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
```

`/mcp` (exact) and `/mcp/*` are deliberately **separate** matchers — in Caddy `/mcp/*` does *not* match the bare `/mcp`. To serve several MCP servers on different hostnames from one backend, give each its own `caddy_N` site block and enable [hostname filtering](#hostname-filtering).

**What hal2 expects of the identity provider:**

- An **OIDC provider with discovery** — hal2 reads `‹issuer›/.well-known/openid-configuration`, and needs exactly two things from it: `jwks_uri`, to verify signatures, and `issuer`, to pin them. (It also notes `client_id_metadata_document_supported`, to decide whether a metadata-document URL may appear as a token's audience.) The authorization and token endpoints are the client's business, not hal2's. If discovery is unavailable it falls back to PocketID's path layout, so no extra config is needed for either.
- It must issue **JWT access tokens** signed with a key published on its **JWKS** (hal2 verifies tokens locally). Providers that issue *opaque* access tokens are not supported (no introspection path yet).
- A **public client** with **PKCE (S256)**, grant types `authorization_code` + `refresh_token`, and the MCP client's **redirect URI(s)** whitelisted (for Claude.ai: `https://claude.ai/api/mcp/auth_callback`) — or CIMD support, which supplies all of that from the client's own metadata document. Clients, redirect URIs and secrets are entirely the provider's business; hal2 has no fields for any of them and never sees a redirect.
- The **access claim in the access token**, if you use the claim gate — the token is all hal2 reads. See [RFC 9068 §2.2.3.1](https://www.rfc-editor.org/rfc/rfc9068.html).

> Tested with the combination **[Caddy](https://caddyserver.com/)** (reverse proxy) + **[PocketID](https://pocket-id.org)** (identity provider) + **Claude.ai** and **Hermes** (MCP clients). Any spec-compliant OIDC provider issuing JWT access tokens, behind any reverse proxy that forwards the paths above, should work the same way.

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

**Which endpoint it speaks for** is set by the *Standalone* field. Left empty, the node serves the Event handler's own embedded catalog — the built-in tools plus any `hal2MCPIn` tools registered against it. Point it at a `hal2MCPServer` node instead and it serves that server's tools and nothing else, exactly as an MCP client connecting to that server's URL would see.

Send `{ "list": true }` instead of a tool name to get the catalogue of whichever endpoint the node speaks for — `{ name, description, inputSchema }` per tool, the shape `tools/list` returns. For the built-in tools **[docs/API.md](docs/API.md)** (auto-generated, `npm run docs:api`) is the fuller reference; for your own `hal2MCPIn` tools the listing is usually the only index there is.

**Access control does not apply on this path.** The claim and scope gates run on the MCP server's HTTP route, where the token behind them was verified. A flow node is already inside the trust boundary — whoever can edit flows can edit the tool — so a tool restricted to certain callers over MCP is still callable here, and the listing shows it. Don't use hal2Api to re-expose a gated tool to an outside caller; that gate is yours to reproduce. Admin tools (`get_flow`, `deploy_flow`) are the exception and keep the route's rule: enabled on the server, *Allow admin tools* enabled on this node, **and** an admin claim on `msg.claims`.

See `examples/json-api.json` for a ready-made HTTP endpoint flow.

## History & pattern analysis

Items can opt in to **history logging**: when enabled on the Event handler (and per Item), value changes are stored in a local **SQLite** database with a configurable retention period. History requires the optional `better-sqlite3` package — install it with `npm install better-sqlite3` in your Node-RED user directory. Without it, history simply stays off and nothing breaks.

History powers two tools:

- **`get_history`** — fetch logged values for an Item over a flexible time window: a rolling `hours` count, an explicit `from`/`to` range, or a point-in-time `at` lookup ("what was it at 08:00?"), with `offset`/`limit` paging.
- **`analyze_patterns`** — scans the history to surface recurring routines, e.g. *"Living Room Light turns on around 07:30, 85% consistent"*, so you can spot automations worth creating.

## Bayes node

`hal2Bayes` estimates something you cannot measure directly — typically *"is this person
home?"* — by weighing up several unreliable sensors instead of trusting any single one. A phone
presence sensor that already reports "home" from the street corner is not enough on its own;
combined with the front door opening and closing and movement in the hallway, it becomes
convincing. The node is an anonymous estimator: it knows nothing about people, it just fuses
evidence. Use one node per hypothesis (one per person) and wire its output onward like any
other message — e.g. into a Scene-type sensor representing the person.

### Comparing against another source

**in range / outside range** match while a reading sits between two bounds, or while it does not.
Available in hal2Event, hal2Gate and hal2Bayes. Inclusive at both ends, so a reading exactly on a
bound is *in* the range, and the order is not significant — 20 to 24 and 24 to 20 name the same
band. Both bounds are typed beside the operator, which is also why they are two operators rather
than one with an inside/outside switch: the pair already occupies the space a switch would have
wanted, and the operator itself says what is being asked of it.

A bound left empty makes **both** operators match nothing. That takes a little care, because
`Number('')` is `0` rather than `NaN` — read naively, an empty upper bound would turn "in range 20
to \_\_" into the band 0–20 and match things nobody asked for. `rangeBounds()` in `lib/rules.js` is
the one place that reads a pair of bounds, and it treats blank as NaN so a half-filled rule stays
quiet.

Paired with hal2Event's `trigger true/false` output, *in range* expresses a comfort band directly:
`true` on the way in, `false` on the way out, whichever side you leave by.

Every comparison in hal2Gate, hal2Event and hal2Bayes normally weighs a source against a
**constant** — a number, a string, or a variable. Pick the **state** value type instead and the
right-hand side is another live reading: another Thing's Item, or a Group with a function of its own.

This is worth more than the convenience. The alternative was storing one side in a flow variable
and comparing against that, which samples the two sides at different moments: something changes,
the variable has not caught up, and the comparison is silently wrong until it corrects itself. With
`state` both sides are read in the same pass, so the window does not exist. "Is everyone who is
home asleep?" becomes one rule — *people home* `count true` **==** *phones charging* `count true` —
with nothing stored in between.

The right-hand side is described the same way everywhere: a source, and an item or group function.
It is offered wherever comparing two values makes sense, so not for *is true*/*is false*, *regex*,
or the Gate's `last_*` operators, which compare against a duration. A source that cannot be read —
a deleted Thing, a group with no live member — makes the rule not match rather than comparing
against nothing.

### Rules

Each rule collapses to a single line stating what it says and what it does about it — the same
phrasing `bayes-label.js` gives the snapshot on output 2, so a rule reads the same on screen as it
does in the debug panel — and opens when clicked. A dozen controls per rule is unreadable as a
list; one sentence per rule is not.

Everything is a **rule**, built from steps. Each step names a source and a condition, then says
*when* that condition has to hold. A source is normally a **thing** item, but it can also be a
**flow**, **global** or **env** variable — for facts that live elsewhere in the flow, such as
"the calendar says we are away" or "guest mode is on" — or a **time** window.

- **now** — a condition, true at that instant (*and…*)
- **now or soon** — the same, but it waits for the condition until the window runs out; for
  sensors that report late (*and…*)
- **for a while** — a condition that must have been continuously true for its own duration
  before it counts. This is what separates a trip to the bathroom from getting up for the day:
  the reading is identical at the moment it happens, and only time tells them apart. The clock
  restarts whenever the condition drops, so a string of short absences never adds up to a long
  one, and it survives a restart because the edge is persisted with the rest of the state.
  It has a window as well, and the window bounds when the hold is *reached* — so the condition
  has to go true a whole hold-length before the window runs out, and the step's read-back line
  does that subtraction (*and…*)
- **on change** — an event: the condition must actually turn true, being already true does
  not count (*then…*)
- **on a full cycle** — a cycle: true and back to false within its limit, e.g. a door opening
  and closing (*then…*)

A rule whose steps are **all conditions** is not a sequence but an **AND**: its weight applies for
as long as every one of them holds at the same time. "While it is 09:00–10:00 *and* the terrace is
above 100 lux" is one weight with two conditions. A rule that opens with a condition but waits for
an event later cannot work — nothing completes that first step — and the editor says so on the
rule; in the snapshot it reads as `never-fires`.

Timing sits on a second line under a step, only where it applies: *within N s of the previous
step* is how long that step has to happen, and *stays on for at most N s* is how long a cycle may
stay true — a door held open longer than that is not a pass-through, so the rule does not advance.
In an AND there is no previous step to be soon after, so no window is shown.

A **time** source is a window of the day rather than a sensor: start and end in 24-hour format
plus the weekdays it applies on. It may cross midnight (22:00–06:00), start is inclusive and end
exclusive, and a window whose start equals its end is never active. The weekday is **the day it
is right now** — with 22:00–06:00 on Mon–Fri, Tuesday 02:00 counts but Saturday 02:00 does not,
even though that is Friday night. The value is simply "inside the window or not", so the
condition reads *inside* / *outside* and one window covers both "during the night" and "outside
working hours". Times follow the server's local clock, DST included.

**flow, global, env and time can only be conditions** — *now* or *now or soon*. Only a
thing is subscribed to, so these are read when the node evaluates rather than pushed when they
change; an edge qualifier on one could only be sampled on the tick and would miss anything
faster. The same polling means such a rule — including a time boundary — takes effect within one
tick (30 s by default), not on the second. And `flow`/`global` survive a restart only when the
context store is file-backed; the default is memory.

A rule that is a single *now* step is **continuous** (*While…*): it pushes the estimate while its
condition holds and stops the moment it does not. Any other rule is **momentary** (*When…
then…*): the steps must happen in order, each event within its time window, and completing the
last step gives a one-off push that then fades. An event that happened while the previous step
was still in progress also counts, so motion while the door stood open is accepted when it
closes.

**Put the event first and the conditions after.** Trigger on what actually happens at a point
in time — usually the door — and use a condition step to ask what was true at that moment:

> *When the front door is true, on a full cycle — and iPhone Fredrik is true, now →
> makes it true, decisive*

Written this way the rule does not care whether the phone appeared thirty seconds or thirty
minutes earlier, and it never fires for somebody else's arrival, because their phone is not
here — the identity check falls out of the condition, with no special logic. If that sensor is
slow to report, *now or soon* makes the step wait rather than fail. Only a step that needs the
*change* itself — leaving — uses *on change*:

> *When the front door on a full cycle, then iPhone Fredrik is false, on change, within
> 5 min → makes it false, certain*

### Strengths and the share scale

Each rule pushes toward true or false with a word strength — **slight** (LR 1.5), **moderate**
(3), **strong** (10), **decisive** (30), **certain** (400). The editor shows every rule as a
*share of the way* from the prior to the threshold the node can actually cross, and shares add
exactly: 74 % + 35 % =
109 % turns the output on. This is also how shared sensors are disambiguated without any
special logic: give the door/motion arrival rule a share too small to cross the line alone, so
it only matters together with the node's own strong indicator — someone else arriving contributes
35 % to this node and nothing happens.

**A prior above the on-threshold is a supported configuration, and a useful one.** The node then
rests *on* and rules push it off, which is how you say "assume the house is quiet until something
says otherwise" — no rule has to argue the resting case, and silence is the answer rather than
something to be reconstructed. Shares are then measured toward the off-threshold, since that is
the only line the estimate can cross, and the editor's summary says so. The constraint to keep in
mind is that the prior must be reachable in one hop by your strongest veto: at prior 0.93 with an
off-threshold of 0.35, one **decisive** rule is 106 % of the way and just enough, while 0.95 would
need **certain**.

A **certain** rule overrides history: firing it clears
opposing evidence, and a stored certain statement is cleared by any later contradicting rule.

### Weights that follow the reading

The strength **scaled…** makes a rule's weight depend on the measured value rather than being
constant. Give two points — *value 20 or less → weight 150 %*, *value 60 or more → weight 0 %* —
and the weight is interpolated between them, clamped outside. A rule's **weight** is its share of
the way to on, the same percentage the bars show: 100 % is exactly enough to flip the output when
nothing opposes it. Soil moisture is the natural case: watering in direct sun is normally a bad
idea, but critically dry soil should override it, which only works if the dryness rule grows
heavier as the reading falls. This is the step from naive Bayes with binary features to logistic
regression over a continuous one.

Shares may exceed 100 % and may be negative; the sign lives in the shares, so the *makes it*
dropdown is hidden for a scaled rule and one rule can push both ways across its range. Mind the
arithmetic: 100 % reaches the threshold *exactly* from the prior, so any opposing evidence blocks
it — overriding a moderate 35 % objection needs roughly 150 %. Single-step rules only, since with
several steps there is no non-arbitrary answer to which value scales the weight.

Two caveats when using the node this way. Irrigation is a **decision, not a hidden state** — there
is no fact about whether watering "is needed" independent of preference; the machinery still fits,
but `p` becomes a score rather than a probability. And several moisture sensors in one bed are
**not independent evidence** — naive Bayes over-counts them and pins the estimate at the clamp, so
aggregate them (min or mean) into a `global` and use one rule.

### Fading and the latch

Momentary pushes fade — **quick** (5 min half-life), **normal** (20 min), **slow** (1 h),
**never** (the push stands until something contradicts it) or **custom…** for an explicit
half-life; continuous rules simply stop when their condition does. Strength buys very little
time here: each doubling of `ln(LR)` adds only one half-life, so if you want a push to last,
change the fade rather than the strength.

**Refiring** decides what happens when the same momentary rule completes again while its
previous push is still alive. **refreshes** (the default) restates the rule: one push, its clock
reset, at whatever weight the rule is worth now. **stacks** adds a second push to the first.

Stacking is the correct Bayesian reading only when the two firings are genuinely independent
observations — two separate arrivals, say. It is the wrong reading when one continuing fact is
simply being reported repeatedly, which is the usual case for a sensor that re-triggers while
something keeps happening. A motion rule left to stack ran a live node to the clamp on seventeen
firings in twenty-three minutes, each one describing the same person still moving about. Claim
independence deliberately; do not let it be the default. Continuous rules have no setting here —
they hold one weight for as long as their conditions hold and never accumulate.

By default the output falls back to
off as evidence disappears. The **lock** changes that: *only rules that make it false can turn
it off* — silence, decay or a sensor dropping out will not (status shows `held`). Use it when
the state cannot end unnoticed: nobody leaves the house without the door opening, so a phone
rebooting indoors must not flip the estimate. An optional hour limit turns it off anyway after
that long without supporting evidence. With the lock on, fading no longer makes the output fall
back by itself — but it still decides whether a push is strong enough to turn the output *on*,
and how long a "makes it false" rule stays able to turn it off: a false rule that fires while
the estimate is still high can fade away before the estimate drops, and is then wasted.

Advanced mode exposes the raw numbers (LR, half-life seconds, prior, thresholds, clamp) on the
same rules — there is one data model, the modes only differ in what is shown. The estimate is
persisted in node context and keeps fading by wall clock across restarts.

Set **Topic** to put a `msg.topic` on both outputs — output 1 gets it as written, output 2 gets
it with `/snapshot` appended. Leave it blank and no topic is set at all, as in the Event node.

Output 1 carries the binary result (`payload`, `probability`, `changed`). By default it only
emits when the result actually flips — a rule firing again while the node is already on sends
nothing — but **Emit output 1** can be set to *every evaluation* when a downstream flow wants
the state re-asserted continuously. `msg.topic` `reset` / `evidence` (`{ lr, halfLife? }`) are
available as escape hatches.

### Explaining the estimate

Output 2 emits a snapshot built for tuning: it says not just what the estimate is but which
rules produced it.

Both outputs answer to the same **Emit** setting. On *only on a change* — the default — each stays
quiet until it has something new to say: output 1 when the true/false result flips, output 2 when
the snapshot differs from the one it last sent. A sensor re-reporting the value it already had
leaves the snapshot identical and sends nothing, which is where most of the traffic used to go.
Evidence that is decaying does change the snapshot and does keep emitting on every tick, because
the estimate really is moving. Sending the node any message it does not otherwise understand always
answers with a snapshot, changed or not.

```json
{ "p": 0.86, "logOdds": 1.86, "share": 108.4, "binary": true, "held": false,
  "rules": [
    { "id": "r1", "label": "While Hallway Sensor · Motion is true",
      "status": "contributing", "share": 73.8, "logOdds": 2.303, "value": true },
    { "id": "r2", "label": "When Front Door · Contact is true on a full cycle and Hallway Sensor · Motion is true",
      "status": "waiting", "share": 0, "logOdds": 0, "step": 2, "steps": 2, "deadline": 47 },
    { "id": "r3", "label": "While Office Sensor · Temperature > 25 and Office Window · Contact is false",
      "status": "condition-false", "share": 0, "logOdds": 0, "value": 26.1,
      "failedStep": 2, "failedValue": true }
  ] }
```

**Every configured rule is listed, every time** — the question while tuning is usually why a rule
is *not* firing, and a list of the ones that are cannot answer it. `status` says which case a rule
is in:

| `status` | Meaning |
|---|---|
| `contributing` | a level rule whose condition holds; its weight is in the estimate now |
| `fading` | a rule that fired earlier — `age` and `halfLife` (seconds) say how far it has decayed |
| `waiting` | a sequence partway through: `step` of `steps`, with `deadline` seconds left |
| `armed` | a sequence at its first step, waiting to be triggered |
| `condition-false` | evaluated and did not match — `failedStep` is which condition broke it and `failedValue` what that step read |
| `no-value` | the failing step had nothing to read, or the reading is unusable for a scaled weight |
| `injected` | ad-hoc evidence from `msg.topic = "evidence"`, which has no rule behind it |
| `never-fires` | the rule opens with a condition but waits for an event later, so nothing can start it |

`value` is always the **first** step's reading, because that is also what a scaled weight follows.
On a rule with several conditions the step that failed is a different one, so `failedStep` names it
and `failedValue` carries its reading — and `no-value` rather than `condition-false` when that step
had nothing to read at all.

`share` is the contribution as a percentage of the way from the prior to the on-threshold — the
same unit the rule bars and the summary use in the editor, so what you tuned is what you read back.
Shares add, so the contributing ones sum to the top-level `share`, and anything at or above 100 %
reaches the threshold on its own. `label` is derived from the rule's steps, phrased as the editor
phrases them; `logOdds` is the same contribution in the estimator's own units.

The node's status line carries the same share: `on 108% (0.86)` — the share first, the probability
after it. Against a threshold you chose, the probability alone does not say whether a node is
nearly there or nowhere near; the share does, in the unit the rules were tuned in.

## Other recent additions

- **hal2Bayes — probabilistic binary-state estimation** (see [Bayes node](#bayes-node)).

- **hal2Event — a level output** (`trigger true/false`). The Event node has always reported the
  *rising* edge: it fires when the trigger rule starts holding and says nothing when it stops, so a
  flow that wanted to know whether a condition currently holds needed a second node with the rule
  inverted — a second place to keep in agreement with the first.

  The new output type reports the rule as a level instead: `true` when it starts holding, `false`
  when it stops, and nothing in between however many updates arrive. A threshold whose reading
  wanders without crossing it stays silent, where an every-evaluation output would narrate each
  reading.

  Two settings behave differently in this mode, and the editor hides or replaces them rather than
  leaving them to surprise you. **Rate limit does not apply**: it drops messages inside its window,
  and a dropped `false` leaves the receiver believing `true` for as long as nothing else moves — not
  a degraded signal but a wrong one.

  **Delay applies per edge**, with *Delay on true* and *Delay on false*, both on by default so that
  a ticked *Delay event* always does something. Turn off the second for an on-delay: the rule must
  hold before `true` is sent, while `false` goes out at once. Turn off the first instead for the
  opposite — quick to react, slow to let go, which is what a signal that flickers off usually
  wants. A queued edge is dropped whenever the answer moves away from it
  again, so the node never announces a state that has already stopped being true; *Reset delay* is
  implied and hidden.

  With the **always** operator there is no level — the rule cannot stop holding — so the node keeps
  its ordinary firing discipline and simply carries `true`, exactly as the boolean output type does.
  It never sends `false`, and the editor says so where you choose it.

- **Groups redesigned** — group identity now lives on the Event handler and membership per Item on each Thing, with HAType-aware compatibility (see [Groups](#groups)). Replaces the old `hal2Group` node, with automatic migration.
- **Multi-filter on Things and Items** — combine several match conditions on any message field (exact string, regex, MQTT wildcard, starts/ends/contains) with AND/OR logic, replacing the old single-topic filter.
- **Centralised ingress/egress functions** — define message-transform functions once on the Event handler and reuse them across thing types instead of copying them per type.
- **Notes & tags** on Things and Items, plus automatically derived device **categories** — handy for organising devices and for disambiguation by the MCP and JSON API tools.
- **Metadata** — a per-Thing, machine-managed key/value bag for facts an integration discovers about a device (see below).
- **Metadata mappings** — declare on the Thing type which topics carry device facts, for sources that can't publish to `_meta` themselves (see [Metadata mappings](#metadata-mappings)).
- **Function store** — persistent scratch space for a Thing's ingress/egress functions, so logic that needed a function node and `context.get`/`set` can live in the Thing type (see [The function store](#the-function-store)).

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

### Metadata mappings

`_meta` requires a source that can publish where hal2 wants it. When it can't — a device whose topics are fixed by its firmware — declare a **metadata mapping** on the Thing type instead. A mapping looks like an item: topic filters plus an ingress function. The difference is where the result goes: under the mapping's **key** in the metadata bag, never into item state.

An ESPHome node publishing `esphome/‹room›/device/wifi` as `{"ip":"…","ssid":"…","bssid":"…","rssi":-46}` needs one mapping — filter *ends with* `/device/wifi`, key `wifi`, ingress returning the three stable fields:

```js
if (!msg.payload || typeof msg.payload !== 'object') { return null; }
return { ip: msg.payload.ip, ssid: msg.payload.ssid, bssid: msg.payload.bssid };
```

That stores `wifi.ip`, `wifi.ssid` and `wifi.bssid`. `rssi` is deliberately left out — it changes constantly and belongs in an item, where it gets history. The rule of thumb: **what the device *is* goes in metadata, what the device *measures* goes in items.**

Returning `null` from a mapping leaves the metadata untouched; returning an empty string deletes the key and its branch, exactly as an empty `_meta` payload does.

## Writing functions in a Thing type

Ingress, egress, filter, metadata and *Show state* functions are built with `new Function()`, not run as Node-RED function nodes. Only these arguments exist — `context`, `flow`, `global`, `RED` and `util` are **not** in scope and referencing them throws:

| Function | Arguments | Return value |
|---|---|---|
| Item ingress | `(msg, attribute, item, store)` | The item's new value; `null`/`undefined` leaves it unchanged |
| Filter function | `(msg, attribute, item, store)` | `true` passes the message on; anything else drops it |
| Metadata ingress | `(msg, attribute, item, store)` | Value or object to store; `null` changes nothing |
| Item egress | `(msg, attribute, item, store)` | The message to send; `null` sends nothing |
| Show state | `(item, attribute, store)` | Status text — note the different argument order |

- **`attribute`** — the Thing's attribute values by name, `attribute['Room']`. Configuration, always strings.
- **`item`** — a snapshot of every item's current value by name, `item['Temperature']`; unset items read `'no value'`. Writing to it does nothing.
- **`store`** — scratch space that persists between messages, private to the Thing: the equivalent of `context.get`/`set` in a function node.

### The function store

`store.get(key)`, `store.set(key, value)`, `store.keys()`, `store.clear()`. Setting a key to `null` deletes it. Values are persisted through the Thing type's context store, so they must be JSON-serialisable — no `Date`, no `Map`, no functions; keep timestamps as numbers. The contents are visible, per key, in the Thing's edit dialog, and clearable from there when a function has stored something wrong.

The store is what lets logic that would otherwise need a function node live inside the Thing type. A presence Thing that has to pick which room a phone is in receives one message per room and must remember the others:

```js
var rooms = store.get('rooms') || {};
rooms[room] = { rssi: rssi, ts: Date.now() };
store.set('rooms', rooms);
```

When several items need the same derived value, compute it once in the **filter function** — it runs before the items, on every message that reaches the Thing — and let each ingress read the result back out of the store. Otherwise every item repeats the same work.


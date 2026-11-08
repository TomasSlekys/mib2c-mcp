# mib2c-mcp

An MCP server that lets an AI assistant (Claude, Codex, Cursor, VS Code Copilot or any other MCP app) see and work
the [MIB2 Configurator](https://pqisa.eu/mib2c/) open in your browser: the web app for VW MIB2 head unit skins (ambient
light, climate, car status, parking, energy flow, tyre and traffic sign screens).

The assistant can read what the app shows, switch pages, cars, sides and themes, take screenshots of the head unit
screen, move points, touch areas, parking and energy flow positions (with undo), set the preview situation, and
export and replace images. Saving goes through the app: it shows you the list of changes and waits for you to
confirm (unless you let it save without asking). Everything it does shows up in the app's **MCP › Log**.

Your skin files stay in the browser. This server runs on your computer, listens only on `127.0.0.1`, and talks to
the page over a WebSocket. There is nothing to pair or type in.

## Requirements

- Node.js 20 or newer, and git (npx fetches the server from GitHub).
- Chrome or Edge with the app open (https://pqisa.eu/mib2c/, signed in with Discord, or your own copy of it).
- An AI app that uses MCP servers (examples below).

## Set up

Add the server to your AI app once, then restart the app (or start a new session): it starts the server by itself.

**Claude Code**

```sh
claude mcp add --scope user mib2c -- npx -y github:TomasSlekys/mib2c-mcp
```

**Codex CLI**

```sh
codex mcp add mib2c -- npx -y github:TomasSlekys/mib2c-mcp
```

Then give it more time in `~/.codex/config.toml` (the first start builds the server, and a save waits while you
confirm it in the app; Codex's defaults are 10 and 60 seconds):

```toml
[mcp_servers.mib2c]
startup_timeout_sec = 120
tool_timeout_sec = 900
```

**Claude Desktop**: Settings › Developer › Edit Config, then add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mib2c": { "command": "npx", "args": ["-y", "github:TomasSlekys/mib2c-mcp"] }
  }
}
```

**Cursor**: the same `mcpServers` block in `~/.cursor/mcp.json`.

**VS Code** (GitHub Copilot, agent mode): in `.vscode/mcp.json` (or the user `mcp.json`):

```json
{
  "servers": {
    "mib2c": { "type": "stdio", "command": "npx", "args": ["-y", "github:TomasSlekys/mib2c-mcp"] }
  }
}
```

On Windows, if an app can't start `npx`, use `"command": "cmd", "args": ["/c", "npx", "-y", "github:TomasSlekys/mib2c-mcp"]`.

## Connect the page

**The first time:** open the app, click **MCP** in its top bar, and click **Allow** when the browser asks whether
the site may access your local network (or this computer). The dot turns green once your AI app is running. The
same menu shows the setup lines above.

**After that:** nothing. The page connects by itself, within a few seconds, whenever your AI app runs this server,
and the MCP log opens at the bottom. Open the app and your skins folder and talk to your assistant.

Why the one click: browsers only let a public website reach `127.0.0.1` after you allow it (Chrome's Local Network
Access), and the app doesn't ask on its own, so visitors who don't use MCP never see the prompt. Chrome remembers
your answer for the site. **Turn off** in the MCP menu stops the page connecting until you turn it on again. The
app run on your own computer (`localhost`) connects without the prompt.

Security: the server only accepts the app's own pages (by their origin, which the browser sets and a web page can't
fake), on `127.0.0.1` only. Programs already running on your computer could also connect, as with any local
server; they could do no more than you can on your own computer anyway.

## Tools

| Tool | What it does |
| --- | --- |
| `status` | Connection state, and how to connect if the page isn't. The assistant calls this first. |
| `get_state` | Skin, head unit, theme, page, mode, car, side, unsaved changes, undo state. |
| `list_cars` | The cars a page has pictures for, with names where known. |
| `navigate` | Page, car, side, View / Edit mode, theme, head unit UI, screen view. |
| `screenshot` | The page's screen as PNG at the screen's own resolution; `labels` names every point and touch area, `region` + `zoom` shows a part up close, `file` writes it to disk. |
| `get_scene_data` | The zone file of the ambient light / climate / car status page: points, touch areas, names, images. |
| `move_items`, `set_points`, `align_items`, `distribute_items` | Move or place points, touch areas or corners (each call is one undo step). |
| `reset_items`, `revert_file` | Put items, or a whole file, back as saved (one undo step). |
| `copy_points` | Copy positions to the other side (mirrored) or another car (scaled to its picture). |
| `undo`, `redo` | Step back and forward through position edits, per data file. |
| `get_parking_data`, `move_parking`, `set_parking_preview` | The parking layout file (sectors, pieces, positions) and its preview (obstacles, faults, guide lines…). |
| `get_energy_data`, `move_energy`, `set_energy_preview` | The energy flow file (car, battery, engine, e-motor, tracks) and its situation. |
| `get_preview`, `set_preview` | What the car reports on the interior pages (nothing is written). |
| `find_vehicle_messages` | Search the unit's 453 vehicle messages. |
| `get_dev_info`, `list_screen_items`, `find_item_at`, `list_strings` | Firmware facts about the shown screen: view name, class, model name, view id, state machine states, button events and where they lead, datapool values; every drawn item (key, rect, image id → bitmap, string → text, font, colour); strings in other languages. Read-only. |
| `find_view`, `find_string`, `find_image_usage` | Look up firmware views, strings and pictures across all the app's screens. Read-only. |
| `list_images`, `get_image`, `export_image` | Find images by path; get one as PNG, or write it to a file to edit elsewhere. |
| `replace_image`, `replace_images`, `revert_image` | Replace one image, or a folder of them matched by file name, from pictures on this computer; take one back. |
| `get_changes`, `check_skin` | Everything save would write, before and after; a check of the edited zone files. |
| `save` | Save every change; you confirm in the app first, unless you let MCP save without asking. |

Everything the assistant does shows up in the app's **MCP › Log**: each action with its time, a plain description,
how it went, and on click what it asked for and got back.

## Options

```
mib2c-mcp [--port <n>]
```

| Setting | Default | |
| --- | --- | --- |
| `--port` / `MIB2C_PORT` | `47391` | WebSocket port on 127.0.0.1. Enter the same port in the app's MCP menu. |
| `MIB2C_ORIGINS` | | More page origins allowed to connect, comma-separated, `*` matches any part (e.g. `https://mib2c.example.home`). Always allowed: `https://pqisa.eu`, `https://mib2c.pqisa.eu` (the old address), `http://localhost:*`, `http://127.0.0.1:*`, `https://*.ddev.site`. |

## Troubleshooting

- **The dot stays amber ("waiting")**: your AI app isn't running, or its server uses another port. Ask your
  assistant for `status` (the app starts the server when it starts), and check the port.
- **Red dot ("blocked by the browser")**: the local network prompt was blocked. Click the icon left of the address,
  allow Local network (or Loopback network) access for the site, and reload.
- **"Port 47391 is taken"**: another AI app or session already runs mib2c-mcp. Close it, or give this one another port
  (`MIB2C_PORT`) and enter that port in the app.
- **"Versions differ"**: update whichever is older: reload the app, or restart your AI app so npx fetches the latest
  server.
- **A page on your own address is refused**: add its origin to `MIB2C_ORIGINS`.
- **Only one tab at a time**: a newly connected tab takes over from the previous one.

## How it works

```
AI app ──stdio (MCP)──> mib2c-mcp ──ws://127.0.0.1:47391──> the app's page (the browser)
```

The server turns each tool call into a command for the page (`src/protocol.ts`; the app has the same file in
`src/lib/bridge/protocol.ts`, change both together). The page runs it with the app's own code, so the app's rules,
undo history and save confirmation apply, and sends back the result or a picture. The server only reads files
from your computer for `replace_image`.

The page must say hello within 5 seconds, from an allowed origin, or it is disconnected.
Calls time out after 30 seconds (2 minutes for `replace_image`, 15 minutes for `save`, which waits for you).

## Development

```sh
npm install
npm test            # builds, then runs the tests (node --test)
npm run build
node dist/src/index.js --help
```

To try it against a local copy of the app, run the app's dev server (`npm run dev`, http://localhost:3000 is
allowed) and point your AI app at `node /path/to/mib2c-mcp/dist/src/index.js`.

## Licence

MIT, Copyright (c) 2026 Tomas Slekys. See [LICENSE](LICENSE).

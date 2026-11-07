# mib2c-mcp

An MCP server that lets Claude see and work the [MIB2 Configurator](https://mib2c.pqisa.eu) open in your browser:
the web app for VW MIB2 head unit skins (ambient light, climate, car status, parking, energy flow, tyre and traffic
sign screens).

Claude can read what the app shows, switch pages, cars, sides and themes, take screenshots of the head unit screen,
read and move ambient light / climate / car status points and touch areas (with undo), set the preview situation
(ambient colour, climate preset, vehicle messages, lights and vents on or off), and list, export and replace images.
Saving goes through the app: it shows you the list of changes and waits for you to confirm.

Your skin files stay in the browser. This server runs on your computer, listens only on `127.0.0.1`, and talks to
the page over a WebSocket. There is nothing to pair or type in.

## Requirements

- Node.js 20 or newer, and git (npx fetches the server from GitHub).
- Chrome or Edge with the app open (https://mib2c.pqisa.eu, or your own copy of it).
- Claude Code, Claude Desktop, or another MCP client.

## Set up

**Claude Code**

```sh
claude mcp add --scope user mib2c -- npx -y github:TomasSlekys/mib2c-mcp
```

Start a new Claude Code session afterwards (a running one doesn't see a newly added server).

**Claude Desktop**: Settings › Developer › Edit Config, then add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mib2c": { "command": "npx", "args": ["-y", "github:TomasSlekys/mib2c-mcp"] }
  }
}
```

On Windows, if Claude Desktop can't start it, use `"command": "cmd", "args": ["/c", "npx", "-y", "github:TomasSlekys/mib2c-mcp"]`.

## Connect the page

**The first time:** open the app, click **Claude** in its top bar, and click **Allow** when the browser asks whether
the site may access your local network (or this computer). The dot turns green once Claude is running.

**After that:** nothing. The page connects by itself, within a few seconds, whenever Claude runs this server. Open
the app and your skins folder and talk to Claude.

Why the one click: browsers only let a public website reach `127.0.0.1` after you allow it (Chrome's Local Network
Access), and the app doesn't ask on its own, so visitors who don't use Claude never see the prompt. Chrome remembers
your answer for the site. **Turn off** in the Claude menu stops the page connecting until you turn it on again. The
app run on your own computer (`localhost`) connects without the prompt.

Security: the server only accepts the app's own pages (by their origin, which the browser sets and a web page can't
fake), on `127.0.0.1` only. Programs already running on your computer could also connect, as with any local
server; they could do no more than you can on your own computer anyway.

## Tools

| Tool | What it does |
| --- | --- |
| `status` | Connection state, and how to connect if the page isn't. Claude calls this first. |
| `get_state` | Skin, head unit, theme, page, mode, car, side, unsaved changes, undo state. |
| `list_cars` | The cars a page has pictures for, with names where known. |
| `navigate` | Page, car, side, View / Edit mode, theme, head unit UI, screen view. |
| `screenshot` | The page's screen as PNG, at the screen's own resolution. |
| `get_scene_data` | The zone file of the ambient light / climate / car status page: points, touch areas, names, images. |
| `move_items`, `align_items`, `distribute_items` | Move points, touch areas or corners (each call is one undo step). |
| `undo`, `redo` | Step back and forward through position edits, per data file. |
| `get_preview`, `set_preview` | What the car reports in the preview (nothing is written). |
| `find_vehicle_messages` | Search the unit's 453 vehicle messages. |
| `list_images`, `get_image` | Find images by path and get one as PNG (as stored, or its replacement). |
| `replace_image`, `revert_image` | Replace an image with a picture file from this computer; take it back. |
| `save` | Save every change; you confirm in the app first. |

Not yet available through Claude: moving parking and energy flow positions, and those pages' situation controls
(screenshots, images and undo work there).

## Options

```
mib2c-mcp [--port <n>]
```

| Setting | Default | |
| --- | --- | --- |
| `--port` / `MIB2C_PORT` | `47391` | WebSocket port on 127.0.0.1. Enter the same port in the app's Claude menu. |
| `MIB2C_ORIGINS` | | More page origins allowed to connect, comma-separated, `*` matches any part (e.g. `https://mib2c.example.home`). Always allowed: `https://mib2c.pqisa.eu`, `http://localhost:*`, `http://127.0.0.1:*`, `https://*.ddev.site`. |

## Troubleshooting

- **The dot stays amber ("waiting")**: Claude isn't running, or its server uses another port. Ask Claude for
  `status` (Claude starts the server when it starts), and check the port.
- **Red dot ("blocked by the browser")**: the local network prompt was blocked. Click the icon left of the address,
  allow Local network (or Loopback network) access for the site, and reload.
- **"Port 47391 is taken"**: another Claude session already runs mib2c-mcp. Close it, or give this one another port
  (`MIB2C_PORT`) and enter that port in the app.
- **"Versions differ"**: update whichever is older: reload the app, or restart Claude so npx fetches the latest
  server.
- **A page on your own address is refused**: add its origin to `MIB2C_ORIGINS`.
- **Only one tab at a time**: a newly connected tab takes over from the previous one.

## How it works

```
Claude ──stdio (MCP)──> mib2c-mcp ──ws://127.0.0.1:47391──> the app's page (the browser)
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
allowed) and point Claude at `node /path/to/mib2c-mcp/dist/src/index.js`.

## Licence

MIT, Copyright (c) 2026 Tomas Slekys. See [LICENSE](LICENSE).

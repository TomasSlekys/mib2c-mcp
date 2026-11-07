# mib2c-mcp

An MCP server that lets Claude see and work the [MIB2 Configurator](https://mib2c.pqisa.eu) open in your browser:
the web app for VW MIB2 head unit skins (ambient light, climate, car status, parking, energy flow, tyre and traffic
sign screens).

Claude can read what the app shows, switch pages, cars, sides and themes, take screenshots of the head unit screen,
read and move ambient light / climate / car status points and touch areas (with undo), set the preview situation
(ambient colour, climate preset, vehicle messages, lights and vents on or off), and list, export and replace images.
Saving goes through the app: it shows you the list of changes and waits for you to confirm.

Your skin files stay in the browser. This server runs on your computer, listens only on `127.0.0.1`, and talks to
the page over a WebSocket after you pair it once with a code.

## Requirements

- Node.js 20 or newer, and git (npx fetches the server from GitHub).
- Chrome or Edge with the app open (https://mib2c.pqisa.eu, or your own copy of it).
- Claude Code, Claude Desktop, or another MCP client.

## Set up

**Claude Code**

```sh
claude mcp add mib2c -- npx -y github:TomasSlekys/mib2c-mcp
```

**Claude Desktop**: Settings › Developer › Edit Config, then add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mib2c": { "command": "npx", "args": ["-y", "github:TomasSlekys/mib2c-mcp"] }
  }
}
```

On Windows, if Claude Desktop can't start it, use `"command": "cmd", "args": ["/c", "npx", "-y", "github:TomasSlekys/mib2c-mcp"]`.

## Pair the page (once)

1. Open the app and your skins folder in it.
2. Ask Claude for the MIB2 Configurator pairing code (its `status` tool shows it), or run
   `npx -y github:TomasSlekys/mib2c-mcp --print-code`.
3. In the app, click **Claude** in the top bar, enter the code and **Connect**. The dot turns green.

The page remembers the code and reconnects by itself whenever Claude starts the server again. The code is kept in
`~/.config/mib2c-mcp/pairing.json` (Windows: `%APPDATA%\mib2c-mcp`). `--new-code` makes a new one; the page then
has to be paired again.

Chrome may ask whether the site may access devices on your local network: allow it, as that is how the page reaches
this server on your computer.

## Tools

| Tool | What it does |
| --- | --- |
| `status` | Connection state and the pairing code. Claude calls this first. |
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
mib2c-mcp [--port <n>] [--new-code] [--print-code]
```

| Setting | Default | |
| --- | --- | --- |
| `--port` / `MIB2C_PORT` | `47391` | WebSocket port on 127.0.0.1. Enter the same port in the app. |
| `MIB2C_ORIGINS` | | More page origins allowed to connect, comma-separated, `*` matches any part (e.g. `https://mib2c.example.home`). Always allowed: `https://mib2c.pqisa.eu`, `http://localhost:*`, `http://127.0.0.1:*`, `https://*.ddev.site`. |
| `MIB2C_CONFIG_DIR` | see above | Where the pairing code is kept. |

## Troubleshooting

- **The dot stays amber ("waiting")**: the server isn't running or uses another port. Ask Claude for `status`
  (Claude starts the server when it starts), and check the port.
- **"Port 47391 is taken"**: another Claude session already runs mib2c-mcp. Close it, or give this one another port
  (`MIB2C_PORT`) and enter that port in the app.
- **Red dot ("not paired")**: wrong code, or the code was renewed. Enter the code `status` shows.
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

The page must say hello with the pairing code within 5 seconds, from an allowed origin, or it is disconnected.
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

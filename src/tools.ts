// The tools Claude sees. Each one (except status) runs as a command on the connected MIB2 Configurator page; the
// page does the work with the app's own code, so its rules, undo history and save confirmation all apply.

import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type Bridge, NotConnected } from './bridge.js';

export const APP_URL = 'https://mib2c.pqisa.eu';

const page = z.enum(['ambient', 'climate', 'status', 'parking', 'energy', 'tyres', 'signs', 'images']);
const item = z
  .union([
    z.object({ point: z.number().int().describe('A feature / vent / part point by its id (get_scene_data lists them)') }),
    z.object({ zone: z.number().int().describe('A touch area by its index'), corner: z.number().int().optional().describe('One corner of it, by index') }),
  ])
  .describe('{"point": id} or {"zone": index} or {"zone": index, "corner": n}');
const items = z.array(item).min(1);
const imageRef = {
  index: z.number().int().optional().describe('The image index in images.mcf'),
  path: z.string().optional().describe('Or a path from images.res, e.g. "0203070200/GenericCarAdjuster/AmbianceLight/Interior_LHD.png"'),
};

// Compact JSON: coordinate lists stay on one line (fewer tokens for Claude to read).
const text = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const failure = (message: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text: message }] });

/** A page result: a picture becomes image content, the rest text. */
function toContent(result: unknown): CallToolResult {
  if (result && typeof result === 'object' && 'image' in result) {
    const { image, ...rest } = result as { image: { data: string; mimeType: string } };
    return { content: [{ type: 'image', data: image.data, mimeType: image.mimeType }, { type: 'text', text: JSON.stringify(rest) }] };
  }
  return text(result ?? 'Done.');
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_PICTURE = 32 * 1024 * 1024;

export function registerTools(server: McpServer, bridge: Bridge) {
  const howToConnect = () =>
    bridge.listenError
      ? bridge.listenError
      : `The MIB2 Configurator page is not connected. Ask the user to open the app (${APP_URL}) in Chrome or Edge with their skins folder. The first time only, they click "Claude" in the app's top bar and allow the browser's prompt (local network access)${bridge.port === 47391 ? '' : `, and enter port ${bridge.port} there`}; after that the page connects by itself within a few seconds whenever this server runs.`;

  /** Runs a page command and turns what comes back (or the failure) into a tool result. */
  const run = async (method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<CallToolResult> => {
    try {
      return toContent(await bridge.call(method, params, timeoutMs));
    } catch (e) {
      if (e instanceof NotConnected) return failure([e.message, howToConnect()].filter(Boolean).join(' '));
      return failure(e instanceof Error ? e.message : String(e));
    }
  };

  server.registerTool(
    'status',
    {
      title: 'Connection status',
      description: 'Whether the MIB2 Configurator page is connected, and how the user connects it if not. Call this first.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const page = bridge.connected;
      if (!page) return text({ connected: false, port: bridge.port, app: APP_URL, howToConnect: howToConnect() });
      return text({ connected: true, page: { app: page.version, origin: page.origin, since: page.since.toISOString() }, port: bridge.port });
    },
  );

  server.registerTool(
    'get_state',
    {
      title: 'App state',
      description:
        'What the app shows now: the open skin and its head unit, the theme skin, the page, View / Edit mode, the car and driving side, unsaved changes (replaced images, moved positions per data file) and undo availability.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run('get_state'),
  );

  server.registerTool(
    'list_cars',
    {
      title: 'List cars',
      description: "The cars a page has pictures for (car codes such as 0203070200 = VW Golf 7 estate, with names where known), each with its driving sides on the interior pages and whether it has unsaved changes.",
      inputSchema: { page: page.optional().describe('Default: the page shown now') },
      annotations: { readOnlyHint: true },
    },
    (a) => run('list_cars', a),
  );

  server.registerTool(
    'navigate',
    {
      title: 'Navigate',
      description:
        'Changes what the app shows: page (ambient light, climate, car status, parking, energy flow, tyres, traffic signs, all images), car, driving side, View or Edit mode, theme skin, the head unit UI around the picture (uiElements), and on the interior pages the screen view (frame). Returns the new state.',
      inputSchema: {
        page: page.optional(),
        car: z.string().optional().describe('Car code, from list_cars'),
        side: z.enum(['LHD', 'RHD']).optional(),
        mode: z.enum(['view', 'edit']).optional().describe('View: the car side (click changes what the car reports). Edit: positions can be moved'),
        theme: z.string().optional().describe('Theme skin name (skin1, skin2…) for the head unit UI, or "none"'),
        uiElements: z.boolean().optional().describe('Draw the head unit screen UI around the picture (needs a theme skin)'),
        frame: z.union([z.literal('whole'), z.literal('default'), z.number().int()]).optional().describe('Interior pages: the whole picture, the default screen view, or a view level'),
      },
    },
    (a) => run('navigate', a),
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot',
      description:
        "A picture of the page's screen as the app draws it (the head unit's screen, or the picture with its lights, vents, parts and zone outlines). Drag handles and labels drawn as HTML are not included.",
      inputSchema: {
        maxWidth: z.number().int().min(100).max(4096).optional().describe('Cap on the width in pixels (default: the screen or picture at its own resolution, at most 2560)'),
        overlays: z.boolean().optional().describe('Include SVG overlays such as zone outlines and screen controls (default true)'),
      },
      annotations: { readOnlyHint: true },
    },
    (a) => run('screenshot', a),
  );

  server.registerTool(
    'get_scene_data',
    {
      title: 'Zone file data',
      description:
        "The ambient light, climate or car status page's zone file for the shown car and side: touch areas (corners), feature / vent / part points with names, positions (and the saved ones when moved), their images and sizes, what the preview shows, screen views, undo state. Coordinates are picture pixels from the top-left; a point is its image's top-left corner.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run('get_scene_data'),
  );

  server.registerTool(
    'move_items',
    {
      title: 'Move points or touch areas',
      description:
        'Moves zone file items on the interior page shown (ambient light, climate, car status), kept inside the picture; one undo step. Either dx / dy (move all items together) or x / y (place one item: a point by its top-left, a touch area by its bounding box top-left, a corner exactly). Unsaved until save.',
      inputSchema: {
        items,
        dx: z.number().optional(),
        dy: z.number().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
      },
    },
    (a) => run('move_items', a),
  );

  server.registerTool(
    'align_items',
    {
      title: 'Align items',
      description: "Lines up two or more items' boxes on one edge or centre line of the box around them all (as the app's inspector does); one undo step.",
      inputSchema: { items, edge: z.enum(['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom']) },
    },
    (a) => run('align_items', a),
  );

  server.registerTool(
    'distribute_items',
    {
      title: 'Spread items out',
      description: 'Spreads three or more items so the gaps between their boxes are equal; the first and last stay. One undo step.',
      inputSchema: { items, axis: z.enum(['x', 'y']) },
    },
    (a) => run('distribute_items', a),
  );

  for (const dir of ['undo', 'redo'] as const) {
    server.registerTool(
      dir,
      {
        title: dir === 'undo' ? 'Undo' : 'Redo',
        description: `${dir === 'undo' ? 'Undoes' : 'Redoes'} one position edit: in the zone file shown, or in the data file named (a path from get_state's unsaved files: .gca, carstatus.car, parking .ops, energy flow .efl).`,
        inputSchema: { file: z.string().optional() },
      },
      (a) => run(dir, a),
    );
  }

  server.registerTool(
    'get_preview',
    {
      title: 'Preview situation',
      description: 'What the car reports in the preview: ambient light colour, brightness and mode; climate preset, fan, temperatures, air (cooling / venting / heating) and automatic distribution; car status messages, readiness and start-stop; lights or vents switched off.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run('get_preview'),
  );

  server.registerTool(
    'set_preview',
    {
      title: 'Set preview situation',
      description:
        'Sets what the car reports in the preview (nothing is written to the skin): ambient light, climate, car status, and which ambient lights or climate vents are on (page shown). Take a screenshot after to see it.',
      inputSchema: {
        ambient: z
          .object({
            colour: z.string().optional().describe('Any-colour cars: hex such as #ff8800'),
            model: z.enum(['rgb', 'f20']).optional().describe('rgb: any colour; f20: the six-colour list'),
            palette: z.number().int().min(0).max(6).optional().describe('f20 list entry, 0 = off'),
            brightness: z.number().min(0).max(100).optional(),
            mode: z.enum(['off', 'automatic', 'manual']).optional(),
            white: z.array(z.number().int()).optional().describe('Feature ids whose area is not in colour'),
          })
          .optional(),
        climate: z
          .object({
            preset: z
              .enum(['auto', 'manual', 'defrost', 'maxac'])
              .optional()
              .describe('auto: automatic air distribution, every front vent in the paler colour (firmware); defrost / maxac open the vents a car likely would (best guess)'),
            profile: z.enum(['soft', 'medium', 'intensive']).optional(),
            left: z.number().optional().describe('°C, 15.5 to 30'),
            right: z.number().optional(),
            air: z.enum(['cold', 'neutral', 'warm']).optional().describe('The vents\' colour: cold = cooling (blue), neutral = venting (white), warm = heating (red)'),
            autoDistribution: z.boolean().optional().describe('Automatic air distribution: the vents in the paler colour of their pair'),
          })
          .optional(),
        status: z
          .object({
            messages: z.array(z.number().int()).optional().describe('Vehicle message ids (replaces the list); find_vehicle_messages finds them'),
            readiness: z.enum(['ready', 'initialising', 'unavailable']).optional(),
            startStop: z.boolean().optional(),
          })
          .optional(),
        points: z
          .object({
            all: z.enum(['on', 'off']).optional(),
            on: z.array(z.number().int()).optional(),
            off: z.array(z.number().int()).optional(),
          })
          .optional()
          .describe('Ambient light and climate pages: switch lights / vents by point id'),
      },
    },
    (a) => run('set_preview', a),
  );

  server.registerTool(
    'find_vehicle_messages',
    {
      title: 'Find vehicle messages',
      description: "The head unit's 453 vehicle messages (car status): each lights one part in a state (info, warning, stop). Search by text, part id or state.",
      inputSchema: {
        query: z.string().optional(),
        part: z.number().int().optional(),
        state: z.enum(['none', 'info', 'warning', 'stop']).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (a) => run('find_vehicle_messages', a),
  );

  server.registerTool(
    'list_images',
    {
      title: 'List images',
      description: "Images in the skin's images.mcf whose path contains the query, with their index, every path that uses them (an image can be shared), and any unsaved replacement.",
      inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() },
      annotations: { readOnlyHint: true },
    },
    (a) => run('list_images', a),
  );

  server.registerTool(
    'get_image',
    {
      title: 'Get image',
      description: 'One image from the skin as PNG: as stored ("current") or its unsaved replacement ("new", the default when there is one).',
      inputSchema: { ...imageRef, which: z.enum(['current', 'new']).optional() },
      annotations: { readOnlyHint: true },
    },
    (a) => run('get_image', a),
  );

  server.registerTool(
    'replace_image',
    {
      title: 'Replace image',
      description:
        'Replaces one image of the skin with a picture file on this computer (PNG, JPEG or WebP), stored in the image\'s format. It must have the image\'s size (only ambient feature images may change size) unless fit is "fit", "fill" or "stretch". A shared image changes everywhere it is used. Unsaved until save; revert_image takes it back.',
      inputSchema: {
        ...imageRef,
        file: z.string().describe('Path of the picture file on this computer'),
        fit: z.enum(['exact', 'fit', 'fill', 'stretch']).optional().describe('exact (default): as it is; fit: whole picture inside; fill: cover, cropping; stretch: distort to the size'),
      },
    },
    async ({ file, ...a }) => {
      const path = resolve(file);
      const type = IMAGE_TYPES[extname(path).toLowerCase()];
      if (!type) return failure('The file must be a .png, .jpg, .jpeg or .webp picture.');
      try {
        const info = await stat(path);
        if (info.size > MAX_PICTURE) return failure(`${path} is over ${MAX_PICTURE / 1024 / 1024} MB.`);
        const data = (await readFile(path)).toString('base64');
        return run('replace_image', { ...a, data, fileName: path.split(/[\\/]/).pop() }, 120_000);
      } catch (e) {
        return failure(`Couldn't read ${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    'revert_image',
    {
      title: 'Revert image',
      description: "Takes back an image's unsaved replacement.",
      inputSchema: imageRef,
    },
    (a) => run('revert_image', a),
  );

  server.registerTool(
    'save',
    {
      title: 'Save',
      description:
        "Saves every unsaved change into the skin folder (or downloads the files where the browser can't write to it). The app first shows the user the list of changes and waits for them to confirm there, so this can take a while; it reports whether they saved or cancelled. A .backup of each file is kept before its first save.",
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    () => run('save', {}, 15 * 60_000),
  );
}

export const INSTRUCTIONS = `This server drives the MIB2 Configurator web app (${APP_URL}) open in the user's browser: a tool for VW MIB2 head unit skins (ambient light, climate, car status, parking, energy flow, tyre and traffic sign screens).
- Call status first. If the page isn't connected, tell the user how to connect it (the status result says how).
- The user must open their skins folder in the app themselves; the browser doesn't let anything else pick it.
- get_state says what is shown; navigate changes it; screenshot shows it. On the ambient light, climate and car status pages, get_scene_data lists the zone file's points and touch areas, and move_items / align_items / distribute_items move them (undo / redo take a step back).
- Preview settings (set_preview) only change what is drawn. Edits and replaced images stay unsaved until save, which asks the user to confirm in the app. Don't save unless the user asked for it.
- Car names marked unconfirmed, and point or area names marked guessed, are the app's best guesses.`;

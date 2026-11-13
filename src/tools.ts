// The tools the AI assistant sees. Each one (except status) runs as a command on the connected MIB2 Configurator page; the
// page does the work with the app's own code, so its rules, undo history and save confirmation all apply.

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type Bridge, NotConnected } from './bridge.js';

export const APP_URL = 'https://pqisa.eu/mib2c/';

const page = z.enum(['ambient', 'climate', 'status', 'parking', 'energy', 'tyres', 'signs', 'vehicle', 'images']);
const item = z
  .union([
    z.object({ point: z.number().int().describe('A feature / vent / part point by its id (get_scene_data lists them)') }),
    z.object({ zone: z.number().int().describe('A touch area by its index'), corner: z.number().int().optional().describe('One corner of it, by index') }),
  ])
  .describe('{"point": id} or {"zone": index} or {"zone": index, "corner": n}');
const items = z.array(item).min(1);
const imageRef = {
  index: z.number().int().optional().describe('The image index in images.mcf (with theme: the bitmap index in the theme skin\'s images.mcf)'),
  path: z.string().optional().describe('Or a path from images.res, e.g. "0203070200/GenericCarAdjuster/AmbianceLight/Interior_LHD.png"'),
  theme: z.boolean().optional().describe('An image of the open theme skin (skin1…): the Vehicle screens\' dials, buttons, backgrounds and other UI pictures'),
  viewImage: z.number().int().optional().describe('With theme: the view image id (list_screen_items, find_image_usage), instead of index'),
  night: z.boolean().optional().describe('With viewImage: its night bitmap'),
};
const placement = z
  .object({
    scale: z.number().positive().max(50).optional().describe('Scale around the slot\'s centre, after fit'),
    dx: z.number().optional().describe('Then move right by this many image pixels'),
    dy: z.number().optional().describe('Then move down'),
  })
  .optional()
  .describe('Place the picture by hand, as the replace window\'s zoom and drag (with fit "exact" it starts at actual size, centred)');
const fit = z.enum(['exact', 'actual', 'fit', 'fill', 'stretch']);

// Compact JSON: coordinate lists stay on one line (fewer tokens for the assistant to read).
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
      : `The MIB2 Configurator page is not connected. Ask the user to open the app (${APP_URL}) in Chrome or Edge with their skins folder. The first time only, they click "MCP" in the app's top bar and allow the browser's prompt (local network access)${bridge.port === 47391 ? '' : `, and enter port ${bridge.port} there`}; after that the page connects by itself within a few seconds whenever this server runs.`;

  const failed = (e: unknown) =>
    e instanceof NotConnected ? failure([e.message, howToConnect()].filter(Boolean).join(' ')) : failure(e instanceof Error ? e.message : String(e));

  /** Runs a page command and writes the picture it returns to `file` (a PNG); answers with the rest. */
  const runToFile = async (method: string, params: Record<string, unknown>, file: string): Promise<CallToolResult> => {
    const path = resolve(file.endsWith('.png') ? file : `${file}.png`);
    try {
      const { image, ...rest } = (await bridge.call(method, params, 60_000)) as { image: { data: string } };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(image.data, 'base64'));
      return text({ file: path, ...rest });
    } catch (e) {
      return failed(e);
    }
  };

  /** A picture file from this computer, as the page's replace_image wants it. */
  const readPicture = async (file: string) => {
    const path = resolve(file);
    if (!IMAGE_TYPES[extname(path).toLowerCase()]) throw new Error(`${path}: the file must be a .png, .jpg, .jpeg or .webp picture.`);
    const info = await stat(path);
    if (info.size > MAX_PICTURE) throw new Error(`${path} is over ${MAX_PICTURE / 1024 / 1024} MB.`);
    return { data: (await readFile(path)).toString('base64'), fileName: basename(path), path };
  };

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
        screen: z
          .string()
          .optional()
          .describe(
            "A screen by its id from get_state's screens (instead of page): Vehicle menu screens (status, tyres, perfmon, laptimer, energy, range, zeroemission, recuperation, offroad, offroad-setup, cockpit, cockpit-setup = Vehicle settings, eco, bc1-bc3, school, tbt-trip…), pureair, signs, upcoming:<key> (screens not built yet), progress",
          ),
      },
    },
    (a) => run('navigate', a),
  );

  const control = {
    id: z.string().optional().describe('The id from list_controls (stays while the control is shown)'),
    label: z.string().optional().describe('Or its label (exact, else a unique part of it)'),
    where: z.string().optional().describe('With label: only controls in this place (e.g. "unit screen", "Pages", a panel name)'),
  };
  server.registerTool(
    'list_controls',
    {
      title: 'List controls',
      description:
        "Every control the user could use on the page now: the head unit screen's buttons and sliders (where \"unit screen\", box in screen pixels), the page menu, the side panels' settings (what the car reports, layers, status line…), open popups. Each has an id, role, label, where it is and its state (pressed, checked, current, value, min / max, options). Save buttons, confirmation dialogs, the MCP menu, sign-in and reports are left out.",
      inputSchema: {
        where: z.string().optional().describe('Only controls in this place, e.g. "unit screen" (the head unit screen)'),
        query: z.string().optional().describe('Only controls whose label contains this'),
      },
      annotations: { readOnlyHint: true },
    },
    (a) => run('list_controls', a),
  );

  server.registerTool(
    'press',
    {
      title: 'Press a control',
      description:
        'Clicks a control as the user would: a screen button (opens sub-screens, pages, popups as on the unit), a menu entry, a radio or checkbox in a side panel. By id, by label, or at a point of the head unit screen. Returns what was pressed and the new state; take a screenshot to see it.',
      inputSchema: {
        ...control,
        at: z.object({ x: z.number(), y: z.number() }).optional().describe('Or the screen control at this point (screen pixels, as screenshot and find_item_at use them)'),
      },
    },
    (a) => run('press', a),
  );

  server.registerTool(
    'set_control',
    {
      title: 'Set a control',
      description: 'Sets a slider or number (stepped as with the arrow keys), a text field, a checkbox (true / false) or a list (an option by its text) to a value. Returns the control and the new state.',
      inputSchema: {
        ...control,
        value: z.union([z.number(), z.string(), z.boolean()]),
      },
    },
    (a) => run('set_control', a, 60_000),
  );

  server.registerTool(
    'screenshot',
    {
      title: 'Screenshot',
      description:
        "A picture of the page's screen as the app draws it (the head unit's screen, or the picture with its lights, vents, parts and zone outlines). labels draws point ids and touch area outlines with their names (interior pages). region + zoom shows a part up close. pictureBox in the answer says where the picture sits in the screenshot (x, y, pixels per picture pixel). With file, the PNG is written there instead of shown.",
      inputSchema: {
        maxWidth: z.number().int().min(100).max(4096).optional().describe('Cap on the width in pixels (default: the screen or picture at its own resolution, at most 2560)'),
        overlays: z.boolean().optional().describe('Include SVG overlays such as zone outlines and screen controls (default true)'),
        labels: z.boolean().optional().describe('Draw point ids (with their image boxes) and touch areas (outline, index, name) on the picture'),
        region: z
          .object({
            x: z.number(),
            y: z.number(),
            width: z.number().positive(),
            height: z.number().positive(),
            in: z.enum(['picture', 'screen']).optional().describe('picture (default): picture pixels, as get_scene_data gives them; screen: pixels of the full screenshot'),
          })
          .optional()
          .describe('Only this part'),
        zoom: z.number().min(1).max(8).optional().describe('Enlarge pixel for pixel (with region: a close look)'),
        file: z.string().optional().describe('Write the PNG to this path on this computer instead of returning it'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ file, ...a }) => (file ? runToFile('screenshot', a, file) : run('screenshot', a)),
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

  const place = z
    .union([
      z.object({ point: z.number().int(), x: z.number().optional(), y: z.number().optional() }),
      z.object({ zone: z.number().int(), corner: z.number().int().optional(), x: z.number().optional(), y: z.number().optional() }),
    ])
    .describe('{"point": id, "x", "y"} (its image top-left) or {"zone": index, "x", "y"} (bounding box top-left) or {"zone": index, "corner": n, "x", "y"}');

  server.registerTool(
    'set_points',
    {
      title: 'Place many items',
      description: 'Puts many points, touch areas or corners at exact positions in one step (one undo step), on the interior page shown. Picture pixels; kept inside the picture.',
      inputSchema: { items: z.array(place).min(1) },
    },
    (a) => run('set_points', a),
  );

  server.registerTool(
    'reset_items',
    {
      title: 'Reset items',
      description: 'Puts the given points or touch areas back where the saved file has them (one undo step). A corner puts its whole touch area back.',
      inputSchema: { items },
    },
    (a) => run('reset_items', a),
  );

  server.registerTool(
    'revert_file',
    {
      title: 'Revert a file',
      description: "Puts a whole data file back as saved (one undo step, so undo brings the edits back): the zone file shown, or the file named (a path from get_state's unsaved files: .gca, carstatus.car, .ops, .efl).",
      inputSchema: { file: z.string().optional() },
    },
    (a) => run('revert_file', a),
  );

  const carSide = z.object({ car: z.string().optional().describe('Car code (default: the car shown)'), side: z.enum(['LHD', 'RHD']).optional() }).optional();
  server.registerTool(
    'copy_points',
    {
      title: 'Copy points to another side or car',
      description:
        "Copies the interior page's point and touch area positions from one car / side to another, in one undo step in the target file: points by id, touch areas by order. Between driving sides they are mirrored (by default); to a picture of another size they are scaled (by default). Default: from the car and side shown, to the other side of the same car.",
      inputSchema: {
        from: carSide,
        to: carSide,
        mirror: z.boolean().optional(),
        scale: z.boolean().optional(),
        what: z.enum(['all', 'points', 'zones']).optional(),
        points: z.array(z.number().int()).optional().describe('Only these point ids'),
      },
    },
    (a) => run('copy_points', a, 60_000),
  );

  server.registerTool(
    'get_changes',
    {
      title: 'Unsaved changes',
      description: 'Everything that save would write: each replaced image (with the file it came from) and every moved point, touch area, parking or energy flow position, with its saved and new place.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run('get_changes'),
  );

  server.registerTool(
    'check_skin',
    {
      title: 'Check before saving',
      description: "Checks the edited zone files (and the one shown): whether the head unit loads each file, and points or touch areas that reach outside their picture or are too small to press. Errors would break the screen on the unit; warnings are worth a look.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run('check_skin', {}, 60_000),
  );

  server.registerTool(
    'get_parking_data',
    {
      title: 'Parking file',
      description:
        "The parking page's layout file (config_mini.ops / config.ops) for the car shown: sectors with their bands, background pieces and car image positions (with saved places when moved), the sensors by group, and the preview. Open the parking page first.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run('get_parking_data'),
  );

  server.registerTool(
    'move_parking',
    {
      title: 'Move parking positions',
      description: 'Moves parking sectors (all their bands), background pieces or car image positions by dx / dy (stored left-half pixels; the right half follows mirrored). One undo step. Unsaved until save.',
      inputSchema: {
        items: z.array(z.union([z.object({ sector: z.number().int() }), z.object({ piece: z.number().int() }), z.object({ position: z.number().int() })])).min(1),
        dx: z.number().optional(),
        dy: z.number().optional(),
      },
    },
    (a) => run('move_parking', a),
  );

  server.registerTool(
    'set_parking_preview',
    {
      title: 'Parking preview',
      description: 'What the car reports on the parking page (nothing is written): layout, 360° side sensors, rear traffic alert, trailer, obstacles per sensor, faults per group, guide lines and steering, the area view side.',
      inputSchema: {
        layout: z.enum(['mini', 'full', 'rear', 'area']).optional().describe('mini: pop-up (with camera), full: full screen, rear: rear sensors only, area: area view'),
        show360: z.boolean().optional(),
        rta: z.boolean().optional().describe('Rear traffic alert fitted'),
        trailer: z.boolean().optional(),
        obstacles: z.array(z.object({ sensor: z.number().int().min(0).max(15), distance: z.number() })).optional().describe('Replaces the obstacles: per sensor (get_parking_data lists them by group) its distance in cm'),
        faults: z.array(z.enum(['ok', 'error', 'unavailable'])).length(4).optional().describe('Front, left side, right side, rear'),
        rtaAlert: z.array(z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(15)])).length(2).optional().describe('Left, right: 1 none, 2 low, 3 hard, 15 error'),
        level: z.union([z.literal('auto'), z.literal(1), z.literal(2), z.literal(3)]).optional(),
        keepGrey: z.boolean().optional(),
        guides: z.enum(['off', 'forward', 'reverse']).optional(),
        steer: z.number().min(-100).max(100).optional(),
        activeSide: z.string().optional().describe('Area view: none or a side name'),
        ground: z.boolean().optional(),
        clear: z.boolean().optional().describe('Remove obstacles, faults and alerts first'),
      },
    },
    (a) => run('set_parking_preview', a),
  );

  server.registerTool(
    'get_energy_data',
    {
      title: 'Energy flow file',
      description: "The energy flow page's file (config_BEV.efl / config_PHEV.efl) for the car shown: car picture, features (battery, engine, e-motor) and flows (tracks, masks, wheel rings) with names and saved places when moved, and the preview. Open the energy flow page first.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run('get_energy_data'),
  );

  server.registerTool(
    'move_energy',
    {
      title: 'Move energy flow positions',
      description: 'Moves the car picture, features or flows of the energy flow file by dx / dy (one undo step). A track and its mask usually move together. Unsaved until save.',
      inputSchema: {
        items: z.array(z.union([z.object({ car: z.literal(true) }), z.object({ feature: z.number().int() }), z.object({ flow: z.number().int() })])).min(1),
        dx: z.number().optional(),
        dy: z.number().optional(),
      },
    },
    (a) => run('move_energy', a),
  );

  server.registerTool(
    'set_energy_preview',
    {
      title: 'Energy flow preview',
      description: 'What the car reports on the energy flow page (nothing is written): kind (BEV / PHEV), situation, parts on or off, battery flow and charge, movement.',
      inputSchema: {
        kind: z.enum(['BEV', 'PHEV']).optional(),
        situation: z.enum(['none', 'electric', 'engine', 'boost', 'recuperation', 'sailing']).optional(),
        engine: z.boolean().optional(),
        motor: z.boolean().optional(),
        battery: z.boolean().optional(),
        batteryFlow: z.enum(['off', 'pos', 'neg']).optional().describe('pos: out of the battery, neg: into it'),
        charge: z.number().min(0).max(100).optional(),
        moving: z.boolean().optional(),
      },
    },
    (a) => run('set_energy_preview', a),
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
            brightness: z.number().min(0).max(100).optional().describe('Every area (clears per-area values)'),
            areas: z.record(z.string(), z.number().min(0).max(100).nullable()).optional().describe('One area\'s brightness by feature id, e.g. {"5": 40}; null takes it back to the overall one'),
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
      description:
        "Images in the skin's images.mcf whose path contains the query, with their index, every path that uses them (an image can be shared), and any unsaved replacement. With theme: the open theme skin's bitmaps by index (from, limit) with the view images drawn from each; replaced: only those with a replacement.",
      inputSchema: {
        query: z.string().optional(),
        limit: z.number().int().min(0).max(10000).optional(),
        theme: z.boolean().optional(),
        from: z.number().int().min(0).optional().describe('With theme: the first bitmap index'),
        replaced: z.boolean().optional().describe('With theme: only replaced bitmaps'),
      },
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
    'export_image',
    {
      title: 'Export image',
      description:
        'Writes one image of the skin to a PNG file on this computer (as stored, or its unsaved replacement): to edit it in another tool, then bring it back with replace_image.',
      inputSchema: { ...imageRef, which: z.enum(['current', 'new']).optional(), file: z.string().describe('Where to write the PNG (folders are made)') },
    },
    ({ file, ...a }) => runToFile('get_image', a, file),
  );

  server.registerTool(
    'replace_images',
    {
      title: 'Replace images',
      description:
        'Replaces several images at once from picture files on this computer, each matched by its file name to the image of that name whose path contains scope (such as "0204080200/GenericCarAdjuster/AmbianceLight/" or a car code). A file that matches no image, or several different ones, is skipped and listed; an image shared by several cars counts once. Unsaved until save.',
      inputSchema: {
        folder: z.string().optional().describe('Every .png / .jpg / .webp in this folder'),
        files: z.array(z.string()).optional().describe('Or these files'),
        scope: z.string().min(1).describe('Part of the image paths to look in (a car code, or a folder of it)'),
        fit: fit.optional(),
      },
    },
    async ({ folder, files, scope, fit }) => {
      try {
        let list = files ?? [];
        if (folder) list = [...list, ...(await readdir(resolve(folder))).filter((f) => IMAGE_TYPES[extname(f).toLowerCase()]).map((f) => join(resolve(folder), f))];
        if (list.length === 0) return failure('No picture files: give "folder" or "files".');
        const found = (await bridge.call('list_images', { query: scope, limit: 10_000 })) as { images: { index: number; paths: string[] }[] };
        const part = scope.toLowerCase();
        const replaced: { file: string; index: number; path: string }[] = [];
        const skipped: { file: string; reason: string }[] = [];
        for (const file of list) {
          const name = basename(file).toLowerCase();
          const hits = found.images
            .map((img) => ({ index: img.index, path: img.paths.find((p) => p.toLowerCase().includes(part) && p.split('/').pop()!.toLowerCase() === name) }))
            .filter((h): h is { index: number; path: string } => !!h.path);
          if (hits.length === 0) {
            skipped.push({ file, reason: `no image named ${basename(file)} with "${scope}" in its path` });
            continue;
          }
          if (hits.length > 1) {
            skipped.push({ file, reason: `several images match: ${hits.map((h) => h.path).join(', ')}; narrow the scope` });
            continue;
          }
          try {
            const pic = await readPicture(file);
            await bridge.call('replace_image', { index: hits[0].index, data: pic.data, fileName: pic.fileName, fit }, 120_000);
            replaced.push({ file, index: hits[0].index, path: hits[0].path });
          } catch (e) {
            if (e instanceof NotConnected) throw e;
            skipped.push({ file, reason: e instanceof Error ? e.message : String(e) });
          }
        }
        return text({ replaced, skipped, unsaved: replaced.length > 0 });
      } catch (e) {
        return failed(e);
      }
    },
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
        fit: fit.optional().describe('exact (default): as it is; actual: actual size, centred in the slot; fit: whole picture inside; fill: cover, cropping; stretch: distort to the size'),
        placement,
      },
    },
    async ({ file, ...a }) => {
      let pic: Awaited<ReturnType<typeof readPicture>>;
      try {
        pic = await readPicture(file);
      } catch (e) {
        return failure(`Couldn't read ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return run('replace_image', { ...a, data: pic.data, fileName: pic.fileName }, 120_000);
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
    'swap_images',
    {
      title: 'Swap two images',
      description:
        'Two images of the skin trade pictures (each gets the other\'s unsaved replacement if it has one, else its picture as stored), as unsaved replacements: unsaved until save; swapping them again, or revert_image, takes them back. By default their places trade too where the shown page stores them (ambient light / climate / car status zone file points, parking car and trailer positions, energy flow positions; one undo step), so the screen looks the same right after the swap and only which light or part owns which picture changes; keepPlaces: true trades only the pictures, so they appear in each other\'s spots. Images whose places the firmware fixes (or swapped from another page) only trade pictures. An image that must keep its size gets the other picture fitted into it. A shared image changes for every car using it, but the other cars\' places are not changed (the result notes this).',
      inputSchema: {
        a: z.union([z.number(), z.string()]).describe('The first image: its index, or a path from list_images'),
        b: z.union([z.number(), z.string()]).describe('The second image: index or path'),
        keepPlaces: z.boolean().optional().describe('true: only the pictures trade, the places stay (default false: places trade too)'),
      },
    },
    (a) => run('swap_images', a, 120_000),
  );

  server.registerTool(
    'swap_zones',
    {
      title: 'Swap two touch areas',
      description:
        "On the shown ambient light page (or any zone file with touch areas), two touch areas trade outlines: every corner, so their places and shapes swap while each keeps its button id (what the car maps to). Both need the same number of corners. One undo step; unsaved until save. Zone indexes as get_scene_data lists them.",
      inputSchema: {
        a: z.number().int().describe('The first touch area (zone index)'),
        b: z.number().int().describe('The second touch area (zone index)'),
      },
    },
    (a) => run('swap_zones', a),
  );

  // ---- Dev information (read-only): the firmware's names and numbers for what the screens draw. Works with the app's
  // Dev view switch on or off; built from the app's build-time firmware data (MIB2 Standard debug jar).
  const screenArg = z.string().optional().describe('Which shown screen (its name or view, e.g. "Offroad" or "Cmop"); default: the one shown');

  server.registerTool(
    'get_dev_info',
    {
      title: 'Dev info of the screen',
      description:
        "The firmware identity of the head unit screen shown now (Vehicle pages and the Vehicle settings sub-screens, ambient light, climate, car status, tyres, energy flow, parking, traffic signs, and the screens shown as coming-soon pages): view name and class (generated/de/vw/mib/.../view/internal/<View>), ViewsTable model name, internal view id, the state machine states that show it (with their parent path), every event of its buttons (EID_..., id, the widget eventSender, the widgets that send it as registered in the view's ROM, the transitions they take and the view they lead to), the datapool values the screen reads where the app knows them (id, meaning, property name), the theme skin and the frame file.",
      inputSchema: { screen: screenArg },
      annotations: { readOnlyHint: true },
    },
    (a) => run('get_dev_info', a),
  );

  server.registerTool(
    'list_screen_items',
    {
      title: 'List screen items',
      description:
        "Everything the shown screen draws now, in drawing order (later is on top): widget key path, type (img, text, content area, page-drawn image, car picture, data skin picture by path), rect in screen pixels (800 x 480), view image id -> bitmap index in images.mcf (and the widget's image arrays + button state), string reference (i18n string id or string array + index) -> text in the UI language, font file + size, colour ('accent' = the unit's dynamic colour), alpha, the widget type and index, and the events a button sends (with the out event that sends each: released, pressed, dropDownOpened …). Filter matches any text in an item (key, text, ids).",
      inputSchema: {
        screen: screenArg,
        filter: z.string().optional().describe('Only items whose description contains this (case-insensitive), e.g. "Button_Setup" or "1311"'),
        type: z.enum(['img', 'text', 'content', 'image', 'car', 'data']).optional(),
        limit: z.number().int().min(1).max(2000).optional().describe('Default 200'),
      },
      annotations: { readOnlyHint: true },
    },
    (a) => run('list_screen_items', a),
  );

  server.registerTool(
    'find_item_at',
    {
      title: 'Find item at a point',
      description: 'The items drawn at a point of the shown screen (screen pixels, 800 x 480 on MIB2 Standard), topmost first, described as in list_screen_items.',
      inputSchema: { x: z.number(), y: z.number(), screen: screenArg },
      annotations: { readOnlyHint: true },
    },
    (a) => run('find_item_at', a),
  );

  server.registerTool(
    'list_strings',
    {
      title: 'List screen strings',
      description: 'Every string the shown screen shows: its reference (i18n string id, or string array + index; "runtime" for texts the car fills, shown as samples) -> text in the UI language, the widget key, and optionally the same strings in other languages of the theme skin.',
      inputSchema: {
        screen: screenArg,
        languages: z.union([z.literal('all'), z.array(z.string())]).optional().describe('Other languages to add, e.g. ["de_DE", "fr_FR"], or "all"'),
      },
      annotations: { readOnlyHint: true },
    },
    (a) => run('list_strings', a),
  );

  server.registerTool(
    'find_view',
    {
      title: 'Find firmware view',
      description: 'Looks up the firmware views the app draws by view name (Cmop), ViewsTable model name (CAR_MAIN_OFFROAD_PQ), internal view id (36), class or state machine state (vCAR_TBT_TRIP2): class, model, view id, frame file, states.',
      inputSchema: { query: z.union([z.string(), z.number()]) },
      annotations: { readOnlyHint: true },
    },
    (a) => run('find_view', a),
  );

  server.registerTool(
    'find_string',
    {
      title: 'Find string usage',
      description: 'Which screens and widgets use a string: by text (in the UI language, needs a theme skin open), by i18n string id, or by string array + index. Searches every MIB2 Standard frame the app has (not only the shown screen).',
      inputSchema: {
        text: z.string().optional(),
        string: z.number().int().optional().describe('An i18n string id'),
        array: z.number().int().optional().describe('A string array id'),
        index: z.number().int().optional().describe('The index in the array (default 0)'),
      },
      annotations: { readOnlyHint: true },
    },
    (a) => run('find_string', a),
  );

  server.registerTool(
    'find_image_usage',
    {
      title: 'Find image usage',
      description: 'Which screens and widgets use a theme picture: by view image id, or by bitmap index in the theme skin\'s images.mcf (needs a theme skin open; also lists the view image ids drawn from that bitmap). Searches every MIB2 Standard frame the app has.',
      inputSchema: { id: z.number().int().optional().describe('A view image id'), bitmap: z.number().int().optional().describe('An images.mcf index') },
      annotations: { readOnlyHint: true },
    },
    (a) => run('find_image_usage', a),
  );

  server.registerTool(
    'get_page_preview',
    {
      title: 'Page preview values',
      description:
        "The open Vehicle page's preview values (what the car reports): Tyres, Traffic signs, Sport, Car computer, Eco assist, Think Blue, E-traction, Offroad, Cockpit, Pure Air, Vehicle settings (also which settings sub-screen is open). Each field has its value, meaning, choices / keys / min / max, or readOnly. Interior pages use get_preview; parking and energy flow their own tools.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run('get_page_preview'),
  );

  server.registerTool(
    'set_page_preview',
    {
      title: 'Set page preview values',
      description:
        'Sets fields of the open page\'s preview (names and allowed values from get_page_preview): {"values": {"field": value, …}}; a record field takes only the keys to change. All are checked before any is set. Only the drawing changes; take a screenshot after.',
      inputSchema: { values: z.record(z.string(), z.unknown()) },
    },
    (a) => run('set_page_preview', a),
  );

  server.registerTool(
    'get_layers',
    {
      title: 'Layers',
      description: "The page's layers as its Layers panel lists them (groups, each layer's id, name, whether it is shown and, in Edit mode, locked).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run('get_layers'),
  );

  server.registerTool(
    'set_layers',
    {
      title: 'Show, hide or lock layers',
      description: 'Shows or hides layers of the page (to look at one part alone in a screenshot), or locks / unlocks them in Edit mode. Only the view changes.',
      inputSchema: {
        show: z.array(z.string()).optional(),
        hide: z.array(z.string()).optional(),
        lock: z.array(z.string()).optional(),
        unlock: z.array(z.string()).optional(),
        showAll: z.boolean().optional(),
      },
    },
    (a) => run('set_layers', a),
  );

  server.registerTool(
    'get_screen',
    {
      title: 'Screen settings',
      description: "How the app draws every screen: the theme's accent colour, Live (values moving as on a drive), the hand near the screen, Dev view, and on the car status page what the drawing rests on.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run('get_screen'),
  );

  server.registerTool(
    'set_screen',
    {
      title: 'Set screen settings',
      description: 'Changes how the app draws the screens. Turn Live off for repeatable screenshots. Nothing is written to the skin.',
      inputSchema: {
        accent: z.string().optional().describe('The UI accent colour, hex such as #8c1eff (not for themes of a region with a fixed accent)'),
        live: z.boolean().optional(),
        handNear: z.boolean().optional().describe('The hand near the screen: the headline arrows\' boxes and the control bar labels'),
        devView: z.boolean().optional().describe("The app's Dev view overlay (firmware names on the screen)"),
        statusBase: z.enum(['auto', 'transp', 'car']).optional().describe('Car status: what the drawing rests on'),
      },
    },
    (a) => run('set_screen', a),
  );

  server.registerTool(
    'get_status_line',
    {
      title: 'Status line and car features',
      description: "The status line every screen shows (clock, temperature, online, network, audio, phone…: the unit photo's set or set by hand), °F and 12 h, and the car features (parts only some cars show) with their choices.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run('get_status_line'),
  );

  server.registerTool(
    'set_status_line',
    {
      title: 'Set status line and car features',
      description: 'Sets the status line (mode "custom" shows the parts in custom; give only the parts to change), °F, 12 h clock, and car features ({"id": choice index, or null for off}). Remembered in the browser like the user\'s own setting.',
      inputSchema: {
        mode: z.enum(['auto', 'custom']).optional(),
        custom: z.record(z.string(), z.unknown()).optional().describe('Status line parts, as get_status_line lists them'),
        fahrenheit: z.boolean().optional(),
        hour12: z.boolean().optional(),
        features: z.record(z.string(), z.number().int().min(0).nullable()).optional(),
      },
    },
    (a) => run('set_status_line', a),
  );

  server.registerTool(
    'list_presets',
    {
      title: 'List presets',
      description: "Presets: changes other users published (images, positions) to try on. With check, how each fits the open skin. Also says which one is being tried on.",
      inputSchema: { query: z.string().optional(), check: z.boolean().optional(), limit: z.number().int().min(0).max(200).optional() },
      annotations: { readOnlyHint: true },
    },
    (a) => run('list_presets', a, 120_000),
  );

  server.registerTool(
    'try_preset',
    {
      title: 'Try on a preset',
      description:
        'try: applies a preset as unsaved changes (with the ones from before); before / after: shows the skin without or with it; keep: keeps its changes; discard: drops them. Publishing, editing or deleting presets is left to the user.',
      inputSchema: { id: z.string().optional(), action: z.enum(['try', 'before', 'after', 'keep', 'discard']).optional() },
    },
    (a) => run('try_preset', a, 120_000),
  );

  server.registerTool(
    'list_reports',
    {
      title: 'List reports',
      description: 'Reports users left on the screens (what looks wrong, where, on which car and side), with replies. Read-only; answering them is left to the user.',
      inputSchema: {
        page: z.string().optional(),
        view: z.string().optional().describe('A firmware view name'),
        status: z.enum(['open', 'resolved', 'all']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    (a) => run('list_reports', a),
  );

  server.registerTool(
    'save',
    {
      title: 'Save',
      description:
        "Saves every unsaved change into the skin folder (or downloads the files where the browser can't write to it). Unless the user let MCP save without asking (in the app's MCP menu), the app first shows them the list of changes and waits for them to confirm, so this can take a while; it reports whether they saved or cancelled. A .backup of each file is kept before its first save. Run check_skin first.",
      inputSchema: {},
      annotations: { destructiveHint: true },
    },
    () => run('save', {}, 15 * 60_000),
  );
}

export const INSTRUCTIONS = `This server drives the MIB2 Configurator web app (${APP_URL}) open in the user's browser: a tool for VW MIB2 head unit skins (ambient light, climate, car status, parking, energy flow, tyre and traffic sign screens).
- Call status first. If the page isn't connected, tell the user how to connect it (the status result says how).
- The user must open their skins folder in the app themselves; the browser doesn't let anything else pick it.
- get_state says what is shown (page, screen, popups); navigate changes it (page, or any screen by id: Vehicle menu screens, settings, Pure Air, Soon screens); screenshot shows it (labels: true names every point and touch area; region + zoom for a close look).\n- Vehicle pages' preview values: get_page_preview / set_page_preview. get_layers / set_layers show or hide parts. get_screen / set_screen (accent, Live off for repeatable screenshots, hand near, Dev view), get_status_line / set_status_line (status line, car features). Presets: list_presets, try_preset. Users' reports: list_reports.\n- To get anywhere else, or change a preview setting no tool covers, use the app's own controls: list_controls (screen buttons, menu, side panels, popups), press (by id, label, or screen point) and set_control (sliders, fields, lists).
- Ambient light, climate, car status: get_scene_data lists the zone file; move_items, set_points, align_items, distribute_items, reset_items, copy_points (to the other side or car, mirrored), swap_zones (two touch areas trade outlines) edit it. Parking and energy flow: get_parking_data / move_parking, get_energy_data / move_energy. undo / redo / revert_file step back.
- Images (theme: true for the theme skin's UI bitmaps, by index or viewImage): list_images, export_image (to a PNG file to edit elsewhere), replace_image / replace_images (from files), swap_images (two images trade pictures, and their places on the shown page unless keepPlaces), revert_image.
- Preview settings (set_preview, set_parking_preview, set_energy_preview) only change what is drawn. Edits stay unsaved until save; get_changes lists them and check_skin checks them. Don't save unless the user asked for it.
- Firmware / reverse engineering questions about a screen (read-only, with or without the app's Dev view switch): get_dev_info (view name, class, model name, view id, state machine states, button events, the widgets that send them and where they lead, datapool values read), list_screen_items, find_item_at (x, y on the screen), list_strings; across all screens: find_view, find_string, find_image_usage. Facts come from the MIB2 Standard firmware; runtime texts and content areas are the app's own and are marked so.
- The user sees everything you do in the app's MCP log.
- Car names marked unconfirmed, and point or area names marked guessed, are the app's best guesses.`;

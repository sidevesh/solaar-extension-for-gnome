import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

// Starts a headless GNOME Shell with the extension enabled, opens real windows in
// it and checks the D-Bus answers Solaar gets. Run through tests/run-tests.sh,
// which sets up the isolated environment this expects.

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');

const TESTS_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const WAYLAND_DISPLAY = 'solaar-test-0';
const UUID = 'solaar-extension@sidevesh';
const SOLAAR_PATH = '/io/github/pwr_solaar/solaar';
const SOLAAR_IFACE = 'io.github.pwr_solaar.solaar';
const APP_A = 'io.github.sidevesh.SolaarTest.A';
const APP_B = 'io.github.sidevesh.SolaarTest.B';
const STATE_OBJ = `Main.extensionManager.lookup(${JSON.stringify(UUID)}).stateObj`;
const SOFTWARE_ID = 0x0c;
// Where tests/fake-receiver.py has the backlight of keyboards 2, 3 and 4.
const KEYBOARD_BACKLIGHT_INDEX = { 2: 0x0e, 3: 0x0b, 4: 0x09 };
const KEYBOARD_LEVELS = 8;

const subprocesses = [];

function sleep(ms) {
  return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
  }));
}

async function waitFor(description, check, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await check())
        return;
      lastError = null;
    } catch (e) {
      lastError = e;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

// The compositor applies focus, stacking and pointer changes asynchronously, so
// results are polled until they match rather than checked once.
async function expectEventually(what, getActual, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let actual;
  do {
    actual = await getActual();
    if (actual === expected)
      return;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function callShell(path, iface, method, params, replyType) {
  const reply = await Gio.DBus.session.call(
    'org.gnome.Shell', path, iface, method, params,
    new GLib.VariantType(replyType), Gio.DBusCallFlags.NONE, 5000, null);
  return reply.deep_unpack();
}

// Runs an async function body inside the shell (see the helper extension).
async function shellEval(code) {
  const [json] = await callShell(
    '/io/github/sidevesh/SolaarTestHelper', 'io.github.sidevesh.SolaarTestHelper', 'Eval',
    new GLib.Variant('(s)', [code]), '(s)');
  return JSON.parse(json);
}

// The same calls Solaar makes for its Process and MouseProcess rule conditions.
async function solaar(method) {
  const [wmClass] = await callShell(SOLAAR_PATH, SOLAAR_IFACE, method, null, '(s)');
  return wmClass;
}

const findWindow = appId => `global.get_window_actors().map(a => a.get_meta_window())
  .find(w => w.get_wm_class() === ${JSON.stringify(appId)})`;

function spawn(argv, logPath, env = {}) {
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDERR_MERGE });
  for (const [key, value] of Object.entries(env))
    launcher.setenv(key, value, true);
  launcher.set_stdout_file_path(logPath);
  const proc = launcher.spawnv(argv);
  subprocesses.push(proc);
  return proc;
}

async function openWindow(appId) {
  spawn(['gjs', '-m', GLib.build_filenamev([TESTS_DIR, 'test-window.js']), appId],
    GLib.build_filenamev([GLib.getenv('SOLAAR_TEST_LOG_DIR'), `${appId}.log`]),
    { WAYLAND_DISPLAY, GDK_BACKEND: 'wayland' });
  await waitFor(`window ${appId} to map`, () => shellEval(`
    const w = ${findWindow(appId)};
    return !!w && w.get_compositor_private().visible && w.get_frame_rect().width > 0;`));
}

async function placeWindow(appId, x, y, width, height) {
  await shellEval(`${findWindow(appId)}.move_resize_frame(true, ${x}, ${y}, ${width}, ${height});`);
  await waitFor(`window ${appId} to be placed`, () => shellEval(`
    const r = ${findWindow(appId)}.get_frame_rect();
    return r.x === ${x} && r.y === ${y} && r.width === ${width} && r.height === ${height};`));
}

async function movePointer(x, y) {
  await expectEventually(`pointer position after warping to ${x},${y}`, () => shellEval(`
    const backend = global.stage.context?.get_backend?.() ?? Clutter.get_default_backend();
    backend.get_default_seat().warp_pointer(${x}, ${y});
    return global.get_pointer().slice(0, 2).join(',');`), `${x},${y}`);
}

async function expectActiveWindow(expected) {
  await expectEventually('ActiveWindow', () => solaar('ActiveWindow'), expected);
}

async function expectPointerOverWindow(x, y, expected, where) {
  await movePointer(x, y);
  await expectEventually(`PointerOverWindow ${where}`, () => solaar('PointerOverWindow'), expected);
}

// The fake receiver's output: requests the extension sent and finished commands.
const receiver = { log: [], stdin: null };

async function startFakeReceiver() {
  const proc = Gio.Subprocess.new(['python3', GLib.build_filenamev([TESTS_DIR, 'fake-receiver.py'])],
    Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE);
  subprocesses.push(proc);
  receiver.stdin = proc.get_stdin_pipe();
  const stdout = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe() });
  const [path] = await stdout.read_line_async(GLib.PRIORITY_DEFAULT, null);
  (async () => {
    for (let line; ([line] = await stdout.read_line_async(GLib.PRIORITY_DEFAULT, null), line !== null);)
      receiver.log.push(JSON.parse(line));
  })().catch(e => print(`# fake receiver: ${e}`));
  // The node isn't a Logitech hidraw device, so it's added by hand.
  await shellEval(`await ${STATE_OBJ}._keyboardBacklight.addHidraw(${JSON.stringify(path)});`);
}

async function receiverCommand(command) {
  receiver.stdin.write_all(new TextEncoder().encode(`${command}\n`), null);
  await waitFor(`the fake receiver to run "${command}"`, () => receiver.log.some(e => e.done === command));
}

const requests = () => receiver.log.filter(e => e.request).map(e => e.request);

// The root feature request asking a device where its backlight is.
const askedForBacklight = (number, since = 0) => requests().slice(since)
  .some(([, n, index, , high, low]) => n === number && index === 0x00 && high === 0x19 && low === 0x82);

const hex = bytes => bytes.map(b => b.toString(16).padStart(2, '0')).join('');

// A long HID++ report from a device; function 0 with software ID 0 is a notification.
const sendReport = (number, featureIndex, address, data) =>
  receiverCommand(`send ${hex([0x11, number, featureIndex, address, ...data])}`);

// The backlight's notification: [number of levels, level, status, effect]
const sendBacklightLevel = (number, level, levels = KEYBOARD_LEVELS) =>
  sendReport(number, KEYBOARD_BACKLIGHT_INDEX[number], 0x00, [levels, level, 0x01, 0x00]);

// The OSD's level goes from 0 to 1.
const keyboardOsd = value =>
  ({ icon: 'keyboard-brightness-symbolic', label: null, level: value, maxLevel: 1 });

// Records the OSDs shown from now on, while still showing them.
const clearOsds = () => shellEval(`
  if (!globalThis.osdCalls) {
    globalThis.osdCalls = [];
    const manager = Main.osdWindowManager;
    const record = (icon, label, level, maxLevel) =>
      osdCalls.push({ icon: icon?.to_string() ?? null, label, level, maxLevel });
    // GNOME 45 has no showAll, it shows on all monitors with show(-1, ...).
    if (manager.showAll) {
      const showAll = manager.showAll;
      manager.showAll = function (...args) {
        record(...args);
        return showAll.apply(this, args);
      };
    } else {
      const show = manager.show;
      manager.show = function (monitorIndex, ...args) {
        if (monitorIndex === -1)
          record(...args);
        return show.call(this, monitorIndex, ...args);
      };
    }
  }
  osdCalls.length = 0;`);

const expectOsds = (what, expected) =>
  expectEventually(what, async () => JSON.stringify(await shellEval('return osdCalls;')), JSON.stringify(expected));

// A fresh server timestamp; the last event's would be stale with no real input,
// and focus stealing prevention would then refuse the activation.
const activate = appId => shellEval(
  `${findWindow(appId)}.activate(global.display.get_current_time_roundtrip());`);

// Window A spans (100,200)-(400,400) and window B (300,300)-(600,500), so they
// overlap in (300,300)-(400,400). B is opened last, so it starts on top.
const tests = [
  ['exports both methods Solaar calls', async () => {
    const [xml] = await callShell(SOLAAR_PATH, 'org.freedesktop.DBus.Introspectable', 'Introspect', null, '(s)');
    const info = Gio.DBusNodeInfo.new_for_xml(xml).lookup_interface(SOLAAR_IFACE);
    if (!info)
      throw new Error(`${SOLAAR_IFACE} is not exported`);
    for (const method of ['ActiveWindow', 'PointerOverWindow']) {
      const m = info.lookup_method(method);
      if (!m || m.in_args.length !== 0 || m.out_args.length !== 1 || m.out_args[0].signature !== 's')
        throw new Error(`${method} is missing or has the wrong signature`);
    }
  }],

  ['returns empty strings when there are no windows', async () => {
    await expectActiveWindow('');
    await expectPointerOverWindow(640, 400, '', 'over the empty desktop');
  }],

  ['ActiveWindow returns the focused window', async () => {
    await openWindow(APP_A);
    await openWindow(APP_B);
    await placeWindow(APP_A, 100, 200, 300, 200);
    await placeWindow(APP_B, 300, 300, 300, 200);
    await activate(APP_A);
    await expectActiveWindow(APP_A);
    await activate(APP_B);
    await expectActiveWindow(APP_B);
  }],

  ['PointerOverWindow returns the window under the pointer', async () => {
    await expectPointerOverWindow(150, 250, APP_A, 'inside A only');
    await expectPointerOverWindow(550, 450, APP_B, 'inside B only');
    await expectPointerOverWindow(1000, 600, '', 'over the empty desktop');
    await expectPointerOverWindow(640, 5, '', 'over the top bar');
  }],

  ['PointerOverWindow picks the topmost of overlapping windows', async () => {
    await expectPointerOverWindow(350, 350, APP_B, 'over the overlap with B on top');
    await activate(APP_A);
    await expectPointerOverWindow(350, 350, APP_A, 'over the overlap with A on top');
    await activate(APP_B);
    await expectPointerOverWindow(350, 350, APP_B, 'over the overlap with B back on top');
  }],

  ['PointerOverWindow ignores window shadows', async () => {
    await expectPointerOverWindow(95, 300, '', '5px left of A');
    await expectPointerOverWindow(450, 505, '', '5px below B');
  }],

  ['PointerOverWindow ignores minimized windows', async () => {
    await shellEval(`${findWindow(APP_B)}.minimize();`);
    try {
      await expectPointerOverWindow(550, 450, '', 'where minimized B is');
      await expectPointerOverWindow(350, 350, APP_A, 'over the overlap with B minimized');
    } finally {
      await shellEval(`${findWindow(APP_B)}.unminimize();`);
      await activate(APP_B);
    }
  }],

  ['PointerOverWindow ignores windows on other workspaces', async () => {
    await shellEval(`
      if (global.workspace_manager.n_workspaces < 2)
        global.workspace_manager.append_new_workspace(false, global.get_current_time());
      ${findWindow(APP_B)}.change_workspace_by_index(1, false);`);
    try {
      await expectPointerOverWindow(550, 450, '', 'where B is, on workspace 2');
    } finally {
      await shellEval(`${findWindow(APP_B)}.change_workspace_by_index(0, false);`);
      await activate(APP_B);
    }
  }],

  ['finds the keyboard backlight behind a receiver', async () => {
    await startFakeReceiver();
    await waitFor('the extension to ask keyboard 2 for its backlight', () => askedForBacklight(2));
  }],

  ['shows the keyboard brightness OSD when the backlight level changes', async () => {
    for (const level of [3, 0, KEYBOARD_LEVELS - 1]) {
      await clearOsds();
      await sendBacklightLevel(2, level);
      await expectOsds(`OSD for level ${level}`, [keyboardOsd(level / (KEYBOARD_LEVELS - 1))]);
    }
  }],

  ['shows a backlight without levels as full or empty', async () => {
    // Older keyboards may not say how many levels they have.
    for (const [levels, level, value] of [[0, 1, 1], [0, 0, 0], [1, 1, 1], [2, 1, 1], [2, 0, 0]]) {
      await clearOsds();
      await sendBacklightLevel(4, level, levels);
      await expectOsds(`OSD for level ${level} of ${levels}`, [keyboardOsd(value)]);
    }
  }],

  ['ignores other notifications and replies', async () => {
    await clearOsds();
    // Another feature of the keyboard, the mouse's notification at the
    // keyboard's backlight index, and Solaar's reply from the backlight.
    await sendReport(2, 0x05, 0x00, [0x01, 0x02]);
    await sendReport(1, KEYBOARD_BACKLIGHT_INDEX[2], 0x00, [0x01, 0x02]);
    await sendReport(2, KEYBOARD_BACKLIGHT_INDEX[2], 0x0b, [0x01, 0x02]);
    // Reports are handled in order, so only this one may show.
    await sendBacklightLevel(2, 4);
    await expectOsds('OSDs', [keyboardOsd(4 / (KEYBOARD_LEVELS - 1))]);
  }],

  ['finds a keyboard when it wakes up', async () => {
    await clearOsds();
    const since = requests().length;
    await receiverCommand('wake 3');
    await waitFor('the extension to ask keyboard 3 for its backlight', () => askedForBacklight(3, since));
    await sendBacklightLevel(3, 5);
    await expectOsds('OSDs', [keyboardOsd(5 / (KEYBOARD_LEVELS - 1))]);
  }],

  ['finds a keyboard whose connection it missed', async () => {
    await receiverCommand('sleep 3');
    await receiverCommand('awake 3');
    await clearOsds();
    await sendBacklightLevel(3, 2);
    await expectOsds('OSDs', [keyboardOsd(2 / (KEYBOARD_LEVELS - 1))]);
  }],

  ['sends requests with its own HID++ software ID', async () => {
    const others = requests().filter(([, , , address]) => (address & 0x0f) !== SOFTWARE_ID);
    if (requests().length === 0 || others.length > 0)
      throw new Error(`Expected only software ID ${SOFTWARE_ID}, got ${JSON.stringify(others)}`);
  }],

  ['disable stops the keyboard brightness OSD', async () => {
    await shellEval(`${STATE_OBJ}.disable();`);
    try {
      await clearOsds();
      await sendBacklightLevel(2, 6);
      await sleep(500);
      await expectOsds('OSDs while disabled', []);
    } finally {
      await shellEval(`${STATE_OBJ}.enable();`);
    }
  }],

  ['disable removes the D-Bus object and enable restores it', async () => {
    // Calls the extension's own disable() and enable() rather than going
    // through the shell's settings-driven enable machinery.
    const stateObj = STATE_OBJ;
    await shellEval(`${stateObj}.disable();`);
    let error = null;
    try {
      await solaar('ActiveWindow');
    } catch (e) {
      error = e;
    }
    if (Gio.DBusError.get_remote_error(error) !== 'org.freedesktop.DBus.Error.UnknownMethod')
      throw new Error(`ActiveWindow should fail while disabled, got ${error ?? 'an answer'}`);
    await shellEval(`${stateObj}.enable();`);
    await expectActiveWindow(APP_B);
  }],
];

async function startShell() {
  spawn(['gnome-shell', '--headless', '--wayland', '--no-x11', '--virtual-monitor', '1280x800',
    '--wayland-display', WAYLAND_DISPLAY],
  GLib.build_filenamev([GLib.getenv('SOLAAR_TEST_LOG_DIR'), 'gnome-shell.log']));

  await waitFor('GNOME Shell to start with the test helper enabled', () => shellEval('return true;'), 60000);
  await waitFor('GNOME Shell to finish starting up', () => shellEval('return !Main.layoutManager._startingUp;'));
  const state = await shellEval(`
    Main.overview.hide();
    const ext = Main.extensionManager.lookup(${JSON.stringify(UUID)});
    return { shellVersion: Config.PACKAGE_VERSION, state: ext?.state, error: ext?.error ?? null };`);
  // 1 is ExtensionState.ENABLED (named ACTIVE from GNOME 46).
  if (state.state !== 1)
    throw new Error(`Extension is not enabled (state ${state.state}): ${state.error ?? 'no error reported'}`);
  await waitFor('the overview to close', () => shellEval('return !Main.overview.visible;'));
  return state.shellVersion;
}

async function main() {
  let failures = 0;
  try {
    const version = await startShell();
    print(`# GNOME Shell ${version}`);
  } catch (e) {
    print(`Bail out! ${e.message}`);
    return 1;
  }

  print(`1..${tests.length}`);
  for (const [i, [name, test]] of tests.entries()) {
    try {
      await test();
      print(`ok ${i + 1} - ${name}`);
    } catch (e) {
      failures++;
      print(`not ok ${i + 1} - ${name}`);
      for (const line of String(e.message).split('\n'))
        print(`#   ${line}`);
    }
  }
  return failures ? 1 : 0;
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 1;
main().then(code => {
  exitCode = code;
}).catch(e => {
  print(`Bail out! ${e}`);
}).finally(async () => {
  for (const proc of subprocesses.reverse())
    proc.send_signal(15);
  await Promise.all(subprocesses.map(proc => proc.wait_async(null).catch(() => {})));
  loop.quit();
});
loop.run();
System.exit(exitCode);

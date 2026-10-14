import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

// Starts a headless GNOME Shell with the extension enabled, opens real windows in
// it and checks the D-Bus answers Solaar gets. Run through tests/run-tests.sh,
// which sets up the isolated environment this expects.

Gio._promisify(Gio.DBusConnection.prototype, 'call');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

const TESTS_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const WAYLAND_DISPLAY = 'solaar-test-0';
const UUID = 'solaar-extension@sidevesh';
const SOLAAR_PATH = '/io/github/pwr_solaar/solaar';
const SOLAAR_IFACE = 'io.github.pwr_solaar.solaar';
const APP_A = 'io.github.sidevesh.SolaarTest.A';
const APP_B = 'io.github.sidevesh.SolaarTest.B';

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

  ['disable removes the D-Bus object and enable restores it', async () => {
    // Calls the extension's own disable() and enable() rather than going
    // through the shell's settings-driven enable machinery.
    const stateObj = `Main.extensionManager.lookup(${JSON.stringify(UUID)}).stateObj`;
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

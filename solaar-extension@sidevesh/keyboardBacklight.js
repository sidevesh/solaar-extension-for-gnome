import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Shows GNOME's keyboard brightness OSD when a Logitech keyboard changes its
// backlight level, including with its own backlight keys, as GNOME does for
// laptop keyboards. The keyboard reports the change in a HID++ notification,
// which every reader of the receiver's (or the Bluetooth keyboard's) hidraw
// node gets, so this listens next to Solaar without needing anything from it.

const LOGITECH_VENDOR_ID = 0x046d;
const BACKLIGHT2 = 0x1982;

// A HID++ report's first byte is its report ID, which sets its length.
const SHORT_REPORT = 0x10;
const LONG_REPORT = 0x11;
const REPORT_LENGTHS = new Map([[SHORT_REPORT, 7], [LONG_REPORT, 20], [0x12, 64]]);

// Requests carry a software ID that the device copies into its reply, so the
// programs sharing a device can tell their replies apart; notifications carry
// 0. Solaar uses 0x0B, and other known HID++ programs 0x07, 0x0A, 0x0D and 0x0F.
const SOFTWARE_ID = 0x0c;

// Devices paired to a receiver are numbered 1 to 6, and a device connected
// directly, over Bluetooth or USB, answers as 0xFF.
const DEVICE_NUMBERS = [0xff, 1, 2, 3, 4, 5, 6];

// Sent by a receiver when one of its devices connects or disconnects, for
// example when the keyboard wakes up.
const DEVICE_CONNECTION = 0x41;
const LINK_NOT_ESTABLISHED = 0x40;

const HIDPP10_ERROR = 0x8f;
const HIDPP20_ERROR = 0xff;

const REQUEST_TIMEOUT_MS = 2000;

export class KeyboardBacklightOsd {
  constructor() {
    this._nodes = new Map();
    this._cancellable = new Gio.Cancellable();
    this._ready = this._start();
  }

  destroy() {
    this._cancellable.cancel();
    if (this._udevClient) {
      this._udevClient.disconnect(this._ueventId);
      this._udevClient = null;
    }
    for (const node of this._nodes.values())
      node.close();
    this._nodes.clear();
  }

  // Starts listening on a hidraw node; HID++ nodes of Logitech devices are
  // found and added automatically.
  async addHidraw(path) {
    await this._ready;
    if (this._cancellable.is_cancelled() || this._nodes.has(path))
      return;

    try {
      this._nodes.set(path, new HidppNode(path, this._streams, () => this._removeHidraw(path)));
    } catch (e) {
      // Usually missing permissions: Solaar's udev rules grant access to
      // Logitech receivers and devices only.
      console.debug(`Solaar Extension: Cannot open ${path}: ${e.message}`);
    }
  }

  _removeHidraw(path) {
    this._nodes.get(path)?.close();
    this._nodes.delete(path);
  }

  async _start() {
    this._streams = await loadUnixStreams();

    let GUdev;
    try {
      ({ default: GUdev } = await import('gi://GUdev'));
    } catch (e) {
      console.warn(`Solaar Extension: GUdev is not available, the keyboard backlight OSD is off: ${e.message}`);
      return;
    }
    if (this._cancellable.is_cancelled())
      return;

    this._udevClient = new GUdev.Client({ subsystems: ['hidraw'] });
    this._ueventId = this._udevClient.connect('uevent', (client, action, device) => {
      if (action === 'add')
        this._addUdevDevice(device);
      else if (action === 'remove')
        this._removeHidraw(device.get_device_file());
    });
    for (const device of this._udevClient.query_by_subsystem('hidraw'))
      this._addUdevDevice(device);
  }

  _addUdevDevice(device) {
    const hid = device.get_parent_with_subsystem('hid', null);
    const path = device.get_device_file();
    if (!hid || !path)
      return;

    // HID_ID is bus:vendor:product in hex.
    const vendor = parseInt((hid.get_property('HID_ID') ?? '').split(':')[1], 16);
    if (vendor === LOGITECH_VENDOR_ID && hasHidppReports(`${hid.get_sysfs_path()}/report_descriptor`))
      this.addHidraw(path).catch(logError);
  }
}

class HidppNode {
  constructor(path, streams, onClosed) {
    this._path = path;
    this._onClosed = onClosed;
    this._channel = GLib.IOChannel.new_file(path, 'r+');
    const fd = this._channel.unix_get_fd();
    this._input = new streams.InputStream({ fd, close_fd: false });
    this._output = new streams.OutputStream({ fd, close_fd: false });
    this._cancellable = new Gio.Cancellable();
    this._buffer = [];
    this._queue = Promise.resolve();
    this._pending = null;
    // Device number to the index of its backlight feature, 0 for a device
    // without one. Missing until the device answered.
    this._backlights = new Map();
    this._probing = new Set();

    this._read();
    for (const number of DEVICE_NUMBERS)
      this._probe(number).catch(logError);
  }

  close() {
    if (this._closed)
      return;
    this._closed = true;
    this._cancellable.cancel();
    this._pending?.resolve(null);
    this._channel.shutdown(false);
  }

  _read() {
    this._input.read_bytes_async(64, GLib.PRIORITY_DEFAULT, this._cancellable, (stream, result) => {
      let bytes;
      try {
        bytes = stream.read_bytes_finish(result);
      } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
          this._onClosed();
        return;
      }
      if (bytes.get_size() === 0) {
        this._onClosed();
        return;
      }

      // hidraw returns one report per read, but don't rely on it.
      this._buffer.push(...bytes.toArray());
      while (this._buffer.length > 0) {
        const length = REPORT_LENGTHS.get(this._buffer[0]);
        if (!length) {
          this._buffer.shift();
          continue;
        }
        if (this._buffer.length < length)
          break;
        // Keep reading even if one report can't be handled.
        try {
          this._handleReport(this._buffer.splice(0, length));
        } catch (e) {
          logError(e, `Solaar Extension: ${this._path}`);
        }
      }
      this._read();
    });
  }

  _handleReport(report) {
    const [, number, subId, address] = report;

    if (subId === HIDPP10_ERROR || subId === HIDPP20_ERROR) {
      // The failed request's feature index and function follow the error ID.
      if ((report[4] & 0x0f) === SOFTWARE_ID)
        this._handleReply(number, report[3], report[4], null);
      return;
    }

    if (subId === DEVICE_CONNECTION) {
      this._backlights.delete(number);
      if (!(report[4] & LINK_NOT_ESTABLISHED))
        this._probe(number).catch(logError);
      return;
    }

    // Other HID++ 1.0 notifications and register replies.
    if (subId >= 0x40)
      return;

    const softwareId = address & 0x0f;
    if (softwareId === SOFTWARE_ID) {
      this._handleReply(number, subId, address, report);
      return;
    }
    // A reply to Solaar or another program.
    if (softwareId !== 0)
      return;

    if (!this._backlights.has(number)) {
      // A device that was already connected but asleep when this started.
      this._probe(number).then(() => {
        if (this._backlights.has(number))
          this._handleReport(report);
      }).catch(logError);
      return;
    }

    // The backlight's only notification, function 0, sent whenever the
    // backlight changes: [number of levels, level, status, effect, ...]
    const index = this._backlights.get(number);
    if (index && subId === index && address === 0x00)
      showOsd(report[4], report[5]);
  }

  async _probe(number) {
    if (this._probing.has(number))
      return;
    this._probing.add(number);
    try {
      // Root feature, function 0, get the index of a feature: [index, type, version]
      const feature = await this._request(number, 0x00, 0x0, [BACKLIGHT2 >> 8, BACKLIGHT2 & 0xff]);
      // No answer: asleep or not paired. It's probed again when it connects.
      if (!feature)
        return;

      if (!this._closed)
        this._backlights.set(number, feature[4]);
    } finally {
      this._probing.delete(number);
    }
  }

  // Sends one request at a time and resolves with the reply, or null on an
  // error or no answer.
  _request(number, featureIndex, functionId, params = []) {
    const send = () => new Promise(resolve => {
      if (this._closed) {
        resolve(null);
        return;
      }

      const address = (functionId << 4) | SOFTWARE_ID;
      const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_MS, () => {
        this._pending.resolve(null);
        return GLib.SOURCE_REMOVE;
      });
      this._pending = {
        number, featureIndex, address,
        resolve: reply => {
          GLib.Source.remove(timeoutId);
          this._pending = null;
          resolve(reply);
        },
      };

      const report = new Uint8Array(REPORT_LENGTHS.get(SHORT_REPORT));
      report.set([SHORT_REPORT, number, featureIndex, address, ...params]);
      this._output.write_bytes_async(new GLib.Bytes(report), GLib.PRIORITY_DEFAULT, this._cancellable,
        (stream, result) => {
          try {
            stream.write_bytes_finish(result);
          } catch {
            this._pending?.resolve(null);
          }
        });
    });

    const reply = this._queue.then(send);
    this._queue = reply;
    return reply;
  }

  _handleReply(number, featureIndex, address, reply) {
    const pending = this._pending;
    if (pending && pending.number === number && pending.featureIndex === featureIndex &&
        pending.address === address)
      pending.resolve(reply);
  }
}

// Shows the level out of the keyboard's levels, which include 0. A backlight
// that is only on or off, or that doesn't say how many levels it has, shows
// as full or empty, as GNOME does for laptop keyboards like that.
function showOsd(levels, level) {
  const value = levels > 1 ? Math.min(level, levels - 1) / (levels - 1) : Number(level > 0);
  const icon = Gio.ThemedIcon.new('keyboard-brightness-symbolic');
  const osd = Main.osdWindowManager;
  // GNOME 45 shows on all monitors with show(-1, ...).
  if (osd.showAll)
    osd.showAll(icon, null, value, 1);
  else
    osd.show(-1, icon, null, value, 1);
}

// GLib 2.80 moved the Unix streams from Gio to GioUnix.
async function loadUnixStreams() {
  try {
    const { default: GioUnix } = await import('gi://GioUnix');
    return { InputStream: GioUnix.InputStream, OutputStream: GioUnix.OutputStream };
  } catch {
    return { InputStream: Gio.UnixInputStream, OutputStream: Gio.UnixOutputStream };
  }
}

// HID++ nodes have a vendor-defined usage page with the long report.
function hasHidppReports(descriptorPath) {
  let descriptor;
  try {
    [, descriptor] = GLib.file_get_contents(descriptorPath);
  } catch {
    return false;
  }

  let vendorPage = false, longReport = false;
  for (let i = 0; i + 2 < descriptor.length; i++) {
    // Usage Page (0xFFxx)
    if (descriptor[i] === 0x06 && descriptor[i + 2] === 0xff)
      vendorPage = true;
    // Report ID (0x11)
    if (descriptor[i] === 0x85 && descriptor[i + 1] === LONG_REPORT)
      longReport = true;
  }
  return vendorPage && longReport;
}

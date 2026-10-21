#!/usr/bin/env python3
# A stand-in for a Logitech receiver's HID++ hidraw node, used by test-solaar.js.
# It creates a pseudo-terminal in raw mode, which reads and writes like a
# hidraw node, and prints its path. It then answers HID++ requests for the
# devices below and logs them as JSON lines on stdout. Commands on stdin:
#   send <hex>     write a report, e.g. a notification
#   wake <number>  connect a sleeping device and announce it, as receivers do
#   sleep <number> disconnect a device and announce it
#   awake <number> connect a sleeping device without announcing it

import json
import os
import select
import sys
import tty

BACKLIGHT2 = 0x1982
LENGTHS = {0x10: 7, 0x11: 20, 0x12: 64}

# Device number: features as {feature: (index, version)}. 1 is a mouse, 2 an
# awake keyboard, 3 a sleeping keyboard and 4 an older keyboard.
devices = {
    1: {'features': {0x1004: (0x06, 1)}, 'awake': True},
    2: {'features': {BACKLIGHT2: (0x0E, 3)}, 'awake': True},
    3: {'features': {BACKLIGHT2: (0x0B, 3)}, 'awake': False},
    4: {'features': {BACKLIGHT2: (0x09, 1)}, 'awake': True},
}

master, slave = os.openpty()
tty.setraw(slave)
print(os.ttyname(slave), flush=True)


def write(report):
    report = bytes(report)
    os.write(master, report + bytes(LENGTHS[report[0]] - len(report)))


def log(**entry):
    print(json.dumps(entry), flush=True)


def answer(report):
    number, index, address = report[1:4]
    log(request=list(report))
    device = devices.get(number)
    if device is None:
        write([0x10, number, 0x8F, index, address, 0x09])  # not paired
        return
    if not device['awake']:
        write([0x10, number, 0x8F, index, address, 0x04])  # connection failed
        return
    function = address >> 4
    if index == 0x00 and function == 0:  # root: get feature index
        feature = report[4] << 8 | report[5]
        found, version = device['features'].get(feature, (0, 0))
        write([0x11, number, index, address, found, 0, version])
        return
    write([0x11, number, 0xFF, index, address, 0x02])  # invalid function


def connection(number, connected, announce=True):
    devices[number]['awake'] = connected
    if announce:
        write([0x10, number, 0x41, 0x04, 0x00 if connected else 0x40, 0x69, 0xB3])


buffer = b''
while True:
    readable, _, _ = select.select([master, sys.stdin], [], [])
    if sys.stdin in readable:
        line = sys.stdin.readline()
        if not line:
            break
        command, argument = line.split()
        if command == 'send':
            write(bytes.fromhex(argument))
        else:
            connection(int(argument), command != 'sleep', command != 'awake')
        log(done=line.strip())
    if master in readable:
        buffer += os.read(master, 64)
        while buffer and len(buffer) >= LENGTHS.get(buffer[0], 1):
            length = LENGTHS.get(buffer[0])
            if length is None:
                buffer = buffer[1:]
                continue
            answer(buffer[:length])
            buffer = buffer[length:]

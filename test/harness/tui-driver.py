#!/usr/bin/env python3
"""Drive an interactive Qwen Code TUI through a pseudo-terminal.

    python3 -I test/harness/tui-driver.py <actions.json> <screen-log> -- <command...>

actions.json is a list of steps:
  {"wait": 2.5}                    read output for N seconds
  {"until": "text", "timeout": 20} read until the (ANSI-stripped) screen contains text
                                   (optional "then": keys to send only if it appeared)
  {"send": "text"}                 type text (use "\r" for Enter, "\u001b" for Esc)
  {"mark": "label"}                write a marker line into the screen log

The screen log receives ANSI-stripped output with markers so a test or a human
can check what the TUI showed at each step.
"""

import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]")


def strip(text):
    return ANSI.sub("", text).replace("\r", "")


def main():
    argv = sys.argv[1:]
    split = argv.index("--")
    actions_path, log_path = argv[0], argv[1]
    command = argv[split + 1:]
    with open(actions_path) as f:
        actions = json.load(f)

    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(command[0], command)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 140, 0, 0))
    screen = []
    log = open(log_path, "w")

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.1)
            if fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return False
                if not data:
                    return False
                text = data.decode("utf-8", "replace")
                screen.append(text)
                log.write(strip(text))
                log.flush()
        return True

    for step in actions:
        if "wait" in step:
            pump(step["wait"])
        elif "until" in step:
            deadline = time.time() + step.get("timeout", 20)
            while time.time() < deadline:
                pump(0.3)
                if step["until"] in strip("".join(screen[-200:])):
                    if "then" in step:
                        os.write(fd, step["then"].encode())
                    break
            else:
                log.write(f"\n=== TIMEOUT waiting for {step['until']!r} ===\n")
        elif "send" in step:
            os.write(fd, step["send"].encode())
        elif "mark" in step:
            log.write(f"\n=== {step['mark']} ===\n")
            log.flush()

    pump(1)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    log.close()


if __name__ == "__main__":
    main()

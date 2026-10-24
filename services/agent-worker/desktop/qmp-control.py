#!/usr/bin/env python3
"""Send commands to the session desktop VM's QMP socket.

The output is a single JSON line so the Agent Worker can consume it without a
QMP client library. `status` returns both the run state and the VM name so the
worker never pauses the first-boot installer instead of the installed desktop.
`stop` (QMP stop) pauses the vCPUs for idle sleep and `cont` resumes them.
"""

import json
import socket
import sys


DESKTOP_VM_NAME = "openlink-ubuntu-desktop"


def read_message(stream):
    while True:
        line = stream.readline()
        if not line:
            raise RuntimeError("QMP connection closed")
        try:
            return json.loads(line)
        except json.JSONDecodeError:
            continue


def wait_for_return(stream):
    while True:
        message = read_message(stream)
        if "error" in message:
            raise RuntimeError(json.dumps(message["error"]))
        if "return" in message:
            return message["return"]


def send(stream, command):
    stream.write(json.dumps({"execute": command}).encode() + b"\n")
    stream.flush()
    return wait_for_return(stream)


def main() -> int:
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "error": "usage: qmp-control.py <socket> <status|suspend|resume|wake>"}))
        return 2
    socket_path, command = sys.argv[1], sys.argv[2]
    if command not in {"status", "suspend", "resume", "wake"}:
        print(json.dumps({"ok": False, "error": f"unsupported command: {command}"}))
        return 2

    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(5)
    try:
        connection.connect(socket_path)
        with connection, connection.makefile("rwb") as stream:
            read_message(stream)  # QMP greeting
            send(stream, "qmp_capabilities")
            if command == "status":
                status = send(stream, "query-status")
                name = send(stream, "query-name")
                print(json.dumps({"status": status.get("status"), "name": name.get("name")}))
                return 0
            if command == "suspend":
                # Only the installed desktop VM may be paused. The installer
                # shares the same QMP path and must finish its autoinstall.
                name = send(stream, "query-name")
                if name.get("name") != DESKTOP_VM_NAME:
                    print(json.dumps({"ok": False, "error": f"refusing to suspend {name.get('name') or 'unknown VM'}"}))
                    return 1
                result = send(stream, "stop")
            elif command == "resume":
                result = send(stream, "cont")
            else:  # wake
                result = send(stream, "system_wakeup")
    except Exception as error:  # noqa: BLE001 - surface the failure to the worker
        print(json.dumps({"ok": False, "error": str(error)}))
        return 1

    print(json.dumps({"ok": True, "return": result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

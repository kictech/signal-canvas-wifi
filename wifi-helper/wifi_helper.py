"""Signal Canvas Windows Wi-Fi measurement helper.

Runs a localhost-only HTTP service that exposes nearby SSID/BSSID/signal data.
No data is sent anywhere except the browser tab that requested the scan.
"""

from __future__ import annotations

import json
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8765


def scan_wifi() -> list[dict[str, object]]:
    completed = subprocess.run(
        ["netsh", "wlan", "show", "networks", "mode=bssid"],
        capture_output=True,
        text=True,
        errors="replace",
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(
            completed.stderr.strip()
            or completed.stdout.strip()
            or "Wi-Fi scan failed. Windows 위치 서비스를 확인하세요."
        )

    networks: list[dict[str, object]] = []
    ssid = ""
    current: dict[str, object] | None = None
    for raw_line in completed.stdout.splitlines():
        line = raw_line.strip()
        ssid_match = re.match(r"^SSID\s+\d+\s*:\s*(.*)$", line, re.I)
        if ssid_match:
            ssid = ssid_match.group(1).strip() or "(숨김 네트워크)"
            continue

        bssid_match = re.match(
            r"^BSSID\s+\d+\s*:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})$",
            line,
            re.I,
        )
        if bssid_match:
            current = {
                "ssid": ssid,
                "bssid": bssid_match.group(1).upper(),
                "signal": 0,
                "rssi": -100,
                "channel": "",
            }
            networks.append(current)
            continue

        if current is None:
            continue

        signal_match = re.match(r"^(?:Signal|신호)\s*:\s*(\d+)%", line, re.I)
        if signal_match:
            quality = max(0, min(100, int(signal_match.group(1))))
            current["signal"] = quality
            # Windows documents a linear -100 to -50 dBm mapping for quality.
            current["rssi"] = round(quality / 2 - 100)
            continue

        channel_match = re.match(r"^(?:Channel|채널)\s*:\s*(\d+)", line, re.I)
        if channel_match:
            current["channel"] = channel_match.group(1)

    deduplicated = {
        str(network["bssid"]): network for network in networks if network["bssid"]
    }
    return sorted(
        deduplicated.values(),
        key=lambda network: int(network["rssi"]),
        reverse=True,
    )


class Handler(BaseHTTPRequestHandler):
    def _headers(self, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._headers(204)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            payload = {"ok": True, "service": "signal-canvas-wifi-helper"}
        elif self.path == "/scan":
            try:
                payload = {"ok": True, "networks": scan_wifi()}
            except Exception as error:  # pragma: no cover - hardware dependent
                self._headers(500)
                self.wfile.write(
                    json.dumps(
                        {"ok": False, "error": str(error)}, ensure_ascii=False
                    ).encode("utf-8")
                )
                return
        else:
            self._headers(404)
            self.wfile.write(b'{"ok":false,"error":"not found"}')
            return

        self._headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def log_message(self, _format: str, *_args: object) -> None:
        return


if __name__ == "__main__":
    print(f"Signal Canvas Wi-Fi helper: http://{HOST}:{PORT}")
    print("Keep this window open while measuring. Press Ctrl+C to stop.")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

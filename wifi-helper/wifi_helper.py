"""Signal Canvas Windows Wi-Fi measurement helper.

Runs a localhost-only HTTP service that exposes nearby SSID/BSSID/signal data.
No data is sent anywhere except the browser tab that requested the scan.
"""

from __future__ import annotations

import ctypes
import json
import time
from ctypes import wintypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8765
WLAN_CLIENT_VERSION_LONGHORN = 2
DOT11_BSS_TYPE_ANY = 3
ERROR_SUCCESS = 0


class GUID(ctypes.Structure):
    _fields_ = [
        ("Data1", wintypes.DWORD),
        ("Data2", wintypes.WORD),
        ("Data3", wintypes.WORD),
        ("Data4", ctypes.c_ubyte * 8),
    ]


class DOT11_SSID(ctypes.Structure):
    _fields_ = [
        ("uSSIDLength", wintypes.ULONG),
        ("ucSSID", ctypes.c_ubyte * 32),
    ]


class WLAN_RATE_SET(ctypes.Structure):
    _fields_ = [
        ("uRateSetLength", wintypes.ULONG),
        ("usRateSet", wintypes.USHORT * 126),
    ]


class WLAN_INTERFACE_INFO(ctypes.Structure):
    _fields_ = [
        ("InterfaceGuid", GUID),
        ("strInterfaceDescription", wintypes.WCHAR * 256),
        ("isState", wintypes.DWORD),
    ]


class WLAN_INTERFACE_INFO_LIST(ctypes.Structure):
    _fields_ = [
        ("dwNumberOfItems", wintypes.DWORD),
        ("dwIndex", wintypes.DWORD),
        ("InterfaceInfo", WLAN_INTERFACE_INFO * 1),
    ]


class WLAN_BSS_ENTRY(ctypes.Structure):
    _fields_ = [
        ("dot11Ssid", DOT11_SSID),
        ("uPhyId", wintypes.ULONG),
        ("dot11Bssid", ctypes.c_ubyte * 6),
        ("dot11BssType", wintypes.DWORD),
        ("dot11BssPhyType", wintypes.DWORD),
        ("lRssi", wintypes.LONG),
        ("uLinkQuality", wintypes.ULONG),
        ("bInRegDomain", ctypes.c_ubyte),
        ("usBeaconPeriod", wintypes.USHORT),
        ("ullTimestamp", ctypes.c_ulonglong),
        ("ullHostTimestamp", ctypes.c_ulonglong),
        ("usCapabilityInformation", wintypes.USHORT),
        ("ulChCenterFrequency", wintypes.ULONG),
        ("wlanRateSet", WLAN_RATE_SET),
        ("ulIeOffset", wintypes.ULONG),
        ("ulIeSize", wintypes.ULONG),
    ]


class WLAN_BSS_LIST(ctypes.Structure):
    _fields_ = [
        ("dwTotalSize", wintypes.DWORD),
        ("dwNumberOfItems", wintypes.DWORD),
        ("wlanBssEntries", WLAN_BSS_ENTRY * 1),
    ]


def _channel_from_frequency(frequency_khz: int) -> str:
    frequency_mhz = round(frequency_khz / 1000)
    if frequency_mhz == 2484:
        return "14"
    if 2412 <= frequency_mhz <= 2472:
        return str((frequency_mhz - 2407) // 5)
    if 5000 <= frequency_mhz <= 5900:
        return str((frequency_mhz - 5000) // 5)
    if 5955 <= frequency_mhz <= 7115:
        return str((frequency_mhz - 5950) // 5)
    return ""


def _raise_wlan_error(operation: str, code: int) -> None:
    if code == 5:
        raise RuntimeError(
            f"{operation} 권한이 거부되었습니다. Windows 위치 서비스를 켜고 "
            "‘데스크톱 앱에서 위치에 액세스’도 허용하세요."
        )
    raise OSError(code, f"{operation} 실패: {ctypes.FormatError(code)}")


def scan_wifi() -> list[dict[str, object]]:
    wlan = ctypes.WinDLL("wlanapi.dll")
    wlan.WlanOpenHandle.argtypes = [
        wintypes.DWORD,
        wintypes.LPVOID,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.HANDLE),
    ]
    wlan.WlanOpenHandle.restype = wintypes.DWORD
    wlan.WlanEnumInterfaces.argtypes = [
        wintypes.HANDLE,
        wintypes.LPVOID,
        ctypes.POINTER(ctypes.POINTER(WLAN_INTERFACE_INFO_LIST)),
    ]
    wlan.WlanEnumInterfaces.restype = wintypes.DWORD
    wlan.WlanScan.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(GUID),
        ctypes.POINTER(DOT11_SSID),
        wintypes.LPVOID,
        wintypes.LPVOID,
    ]
    wlan.WlanScan.restype = wintypes.DWORD
    wlan.WlanGetNetworkBssList.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(GUID),
        ctypes.POINTER(DOT11_SSID),
        wintypes.DWORD,
        wintypes.BOOL,
        wintypes.LPVOID,
        ctypes.POINTER(ctypes.POINTER(WLAN_BSS_LIST)),
    ]
    wlan.WlanGetNetworkBssList.restype = wintypes.DWORD
    wlan.WlanFreeMemory.argtypes = [wintypes.LPVOID]
    wlan.WlanCloseHandle.argtypes = [wintypes.HANDLE, wintypes.LPVOID]

    negotiated_version = wintypes.DWORD()
    client_handle = wintypes.HANDLE()
    result = wlan.WlanOpenHandle(
        WLAN_CLIENT_VERSION_LONGHORN,
        None,
        ctypes.byref(negotiated_version),
        ctypes.byref(client_handle),
    )
    if result != ERROR_SUCCESS:
        _raise_wlan_error("Native Wi-Fi 초기화", result)

    interface_list = ctypes.POINTER(WLAN_INTERFACE_INFO_LIST)()
    networks: dict[str, dict[str, object]] = {}
    try:
        result = wlan.WlanEnumInterfaces(
            client_handle, None, ctypes.byref(interface_list)
        )
        if result != ERROR_SUCCESS:
            _raise_wlan_error("Wi-Fi 어댑터 조회", result)
        if not interface_list:
            return []

        count = interface_list.contents.dwNumberOfItems
        base = (
            ctypes.addressof(interface_list.contents)
            + WLAN_INTERFACE_INFO_LIST.InterfaceInfo.offset
        )
        interfaces = [
            WLAN_INTERFACE_INFO.from_address(
                base + index * ctypes.sizeof(WLAN_INTERFACE_INFO)
            )
            for index in range(count)
        ]

        for interface in interfaces:
            wlan.WlanScan(
                client_handle,
                ctypes.byref(interface.InterfaceGuid),
                None,
                None,
                None,
            )
        time.sleep(1.4)

        for interface in interfaces:
            bss_list = ctypes.POINTER(WLAN_BSS_LIST)()
            result = wlan.WlanGetNetworkBssList(
                client_handle,
                ctypes.byref(interface.InterfaceGuid),
                None,
                DOT11_BSS_TYPE_ANY,
                False,
                None,
                ctypes.byref(bss_list),
            )
            if result == 5:
                _raise_wlan_error("주변 Wi-Fi RSSI 조회", result)
            if result != ERROR_SUCCESS or not bss_list:
                continue
            try:
                entry_count = bss_list.contents.dwNumberOfItems
                entry_base = (
                    ctypes.addressof(bss_list.contents)
                    + WLAN_BSS_LIST.wlanBssEntries.offset
                )
                for index in range(entry_count):
                    entry = WLAN_BSS_ENTRY.from_address(
                        entry_base + index * ctypes.sizeof(WLAN_BSS_ENTRY)
                    )
                    ssid_length = min(int(entry.dot11Ssid.uSSIDLength), 32)
                    ssid_bytes = bytes(entry.dot11Ssid.ucSSID[:ssid_length])
                    ssid = (
                        ssid_bytes.decode("utf-8", errors="replace")
                        if ssid_bytes
                        else "(숨김 네트워크)"
                    )
                    bssid = ":".join(f"{part:02X}" for part in entry.dot11Bssid)
                    network = {
                        "ssid": ssid,
                        "bssid": bssid,
                        "rssi": int(entry.lRssi),
                        "signal": int(entry.uLinkQuality),
                        "channel": _channel_from_frequency(
                            int(entry.ulChCenterFrequency)
                        ),
                        "frequency": int(entry.ulChCenterFrequency),
                        "source": "WLAN_BSS_ENTRY.lRssi",
                    }
                    previous = networks.get(bssid)
                    if previous is None or int(network["rssi"]) > int(
                        previous["rssi"]
                    ):
                        networks[bssid] = network
            finally:
                wlan.WlanFreeMemory(bss_list)
    finally:
        if interface_list:
            wlan.WlanFreeMemory(interface_list)
        wlan.WlanCloseHandle(client_handle, None)

    return sorted(
        networks.values(), key=lambda network: int(network["rssi"]), reverse=True
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

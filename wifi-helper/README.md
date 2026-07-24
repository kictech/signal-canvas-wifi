# Signal Canvas Wi-Fi 측정 도우미

Windows에서 `run-helper.bat`을 실행하고 창을 열어 둡니다. 그다음 Signal
Canvas에서 측정점을 선택하고 **노트북 Wi-Fi 스캔**을 누릅니다.

- Python 3 필요
- Windows 위치 서비스와 Wi-Fi가 켜져 있어야 함
- 서비스는 `127.0.0.1:8765`에서만 열리며 외부 네트워크에는 노출되지 않음
- 같은 SSID는 BSSID(MAC 주소)로 구분
- `netsh`가 제공하는 신호 품질을 Windows 문서의 선형식으로 dBm으로 변환

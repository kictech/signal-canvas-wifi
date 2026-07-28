# Signal Canvas Wi-Fi 측정 도우미

압축을 푼 뒤 `install-helper.bat`을 최초 1회 실행합니다. 설치가 끝나면
Signal Canvas의 **노트북 Wi-Fi 스캔** 버튼이 필요할 때 도우미를 자동으로
호출합니다. 다시 직접 실행할 필요가 없습니다.

- Python 3 필요
- 최초 설치는 현재 Windows 사용자 계정에만 적용되며 관리자 권한은 필요 없음
- `signalcanvas://start` 주소를 등록해 사이트에서 도우미를 자동 호출
- Windows 위치 서비스와 Wi-Fi가 켜져 있어야 함
- 서비스는 `127.0.0.1:8765`에서만 열리며 외부 네트워크에는 노출되지 않음
- 같은 SSID는 BSSID(MAC 주소)로 구분
- Windows Native Wi-Fi API의 `WLAN_BSS_ENTRY.lRssi`에서 실제 dBm 값을 읽음
- Windows 설정에서 **데스크톱 앱에서 위치에 액세스**를 허용해야 함

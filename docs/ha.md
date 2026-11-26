# Home Assistant 연동

실제 조명, 스피커, 음악, 자동화는 Home Assistant(HA)가 맡고 까치는 ha-mcp 로 HA 를 쓴다. 공기계는 마이크와 카메라 같은 입력을 주로 맡고, 화면 조명은 무드등 정도로 남는다.

HA 는 선택이다. VM 을 하나 더 띄우는 일이라, 까치와 공기계만으로 충분한 동안에는 필요 없다. 실제 전구, 스피커, 카메라가 생겨 모자랄 때 붙인다([philosophy.md](philosophy.md) 1번).

```
까치 홈, 공기계 ──▶ 까치 core (Pi) ─┬─ kkachi-memory
                                    ├─ kkachi-devices (공기계)
                                    └─ ha-mcp ─▶ HA ─┬─ 스마트 전구
                                                     ├─ Music Assistant ─▶ Apple Music, 스피커
                                                     └─ Companion 앱 (공기계 센서)
```

까치 쪽 연결은 HA 없이 띄운 ha-mcp 9.2.0 으로 확인했다. HA 를 실제로 설치해 본 것은 아니다.

## 1. HA OS 가상 머신

Windows 11 Home 에는 Hyper-V 가 없으니 VirtualBox 를 쓴다.

1. VirtualBox 를 설치한다.
2. [HA Windows 설치 페이지](https://www.home-assistant.io/installation/windows)에서 VirtualBox 용 `.vdi` 이미지를 받아 압축을 푼다.
3. VirtualBox 에서 새로 만들기. 이름은 `Home Assistant`, ISO 는 비워 둔다. OS 는 Linux, 배포판은 Oracle Linux (64-bit).
4. 메모리 3072 MB, CPU 2개, "EFI 사용" 체크. 디스크는 "가상 하드 디스크 추가 안 함".
5. 설정의 저장소에서 SATA 컨트롤러에 받아 둔 `.vdi` 를 붙인다.
6. 설정의 네트워크에서 연결 방식을 "브리지 어댑터" 로 바꾸고, 지금 인터넷에 쓰는 어댑터(Wi-Fi 또는 이더넷)를 고른다.
7. 시작하고 몇 분 뒤 `http://homeassistant.local:8123` 을 연다. 안 열리면 VM 창에 나온 IP 로 연다. 계정을 만든다.

공식 최소 메모리는 2GB 인데 Music Assistant 까지 올리면 3GB 는 줘야 한다. RAM 이 8GB 인 컴퓨터에서는 4GB 를 넘기면 Windows 쪽이 빠듯하다. 공유기에서 VM 에 고정 IP(DHCP 예약)를 걸어 두면 아래 주소가 바뀌지 않는다.

## 2. 로그온할 때 자동으로 켜기

까치처럼 시작 프로그램 폴더나 작업 스케줄러에 넣는다. 창 없이 띄우는 명령이다.

```
"C:\Program Files\Oracle\VirtualBox\VBoxManage.exe" startvm "Home Assistant" --type headless
```

끌 때는 HA 메뉴에서 끄거나 `VBoxManage controlvm "Home Assistant" acpipowerbutton` 을 쓴다. 노트북이 잠들면 VM 도 멈추니 잠자기는 까치 때처럼 꺼 둔다.

## 3. ha-mcp

HA OS 에서는 앱(예전 이름은 애드온)으로 까는 게 가장 간단하고 토큰이 필요 없다.

1. HA 설정 → 앱 → 앱 설치 → 오른쪽 위 ⋮ → 저장소에 `https://github.com/homeassistant-ai/ha-mcp` 를 추가한다.
2. "Home Assistant MCP Server" 를 설치하고 시작한다.
3. 로그 탭에 나온 주소를 복사한다. `http://<HA IP>:9583/private_…` 꼴이다.

이 주소가 곧 비밀번호다. 아는 사람은 누구든 HA 를 관리자로 다룰 수 있으니 `.env.local` 밖으로 꺼내지 않는다. HA 2026.11 이상이면 마켓플레이스의 HA-MCP 통합으로 HA 안에서 돌리는 방법도 있다. 둘 중 하나만 쓴다.

## 4. 까치에 연결

까치 폴더의 `.env.local` 에 한 줄을 넣고 까치를 다시 시작한다.

```
KKACHI_HA_MCP_URL=http://192.168.0.50:9583/private_…
```

비어 있으면 까치는 HA 없이 돈다. 연결되면 까치 홈 대화에 HA 도구 7개가 붙는다. `ha_get_overview`, `ha_search`, `ha_get_state`, `ha_call_service`, 그리고 자동화를 읽고 쓰고 지우는 `ha_config_get_automation`, `ha_config_set_automation`, `ha_config_remove_automation` 이다. ha-mcp 도구는 77개인데 전부 붙이면 정의만 매 턴 7만 토큰쯤 되어 일상에 쓰는 것만 골랐다. 더 필요하면 `kkachi.mcp.json` 의 `chat` 목록에 넣는다.

공기계 대화는 설정의 "도구" 를 따른다. 전체면 까치 홈과 같은 도구라 공기계에 "거실 불 켜줘" 라고 해도 된다. 제한이면 HA 도구가 없다. 방에 있는 누구나 공기계에 말할 수 있다는 점을 생각해서 고른다.

`data/service.log` 에 `mcp: ha (…) did not answer` 가 없으면 연결된 것이다. 까치 홈에서 "집에 뭐가 연결돼 있어?" 라고 물어 확인한다.

## 5. 스마트 전구

HA 설정 → 기기 및 서비스 → 통합 추가에서 전구 브랜드(Philips Hue, IKEA, Tuya/Smart Life, Matter 등)를 추가한다. 기기를 영역(거실, 침실)에 넣어 두면 까치가 "거실 불" 을 쉽게 찾는다. 그다음은 말로 하면 된다. "거실 불 따뜻한 색으로 켜줘", "매일 밤 11시에 거실 불 꺼지게 해줘". 뒤의 것은 HA 자동화로 만들어진다.

## 6. 음악: Music Assistant 와 Apple Music

1. HA 앱 스토어에서 Music Assistant 를 설치하고 시작한다. 웹 화면은 `http://<HA IP>:8095` 다. 앱으로 설치했으면 Music Assistant 설정에서 이 포트를 먼저 열어야 할 수 있다.
2. Music Assistant 에서 음악 소스로 Apple Music 을 추가하고 "Authenticate with Apple Music" 으로 Apple ID 로그인을 한다. `:8095` 주소에서 해야 로그인 뒤 제대로 돌아온다.
3. 재생할 스피커(AirPlay, HomePod, Chromecast, Sonos 등)를 Music Assistant 플레이어로 추가한다. 블루투스 스피커는 바로 붙지 않는다.
4. HA 에 Music Assistant 통합을 추가하면 스피커가 미디어 플레이어로 잡힌다.

그러면 "거실 스피커에서 아이유 틀어줘" 를 까치가 `ha_call_service` 로 `music_assistant.play_media` 를 불러 처리한다.

Apple Music 은 유료 구독이 있어야 하고, Apple 이 공식으로 허용한 방식이 아니다(Music Assistant 문서에도 "use at your own risk"). 로그인은 180일마다 다시 해야 한다. 음질은 AAC 256kbps 까지이고 무손실과 Dolby Atmos 는 안 되며, 곡 사이에 최대 5초쯤 공백이 생길 수 있다.

## 7. 공기계를 HA 센서로

공기계에 HA Companion 앱을 깔면 HA 기기로 붙어 센서 값을 보낸다. 까치 `/device` 페이지와 같이 쓸 수 있다.

| | iPhone | Android |
|---|---|---|
| 센서 | 배터리, 위치, 활동, 걸음, 기압 | 조도, 근접, 기압, 배터리, 화면 상태, 볼륨 등 (대부분 직접 켜야 함) |
| 백그라운드 갱신 | 위치가 바뀔 때 등 iOS 가 정하는 때 | 15분마다, 설정하면 1분마다 |
| HA 에서 하는 조작 | 키오스크 모드로 앱이 앞에 있을 때 밝기와 볼륨 | 소리 내어 읽기(TTS 알림), 화면 켜기, 밝기, 손전등, 볼륨, 앱 실행 |

Android 공기계는 TTS 알림으로 스피커 노릇까지 한다. iPhone 은 센서 위주다. 소리 크기(마이크 레벨) 센서는 둘 다 없어서 그건 계속 까치 `/device` 가 맡는다.

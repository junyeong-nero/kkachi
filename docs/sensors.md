# 공기계 기능

공기계(iPhone 웹 페이지 `/device`)에서 까치가 쓸 수 있는 기능이다. 서비스 소개는 [modules.md](modules.md), 구현은 kkachi-devices 서비스: `services/devices/devices.ts`(기기 허브), `device.html`(기기 페이지), `tools.ts`(MCP 도구).

Edge headless 의 가짜 카메라와 마이크로 확인했고, iPhone 실기기로는 아직 확인하지 못했다.

## 원칙

- kkachi-devices 가 중계만 하고 저장하지 않는다. 이 서비스가 WebSocket 으로 기기에 요청하고, 결과(사진·측정값)를 메모리에서 바로 넘긴다. 디스크·memory 레포에 쓰지 않는다
  - 예외: 사진은 모델이 봐야 하므로 그 턴의 Pi 대화 기록(`data/pi-sessions/`, 이 컴퓨터)에 남는다. 앱에서 첨부한 사진과 같다
- 기기 화면에서 입력·출력을 하나씩 켜고 끈다. 출력(말하기, 조명)과 입력(말 걸기, 사진, 소리 크기, 센서, 위치) 스위치 카드. 꺼 둔 것은 기기가 거절하고 서버도 알아서, 까치가 "기기에서 꺼 두었어요"라고 답한다. 스위치는 기기(localStorage)에 남아 새로고침해도 유지. 까치가 지금 하는 일(찍는 중, 재는 중 …)과 마지막으로 한 일이 기기 화면에 보인다
- 권한은 "탭해서 시작" 한 번에 받는다. 카메라·마이크·움직임·위치 권한 창을 그때 띄운다. 나중에 뜨는 권한 창은 아무도 누르지 않아 멈춘다
- 공기계에 말한 것이 어떤 도구를 쓸지는 설정이 정한다 ([bus.md](bus.md)). 기본은 폰 앱 대화와 같은 세션·도구다. "제한"이면 `list_devices`·`device_speak`·`device_light` 와 노트 도구만 쓰고, 카메라·소리·센서는 폰 앱에서만
- 기기는 접속할 때 지원하는 웹 API 를 보고한다(`GET /api/device/list` 의 `features`)

## 쓸 수 있는 기능

| 기능 | 웹 API | 까치 도구 | 메모 |
|---|---|---|---|
| 스피커 | Web Audio | `device_speak` | 첫 탭으로 소리 켜기 필요 |
| 카메라 | `getUserMedia` (video) | `device_snapshot` | 후면 기본, `camera: "front"`. 찍을 때만 켜고 바로 끔(초록 점 잠깐). 폰 앱 답 아래 사진 표시 |
| 밝기 (조도 센서 대신) | 카메라 프레임 평균 휘도 | `device_snapshot` 결과 | 0 어두움 ~ 100 밝음. 자동 노출 때문에 대략값 |
| 마이크: 소음 크기 | Web Audio (RMS) | `device_sound_level` | 1~10초, quiet / moderate / loud. 녹음은 남기지 않음. 정확한 측정을 위해 자동 게인·잡음 억제 끔 |
| 마이크: 말 걸기 | `getUserMedia` (audio) | 누르고 말하기 | WebSocket `input`/`ack`/`reply` ([bus.md](bus.md)) |
| 가속도·자이로 | `DeviceMotionEvent` | `device_sensors` | 마지막으로 움직인 때, 최근 10분 최대 흔들림. iOS 는 탭할 때 권한 요청 |
| 방향·나침반 | `DeviceOrientationEvent` (`webkitCompassHeading`) | `device_sensors` | 놓인 자세(화면 위로/세워짐/옆으로), 방위 |
| 위치 | Geolocation | `device_sensors` | 위도·경도·오차. 센서와 따로 켜고 끔. 집에 둔 기기는 쓸 일 적음 |
| 켜고 끄기 | 기기 화면 스위치 | 모든 도구 | 꺼 둔 기능은 거절. 새로고침해도 유지 |
| 화면 조명 | 전체 화면 색 + 어둡게 | `device_light` | 기기 화면 밝기 설정보다 밝게는 못 함. 화면을 탭하면 꺼짐 |
| 화면 켜 두기 | Wake Lock | `/device` 페이지 | iOS 16.4+, 홈 화면 앱은 18.4 전 버그 |

아직 없는 것은 푸시 알림(Web Push)이다. iOS 는 홈 화면 앱에서만 되고 service worker 와 VAPID 키가 필요하다. Face ID 와 Touch ID(WebAuthn)는 인증이라 쓰지 않는다. 접근 경계는 tailnet 이다.

## iPhone 웹에서 안 되는 기능

| 기능 | 웹 API | iPhone | Android Chrome |
|---|---|---|---|
| 조도 센서 | `AmbientLightSensor` | 안 됨 | 플래그 뒤에서만 |
| 근접 센서 | `ProximitySensor` | 안 됨 | 안 됨 |
| 기압계 | (웹 API 없음) | 안 됨 | 안 됨 |
| 배터리 | `navigator.getBattery` | 안 됨 | 됨 |
| 진동 | `navigator.vibrate` | 안 됨 | 됨 |
| NFC | `NDEFReader` | 안 됨 | 됨 |
| Bluetooth | `navigator.bluetooth` | 안 됨 | 됨 |

## 써 보기

공기계에서 `/device` 를 열고 "탭해서 시작"을 누른 뒤 권한 창(마이크, 카메라, 동작 및 방향, 위치)을 모두 허용한다. 그다음 폰 앱에서 시킨다.

- "거실에서 안녕이라고 말해줘": 스피커
- "거실 사진 찍어서 뭐가 보이는지 알려줘": 카메라와 밝기. 답 아래에 사진이 보인다
- "거실 주변 시끄러워?": 소음
- "거실 센서 읽어줘": 자세, 움직임, 나침반, 위치. 기기를 들었다 놓고 다시 물으면 "방금 움직임"
- "거실 화면 따뜻한 색 조명으로 켜줘", "꺼줘": 조명

기기 화면에서 사진 스위치를 끄고 "사진 찍어줘"라고 하면 까치가 꺼 두었다고 답한다. 기기가 지원하는 기능은 설정 → 기기에서 볼 수 있다.

## 다음 단계

- 움직임 감지 알림: 기기가 프레임 차이로 움직임을 감지하면 사진 한 장을 폰 앱에 알림 (Web Push)
- 실시간 보기: 폰 앱에서 1초에 한 장 정도로 보기 (서버가 중계, 저장 없음)

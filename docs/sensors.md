# 공기계 센서·기능 체크리스트

공기계(iPhone 웹 페이지 `/device`)에서 쓸 수 있는 기능을 까치 도구로 붙인 현황. 계획은 [plan.md](plan.md) "확장 방향: 에이전트 허브", 구현은 `src/devices.ts`(서버), `src/web/device.html`(기기), `src/device-tools.ts`(도구 정의).

## 원칙

- **까치 core 가 관리하고 저장하지 않는다.** 서버가 WebSocket 으로 기기에 요청하고, 결과(사진·측정값)를 메모리에서 바로 넘긴다. 디스크·memory 레포에 쓰지 않는다
  - 예외: 사진은 모델이 봐야 하므로 그 턴의 Pi 대화 기록(`data/pi-sessions/`, 이 컴퓨터)에 남는다. 앱에서 첨부한 사진(M5)과 같다
- **권한은 "탭해서 시작" 한 번에 받는다.** 카메라·마이크·움직임·위치 권한 창을 그때 띄운다. 나중에 뜨는 권한 창은 아무도 누르지 않아 멈춘다
- **공기계 포트(누르고 말하기)는 보고 듣는 도구를 못 쓴다.** 방에 있는 누구나 말할 수 있으므로 `device_snapshot`·`device_sound_level`·`device_sensors` 는 폰 앱(개인 포트)에서만. 포트는 `list_devices`·`device_speak`·`device_light` 와 노트 도구만
- 기기는 접속할 때 지원하는 웹 API 를 보고한다(`GET /api/devices` 의 `features`). 아래 "실기기 확인"은 이 값과 실제 동작으로 채운다

## 체크리스트

범례: ✅ 됨 · ⬜ 아직 · ➖ 이 환경에서 확인 불가 · ❌ 플랫폼이 지원 안 함

가짜 기기 확인은 Edge headless(가짜 카메라·마이크, `--use-fake-device-for-media-stream`)에서 실제 `/device` 페이지 코드로 했다 (2026-11-25).

### 쓸 수 있는 기능

| 기능 | 웹 API | 까치 도구 | 구현 | 가짜 기기 확인 | iPhone 실기기 | 메모 |
|---|---|---|---|---|---|---|
| 스피커 | Web Audio | `device_speak` | ✅ | ✅ 재생 완료 응답 | ⬜ | 첫 탭으로 소리 켜기 필요 |
| 카메라 | `getUserMedia` (video) | `device_snapshot` | ✅ | ✅ 1280×720 JPEG, 모델이 내용 설명 | ⬜ | 후면 기본, `camera: "front"`. 찍을 때만 켜고 바로 끔(초록 점 잠깐). 폰 앱 답 아래 사진 표시 |
| 밝기 (조도 센서 대신) | 카메라 프레임 평균 휘도 | `device_snapshot` 결과 | ✅ | ✅ 41/100 | ⬜ | 0 어두움 ~ 100 밝음. 자동 노출 때문에 대략값 |
| 마이크: 소음 크기 | Web Audio (RMS) | `device_sound_level` | ✅ | ✅ -20 dBFS (가짜 마이크의 삐 소리) | ⬜ | 1~10초, quiet / moderate / loud. 녹음은 남기지 않음. 정확한 측정을 위해 자동 게인·잡음 억제 끔 |
| 마이크: 말 걸기 | `getUserMedia` (audio) | 누르고 말하기 (M8) | ✅ | ✅ (가짜 기기로 STT→답→음성) | ⬜ | `/api/device/talk` |
| 가속도·자이로 | `DeviceMotionEvent` | `device_sensors` | ✅ | ➖ 데스크톱에 센서 없음 | ⬜ | 마지막으로 움직인 때, 최근 10분 최대 흔들림. iOS 는 탭할 때 권한 요청 |
| 방향·나침반 | `DeviceOrientationEvent` (`webkitCompassHeading`) | `device_sensors` | ✅ | ➖ 데스크톱에 센서 없음 | ⬜ | 놓인 자세(화면 위로/세워짐/옆으로), 방위 |
| 위치 | Geolocation | `device_sensors` | ✅ | ➖ headless 는 권한 없음 | ⬜ | 위도·경도·오차. 집에 둔 기기는 쓸 일 적음 |
| 화면 조명 | 전체 화면 색 + 어둡게 | `device_light` | ✅ | ✅ 색·밝기 적용, 끄기 | ⬜ | 기기 화면 밝기 설정보다 밝게는 못 함. 화면을 탭하면 꺼짐 |
| 화면 켜 두기 | Wake Lock | `/device` 페이지 (M6) | ✅ | ➖ | ⬜ | iOS 16.4+, 홈 화면 앱은 18.4 전 버그 |
| 푸시 알림 | Web Push | 없음 | ⬜ | | | 센서가 아니라 폰 앱 알림. 움직임 감지 알림(다음 단계)에 필요. iOS 는 홈 화면 앱에서만. service worker + VAPID 키 필요 |
| Face ID / Touch ID | WebAuthn | 해당 없음 | | | | 센서가 아니라 인증. 접근 경계는 tailnet 이라 지금은 쓰지 않음 |

### iPhone 웹에서 안 되는 기능

기기가 보고하는 `features` 로 실기기에서 "없음"을 확인한다. Android Chrome 은 일부 지원(나중에 Android 지원 시 다시 볼 것).

| 기능 | 웹 API | iPhone | 실기기 확인 | Android Chrome |
|---|---|---|---|---|
| 조도 센서 | `AmbientLightSensor` | ❌ | ⬜ | 플래그 뒤에서만 |
| 근접 센서 | `ProximitySensor` | ❌ | ⬜ | ❌ |
| 기압계 | (웹 API 없음) | ❌ | 해당 없음 | ❌ |
| 배터리 | `navigator.getBattery` | ❌ | ⬜ | ✅ |
| 진동 | `navigator.vibrate` | ❌ | ⬜ | ✅ |
| NFC | `NDEFReader` | ❌ | ⬜ | ✅ |
| Bluetooth | `navigator.bluetooth` | ❌ | ⬜ | ✅ |

## 실기기 확인 방법

1. 공기계에서 `/device` 를 새로고침한다 (예전 페이지면 "새 버전이 있어요 · 눌러서 새로고침"이 뜸)
2. "탭해서 시작"을 누르고 권한 창(마이크, 카메라, 동작 및 방향, 위치)을 모두 허용한다
3. 폰 앱에서 하나씩 시킨다
   - "phone-mini에서 안녕이라고 말해줘" → 스피커
   - "phone-mini로 사진 찍어서 뭐가 보이는지 알려줘" → 카메라·밝기, 답 아래 사진
   - "phone-mini 주변 시끄러워?" → 소음
   - "phone-mini 센서 읽어줘" → 자세·움직임·나침반·위치. 기기를 들었다 놓고 다시 물으면 "방금 움직임"
   - "phone-mini 화면 따뜻한 색 조명으로 켜줘" / "꺼줘" → 조명
4. 지원 목록: 설정 → 기기, 또는 `GET /api/devices` 의 `features` 로 위 "안 되는 기능" 표를 채운다
5. 결과를 이 문서의 "iPhone 실기기" 칸에 적는다

## 다음 단계

- 움직임 감지 알림: 기기가 프레임 차이로 움직임을 감지하면 사진 한 장을 폰 앱에 알림 (Web Push)
- 실시간 보기: 폰 앱에서 1초에 한 장 정도로 보기 (서버가 중계, 저장 없음)

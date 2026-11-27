# 확장: 추천 MCP

까치는 MCP 를 붙여서 넓힌다([philosophy.md](philosophy.md) 1번). 이 문서는 붙여 쓸 만한 MCP 서버 목록이다. 아직 직접 써 본 것은 아니고, 저장소 상태(별, 마지막 push)는 2026-11-25 에 확인했다. 써 보고 고장 나면 목록에서 빼고, 잘 되면 그렇게 적는다.

## 고르는 기준

- 로컬 우선. 집 안 네트워크(LAN)로 바로 제어하는 것을 먼저 둔다. 가져온 도구는 사용자의 선택이지만, 고를 수 있으면 클라우드를 거치지 않는 쪽이 2번 원칙에 맞는다. 클라우드를 거치는 것은 표에 적는다.
- 허브 서버 없이. VM 이나 상시 서버를 더 띄우지 않아도 되는 것(1번 원칙). 전구 회사의 브리지 같은 작은 기기는 괜찮다.
- 살아 있는 프로젝트. 별이 거의 없는 개인 프로젝트도 넣되 그렇다고 적는다.

## 붙이는 법

까치 홈 메뉴의 설정, 도구에서 붙인다. 까치는 사용자의 Pi 설정이 아니라 자기 설정(`data/agent`)을 쓰므로, Claude Code 나 Codex 에 붙여 둔 서버는 따라오지 않는다. 필요한 것만 여기서 다시 붙인다.

- 추천: Home Assistant(ha-mcp, 주소만)와 LG ThinQ(LG 공식, 개인 액세스 토큰). 필요한 값만 묻는다.
- 직접 추가: 원격 서버는 주소(필요하면 토큰), 로컬 서버는 실행 명령과 환경 변수. 각 프로젝트 README 에 있는 그대로 쓴다. 명령은 까치 서버에서 실행된다.
- 붙인 서버는 켜고 끄거나 지울 수 있고, 연결됐는지와 도구 수가 보인다. 바꾸면 다음 말부터 쓴다.
- OAuth 로그인이 필요한 서버는 아직 안 된다. 로그인 뒤 돌아오는 곳이 까치 서버의 localhost 라서 폰에서 끝낼 수 없다. 삼성 SmartThings 공식 서버는 아는 클라이언트(ChatGPT, Claude)만 받아서 붙일 수 없다. SmartThings 기기는 Home Assistant 에 붙여서 쓴다.

`kkachi.mcp.json` 은 까치 자신의 서비스(기기, 기억)가 붙는 자리다. 여기 넣은 서버는 늘 켜져 있고 설정에서 끌 수 없다.

붙인 서버는 까치 홈 대화와 공기계에서 똑같이 쓴다. 공기계에는 방에 있는 누구나 말할 수 있으니, 멀리 닿는 서버(메일, 저장소, 브라우저)를 붙였다면 손님이 오는 곳의 기기는 음성을 닫아 둔다.

## 조명

| 서버 | 브랜드 | 연결 | 상태 | 메모 |
|---|---|---|---|---|
| [tapo](https://github.com/mihai-dinculescu/tapo) | TP-Link Tapo | 로컬 | ★879, 2026-11 | 전구, 조명 띠, 플러그, 허브, 센서까지. 라이브러리와 함께 관리되어 가장 탄탄하다 |
| [hue-mcp](https://github.com/ThomasRohde/hue-mcp) | Philips Hue | 로컬 (Hue 브리지) | ★33, 2025-10 | Hue 쪽에서 가장 많이 쓰인다 |
| [HueMCP](https://github.com/mbruton/HueMCP) | Philips Hue | 로컬 (브리지 CLIP v2) | ★0, 2026-05 | 클라우드 계정 없이 브리지하고만 통신 |
| [hue-cli](https://github.com/qselle/hue-cli) | Philips Hue | 로컬, 원하면 Hue 클라우드 | ★0, 2026-03 | Go 실행 파일 하나. 명령줄 도구 겸 MCP |
| [hue-mcp-server](https://github.com/pedrof/hue-mcp-server) | Philips Hue | 로컬 (브리지) | ★0, 2025-12 | 네트워크 서버로 뜬다(Docker 가능) |
| [mcp-tapo-smart-home](https://github.com/amvaswani/mcp-tapo-smart-home) | Tapo, Kasa | 로컬 (python-kasa) | ★0, 2026-03 | 개인 프로젝트 |
| [WiZ-Smart-Bulb-MCP](https://github.com/axenov/WiZ-Smart-Bulb-MCP) | WiZ | 로컬 (UDP, 허브 없음) | ★2, 2025-11 | 켜고 끄기, 색, 밝기 정도 |
| [govee-mcp](https://github.com/evefromwayback/govee-mcp) | Govee | 로컬 우선, 안 되면 클라우드 | ★0, 2026-06 | 플러그와 가전은 클라우드 |
| [lifx-mcp](https://github.com/874wokiite/lifx-mcp) | LIFX | 로컬 (UDP) | ★1, 2025-04 | 색 바꾸기만 |
| [lychnos-mcp](https://github.com/npsaltakis/lychnos-mcp) | 여러 브랜드 | 로컬 | ★0, 2026-11 | Windows, Linux 용 대시보드 겸 MCP |

전구를 새로 산다면 Tapo 나 Hue 가 무난하다. Tapo 는 허브 없이 Wi-Fi 로 붙고 MCP 가 탄탄하다. Hue 는 브리지가 필요하고 비싸지만 API 와 MCP 선택지가 가장 많다. WiZ 는 싸고 프로토콜이 단순해서, 지금 MCP 가 작아도 까치 플러그인으로 직접 만들기 쉽다.

## 집 전체

| 서버 | 대상 | 연결 | 상태 | 메모 |
|---|---|---|---|---|
| [ha-mcp](https://github.com/homeassistant-ai/ha-mcp) | Home Assistant | 로컬 | ★8112, 2026-11 | HA 의 모든 기기와 자동화. HA VM 이 필요하다. 붙이는 법은 [ha.md](ha.md) |
| HA 기본 MCP 서버 (`mcp_server`) | Home Assistant | 로컬 | 공식 | Assist 에 노출한 기기를 켜고 끄는 정도 |
| Samsung SmartThings (Labs) | SmartThings | 클라우드 (`https://mcp.smartthings.com/mcp`) | 공식, 한국 제공 | 직접 확인하지 않았다. 로그인을 거칠 것으로 보여 Pi 어댑터로 붙인다 |
| [tuya-mcp-sdk](https://github.com/tuya/tuya-mcp-sdk) | Tuya, Smart Life | 클라우드 | 공식, ★68 | Tuya 개발자 플랫폼의 AI 에이전트용 SDK. 집 기기를 바로 다루는 MCP 는 아니다 |

## 음악

[Music Assistant](https://github.com/music-assistant/server)(★3374)가 Apple Music 과 Spotify 를 AirPlay, Chromecast, Sonos 스피커로 튼다. HA 앱으로 돌고 ha-mcp 로 부른다([ha.md](ha.md) 6). HA 없이 바로 붙는 음악 MCP 는 아직 찾아보지 않았다.

## 반대 방향

다른 에이전트도 까치를 쓸 수 있다. 기억은 `/mcp/memory`, 공기계는 `/mcp/devices` 를 Claude Desktop, Codex 등의 MCP 설정에 넣는다(README).

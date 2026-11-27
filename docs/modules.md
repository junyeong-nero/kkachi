# 모듈

까치는 프로세스 세 개로 돈다. core 가 에이전트 루프와 MCP 연결을 맡고, kkachi-devices 와 kkachi-memory 는 core 가 띄우는 독립 MCP 서비스다. 그림은 [architecture.svg](architecture.svg), 원칙은 [philosophy.md](philosophy.md)에 있다.

```
까치 홈, 기기, 다른 에이전트 ─ Tailscale Serve (HTTPS) ─ kkachi-core (Bun, 127.0.0.1:4300)
   ├─ 받아쓰기 (Groq) → 다듬기 (켜 두면 Groq LLM), 읽어 주기 (기본은 기기 내장, 고르면 Edge)
   ├─ Pi RPC: 대화(기기에 한 말도), 사서, 30분 대화 정리
   ├─ kkachi-devices (4301): 기기 입출력 MCP
   └─ kkachi-memory (4302): 노트와 git MCP
```

밖에서 닿는 것은 core 뿐이다. 두 서비스의 페이지와 MCP 는 core 가 자기 주소에서 중계한다. Pi 는 core 의 자식 프로세스이고 stdin/stdout 으로 JSONL 을 주고받는다. 모델과 MCP 인증은 Pi 에, 받아쓰기와 다듬기 키는 `.env.local` 에만 있어서 브라우저는 키를 모른다.

## core (`src/`)

| 파일 | 하는 일 |
|---|---|
| `server.ts` | 까치 홈 화면, `/api/stt`, `/api/tts`, `/api/turn` (SSE), 입력 버스 `/api/bus/*` (서비스만, 내부 토큰), 까치 홈 피드 `/api/feed`. 서비스 경로를 WebSocket 까지 중계한다 |
| `turn.ts` | 한 턴. 아래 "한 턴의 흐름" |
| `pi.ts` | Pi 를 띄우고 RPC 와 이벤트를 다룬다. Pi 가 대화창(dialog)을 요청하면 자동으로 취소하고, Pi 의 자동 재시도는 끈다 |
| `models.ts` | `KKACHI_MODEL` 의 모델 목록. 한도(429)에 걸리면 같은 턴을 다음 모델로 다시 보낸다 |
| `speech.ts`, `polish.ts`, `vocabulary.ts` | 받아쓰기, 받아쓴 말 다듬기, 다듬기에 넣는 용어 목록(memory 레포의 `vocabulary.md`, 노트 제목, 기본 용어). [design.md](design.md) "음성 처리" |
| `replay.ts` | 턴의 이벤트를 id 로 보관한다. 폰에서 연결이 끊겨도 앱이 받은 데서부터 이어 받는다 |
| `bus.ts`, `inbox.ts`, `feed.ts` | 입력 버스. 기기의 입력을 id 하나당 한 번, 60초 안에만 접수하고, 까치 홈 대화의 한 턴으로 답해 그 기기로 보내고 폰 피드에도 올린다. [bus.md](bus.md) |
| `agent-dir.ts`, `accounts.ts`, `mcp-servers.ts`, `mcp-login.ts` | 까치 자신의 Pi 설정(`data/agent`). 사용자의 `~/.pi/agent` 와 따로다. 계정(구독 로그인과 API 키, `auth.json`; Groq 처럼 까치가 직접 쓰는 키는 `keys.json`)과 까치 홈에서 붙인 MCP 서버(`mcp.json`, Pi 의 MCP 기능이 연결. OAuth 로그인은 `pi mcp login` 을 띄우고 폰에서 붙여 넣은 돌아올 주소를 서버에서 대신 연다), 웹 검색 패키지 하나. Pi 는 `PI_CODING_AGENT_DIR` 로 여기를 쓰고 사용자 스킬은 읽지 않는다 |
| `conversations.ts` | 까치 홈의 대화들. Pi 세션 파일(`data/pi-sessions`)에서 목록과 내용을 읽는다. 메뉴의 지난 대화, 앱을 다시 열 때의 대화 |
| `mcp-bridge.ts`, `services.ts` | `kkachi.mcp.json` 을 읽어 서버 목록과 에이전트별 허용 도구를 정한다. Pi 를 띄울 때 `tools/list` 로 도구를 받아 넘긴다. `command` 가 있는 서버는 core 가 띄우고 멈추면 다시 띄우며, `routes` 는 core 주소에서 중계한다 |
| `memory.ts` | memory 서비스의 `git_*` 도구를 부른다. 턴 전 sync, 턴 끝 checkpoint, 사서와 대화 정리의 작업 사본 |
| `review.ts` | 30분 조용하면 대화를 노트와 견줘 빠진 것을 채운다 |
| `librarian.ts` | 사서. 노트를 정리하고 목록을 다시 쓴다 |
| `settings.ts` | 설정 화면에서 바꾼 값(`data/settings.json`): 목소리와 말 빠르기, 모델, 생각 깊이, 기기 대화 |
| `config.ts`, `check.ts` | 환경 변수 설정과 시작할 때의 점검. git 이나 Pi 가 없으면 서버를 멈추고, 음성 쪽이 빠지면 그 기능만 끈다 |
| `web/` | 까치 홈. 화면 동작은 [design.md](design.md), 색과 글꼴은 [DESIGN.md](../DESIGN.md) |

## kkachi-devices (`services/devices/`)

안 쓰는 폰과 태블릿을 스피커, 조명, 카메라, 센서, 마이크로 쓰게 해 주는 서비스다. 기기는 `/device` 페이지를 열어 WebSocket 으로 붙고, 까치 홈에서 허용하면 토큰을 받는다. 에이전트가 무엇을 쓸지는 까치 홈에서 정해 이 서비스가 기기마다 기억하고, 기기 화면은 상태만 보여 준다.

- 에이전트가 쓰는 MCP 도구는 `list_devices`, `device_speak`, `device_snapshot`, `device_sound_level`, `device_sensors`, `device_light` 다. core 안에서는 `/mcp`, 다른 에이전트는 `/mcp/devices` 로 쓴다.
- 사진과 측정값은 전달만 하고 저장하지 않는다.
- 기기에 한 말은 WebSocket `input` 으로 받아 core 의 입력 버스에 넘기고 ACK 를 돌려준다. 답은 core 만 부를 수 있는 `device_reply` 로 온다. 까치 홈은 `POST /api/device/<id>/read` 로 그 방의 센서, 소리 크기, 사진을 직접 읽는다.
- 폴더만 복사해도 MCP 서버로 돈다. 그때는 core 가 없으니 기기에 한 말을 거절하고, 기기는 자기 목소리로 말한다.

기능별 현황은 [sensors.md](sensors.md), 서비스 사용법은 [services/devices/README.md](../services/devices/README.md), core 와의 약속은 [PROTOCOL.md](../services/devices/PROTOCOL.md)에 있다.

## kkachi-memory (`services/memory/`)

노트(Markdown)와 git 을 맡는다. 까치에서 git 을 아는 곳은 여기뿐이고, git 작업은 한 번에 하나씩 한다.

- 에이전트가 쓰는 MCP 도구는 `memory_list`, `memory_search`, `memory_read`, `memory_write`, `memory_edit`, `memory_move`, `memory_delete`, `memory_undo` 다. 다른 에이전트는 `/mcp/memory` 로 쓴다.
- 도구로 바꾸면 그 경로만 바로 커밋한다. 요청의 `meta.commit` 이 `later` 면 커밋하지 않고, core 가 턴 끝에 한 번에 한다.
- core 만 쓰는 `git_*` 도구(내부 토큰)로 sync, checkpoint, 작업 사본을 다룬다.
- 원격이 있어도 `KKACHI_MEMORY_SYNC=1` 일 때만 pull 과 push 를 한다.
- 폴더만 복사해도 MCP 서버로 돈다.

까치 홈 대화의 Pi 는 노트 파일을 직접 고치고, 다른 에이전트는 `memory_*` 도구로만 접근한다. 서비스 사용법은 [services/memory/README.md](../services/memory/README.md)에 있다.

## 나머지

| 위치 | 하는 일 |
|---|---|
| `lib/` | core 와 서비스가 같이 쓰는 코드. MCP 서버와 클라이언트, 입구 검사(Host 와 Origin)와 내부 토큰, TTS, 로그, 경로. 서비스 폴더의 `lib/` 는 복사본이고 테스트가 같게 유지한다 |
| `pi/kkachi.ts` | 까치의 Pi 확장. `end_conversation`, `handoff`, `tidy_notes`, `send_to_phone` 을 더하고, core 가 고른 MCP 도구를 그대로 등록한다 |
| `prompts/` | `kkachi.md` 는 Pi 기본 프롬프트와 사용자 전역, memory 레포의 `AGENTS.md` 뒤에 덧붙인다. `librarian.md` 는 기본 프롬프트를 대신하고 memory 레포의 `AGENTS.md` 만 붙인다. `review.md` 는 대화 정리에 쓴다 |
| `kkachi.mcp.json` | core 가 직접 붙는 MCP 서버와, 에이전트(`chat`, `port`, `librarian`)마다 허용할 도구. Home Assistant 도 여기에 붙는다([ha.md](ha.md)). 더 붙일 만한 서버는 [extensions.md](extensions.md) |
| `templates/memory/` | 새 memory 레포의 틀. `AGENTS.md` 에 구조, 이름, 형식, 민감 정보, 목록, 정리 규칙이 있다 |
| `scripts/` | `init.ts` (설정), `service.ts` (자동 시작), `import-notes.ts` (기존 노트 가져오기) |
| `install.sh`, `install.ps1` | 빠진 도구를 깔고 까치를 받아 `bun run init` 을 실행한다 |
| `data/` | git 밖의 비공개 상태. 설정, 기기 토큰, 정리 대기 중인 대화, Pi 세션, 로그 |

## 한 턴의 흐름

1. 대화 정리나 사서가 돌고 있으면 멈춘다. 새 메시지가 먼저이고, 정리 대기 중인 대화는 남는다.
2. memory 서비스에 sync 를 요청한다. 동기화를 켰고 원격이 있으면 `git pull --ff-only` 다.
3. `[지금: <현지 시각>]` 을 붙여 Pi 에 보낸다. 빠뜨리면 모델이 예시 날짜를 오늘로 착각한다.
4. 답은 오는 대로 화면에 그리고(`delta`), 문장이 완성되면 읽어 주기로 넘긴다(`sentence`). 같은 메시지가 그 뒤에 도구를 부르면 앞의 말은 진행 상황이었던 것이라 화면에서 지우고 재생을 멈춘다(`retract`).
5. 턴이 끝나면 memory 서비스가 바뀐 것을 커밋 하나로 만든다. 메시지는 사용자가 한 말이다. 동기화를 켰으면 push 하고, 커밋에 든 노트를 화면 칩으로 보여준다.
6. 한도 오류(429)면 다음 모델로 다시 보낸다. 모두 막히면 오류 문구를 띄운다.
7. `end_conversation` 이나 `handoff` 가 불렸으면 사서를 예약한다.

## 백그라운드 작업

### 대화 정리

마지막 턴 뒤 30분 동안 새 메시지가 없으면, 별도 Pi 가 정리 대기 중인 대화와 노트를 견준다. 노트에 없는 일정, 결정, 선호만 더하고, 바뀐 것이 있으면 `kkachi: 대화 정리 — <요약>` 으로 커밋한다. 더할 것이 없으면 커밋도 없다. 대화 세션은 그대로 이어진다.

대기 중인 대화는 memory 레포 밖 `data/conversation.jsonl` 에 둔다. 정리는 임시 git worktree 에서 하므로 새 메시지가 오면 그 사본만 버린다. 실패하거나 서버가 재시작해도 대기 중인 대화는 남고, 성공하면 지운다.

### 사서

memory 레포를 도서관처럼 유지한다. 레포를 열면 `README.md` 목록으로 무엇이 어디 있는지 보인다.

- 대화 정리 뒤, 대화가 끝났을 때(`end_conversation`, `handoff`), "정리해줘"(`tidy_notes`)라고 했을 때 돈다. 지난 정리 뒤로 바뀐 노트가 있을 때만이다.
- memory 레포 `AGENTS.md` 의 Tidying 규칙을 따른다. inbox 를 분류하고, 같은 주제를 합치고, 끝난 항목을 archive 로 옮기고, `README.md` 목록을 다시 쓴다. 사실과 결정 같은 내용은 바꾸지 않는다.
- 정리 한 번이 커밋 하나다(`kkachi: 정리 — 이동 N, 수정 N, 목록 갱신`). 실패하거나 취소되면 변경을 버린다.
- 서버를 시작할 때 레포에 남은 변경이 있으면 `git stash` 로 치운다. 중간에 끊긴 턴이나 정리가 다음 커밋에 섞이지 않게 하려는 것이다.

## 접속과 권한

- core 는 127.0.0.1 에만 열리고, 밖에서는 Tailscale Serve 로만 들어온다. 앱 로그인은 없고 tailnet 이 경계다. Tailscale Funnel 은 쓰지 않는다.
- 까치 홈 대화의 Pi 는 shell, 파일, 웹, MCP 를 확인 없이 쓴다. tailnet 에 들어올 수 있는 기기는 말로 명령을 실행시킬 수 있고, 웹 페이지에 숨은 지시(prompt injection)가 실행될 수도 있다. 혼자 쓰는 것을 전제로 받아들인 위험이다.
- 기기에는 방에 있는 누구나 말할 수 있다. 혼자 쓰는 집이라는 가정으로 기기도 까치 홈과 같은 도구를 쓴다. 손님이 오는 곳의 기기는 음성을 닫는다([bus.md](bus.md)).
- 턴마다 커밋 하나가 바로 남는다. "방금 거 취소해"로 되돌린다.

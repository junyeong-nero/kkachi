// Kkachi Home in English or Korean (Settings, Appearance, Language: the server's settings.lang). The
// app is written in Korean; in English each Korean phrase shown is looked up here: the page's own text
// and labels as they appear (a MutationObserver), the phrases the server sends (voice names, account
// notes, errors), and t() for phrases with values in them, written {name}. Nothing people wrote is
// translated: messages, replies, thinking, note titles, device and conversation names.
const LANG = localStorage.getItem("kkachi.lang") || (/^ko\b/i.test(navigator.language || "") ? "ko" : "en");
document.documentElement.lang = LANG;

const EN = {
  // ---- the conversation, the composer, the menu
  "까치 홈": "Kkachi Home", "메뉴": "Menu", "메뉴 열기": "Open menu", "메시지를 입력하세요": "Message Kkachi", "메시지": "Message",
  "사진 첨부: 찍거나 골라서 물어보세요": "Attach a photo: take or pick one to ask about", "말하기": "Speak",
  "눌러서 말하고 다시 눌러 멈춰요. 받아적은 말은 입력창에 들어가요. Space 를 누른 채로 말해도 돼요": "Tap to speak and tap again to stop. What is heard goes into the text box. You can also hold Space while you speak",
  "보내기": "Send", "새 대화": "New chat", "지난 대화": "Earlier chats", "기기 추가": "Add a device", "설정": "Settings", "대화": "Chats", "기기": "Devices",
  "집에 있는 까치예요": "Kkachi, at home",
  "물어보거나 시켜 보세요. 기억해 둘 것도 말해 주세요. 기기를 둔 방은 보고 들을 수 있어요.": "Ask, or ask for something to be done. Tell it what to remember. It can see and hear the rooms where you put a device.",
  "마이크를 쓸 수 없어요. 설정에서 마이크를 허용해 주세요.": "The microphone is not allowed. Allow it in the browser's settings.",
  "마이크 준비됐어요. 다시 눌러 말하세요": "The microphone is ready. Tap again to speak", "듣고 있어요. 다시 누르면 받아적어요": "Listening. Tap again to write it down",
  "마이크를 다시 연결했어요. 다시 눌러 말해 주세요": "The microphone was reconnected. Tap again to speak", "받아적는 중…": "Writing it down…",
  "잘 못 들었어요. 다시 말해 주세요.": "Didn't catch that. Please say it again.", "연결이 끊겼어요.": "The connection dropped.", "다시 보내기": "Send again",
  "노트 찾는 중": "Looking in the notes", "파일 보는 중": "Reading files", "기억하는 중": "Remembering", "파일 고치는 중": "Editing files", "웹에서 찾는 중": "Searching the web",
  "되돌리는 중": "Undoing", "다른 에이전트에게 맡기는 중": "Handing it to another agent", "사진 찍는 중": "Taking a photo", "소리 듣는 중": "Listening to the room",
  "기기 살펴보는 중": "Checking the device", "조명 바꾸는 중": "Changing the light", "기기로 말하는 중": "Speaking on a device", "도구 쓰는 중": "Using a tool", "작업하는 중": "Working",
  "보낸 사진": "Photo sent", "생각": "Thinking", "{s}초": "{s} s", "기기가 찍은 사진": "Photo from the device", "기억함: {name}": "Remembered: {name}",
  "저장했어요": "Saved", "저장하지 못했어요": "Could not save", "답하지 못했어요": "No answer", "{from}에서": "On {from}", "까치가 보냈어요": "From Kkachi",
  "(사진 {n}장)": "({n} photos)", "지금 대화. {when}": "Now. {when}", "대화를 열지 못했어요": "Could not open the chat", "아직 없어요": "None yet",
  "새 대화를 시작하지 못했어요": "Could not start a new chat", "새 대화를 시작했어요": "Started a new chat", "첨부한 사진 {n}": "Attached photo {n}", "사진 빼기": "Remove photo",
  "사진은 {n}장까지 보낼 수 있어요": "Up to {n} photos", "이 사진은 열 수 없어요": "This photo cannot be opened", "불러오는 중…": "Loading…", "불러오지 못했어요": "Could not load",
  "집에 연결할 수 없어요": "Home is not answering", "집, 기기 목록을 못 읽었어요": "Home, devices not read", "집, 기기 {n}대 켜짐": "Home: {n} on", "집": "Home", "{words}. 기기 보기": "{words}. Show devices",
  "AI 계정이 연결돼 있지 않아요. 까치 홈의 설정, 계정에서 연결해 주세요.": "No AI account is connected. Connect one in Settings, Accounts.",
  "모델이 응답하지 않아요. 잠시 뒤에 다시 말해 주세요.": "The model is not answering. Please try again in a moment.",
  "지금 모델들이 모두 바빠요. 잠시 뒤에 다시 말해 주세요.": "All models are busy right now. Please try again in a moment.",
  "노트 저장소를 동기화하지 못했어요. 컴퓨터에서 확인이 필요해요.": "Could not sync the notes repository. It needs a look on the computer.",
  "기억은 해두었는데 GitHub 에 올리지는 못했어요.": "Remembered, but could not push it to GitHub.", "문제가 생겼어요. 다시 말해 주세요.": "Something went wrong. Please say it again.",

  // ---- devices
  "허용을 기다려요": "Waiting to be allowed", "꺼져 있어요": "Off", "켜져 있어요. 화면을 한 번 눌러야 소리를 써요": "On. Its screen needs one tap for sound", "켜져 있어요": "On",
  "화면을 한 번 눌러야 해요": "Needs a tap on its screen", "허용": "Allow", "{name} 허용": "Allow {name}", "허용하지 못했어요": "Could not allow it",
  "기기 목록을 불러오지 못했어요": "Could not load the devices", "아직 없어요. 기기 추가에서 붙여요": "None yet. Add one with Add a device",
  "복사": "Copy", "주소 복사": "Copy address", "복사했어요": "Copied", "주소를 길게 눌러 복사해 주세요": "Press and hold the address to copy it",
  "이 주소를 여세요": "Open this address", "안 쓰는 폰이나 태블릿의 Safari 나 Chrome 에서요. 그 기기도 이 폰과 같은 Tailscale 계정에 로그인해 있어야 열려요.": "In Safari or Chrome on a spare phone or tablet. It opens only when that device is signed in to the same Tailscale account as this phone.",
  "이름을 붙이고 화면을 한 번 누르세요": "Name it and tap its screen once", "거실, 주방처럼 둔 곳의 이름이 좋아요. 그때 마이크, 카메라, 움직임, 위치 권한을 한꺼번에 물어요.": "The room it is in works well, like Living room or Kitchen. That tap asks for the microphone, camera, motion and location at once.",
  "여기서 허용하세요": "Allow it here", "메뉴의 기기 탭에 허용을 기다리는 기기로 나타나요.": "It shows up in the menu's Devices tab, waiting to be allowed.",
  "화면을 켜 두세요": "Keep its screen on", "자동 잠금을 꺼 두고 충전기에 꽂아 두면 좋아요.": "Turn off auto-lock and keep it on a charger.",
  "안 쓰는 폰이나 태블릿이 그 방에서 까치의 눈과 귀와 입이 돼요. 앱은 깔지 않아요.": "A spare phone or tablet becomes Kkachi's eyes, ears and voice in that room. No app to install.",
  "읽지 못했어요": "Could not read it", "기기 화면을 한 번 눌러야 해요": "Needs a tap on the device's screen", "권한이 없어요": "Not allowed", "기기가 꺼져 있어요": "The device is off", "읽을 수 없어요": "Cannot be read",
  "화면이 위로 누워 있어요": "Lying screen up", "화면이 아래로 엎어져 있어요": "Lying screen down", "세워져 있어요": "Standing up", "옆으로 누워 있어요": "Lying on its side", "기울어져 있어요": "Tilted",
  "{pose}. {dir}쪽을 봐요": "{pose}, facing {dir}", "북": "north", "북동": "northeast", "동": "east", "남동": "southeast", "남": "south", "남서": "southwest", "서": "west", "북서": "northwest",
  "어두워요. 불이 꺼진 것 같아요": "Dark. The lights seem to be off", "어둑해요": "Dim", "불이 켜진 방 정도로 밝아요": "Lit like a room with the lights on", "밝아요": "Bright", "햇빛처럼 아주 밝아요": "Very bright, like daylight",
  "{words}. 약 {lux} lx": "{words}. About {lux} lx", "밝기": "Brightness", "재는 중…": "Measuring…", "소리": "Sound", "조용해요": "Quiet", "보통이에요": "Moderate", "시끄러워요": "Loud", "{words}. 가끔 큰 소리가 나요": "{words}. Now and then something loud",
  "읽는 중…": "Reading…", "지금 움직이고 있어요": "Moving now", "{n}초 전에 움직였어요": "Moved {n} s ago", "{n}분 전에 움직였어요": "Moved {n} min ago", "페이지를 연 뒤로 움직이지 않았어요": "Not moved since its page opened",
  "움직임": "Motion", "놓인 자세": "Position", "위치": "Location", "알아요. 오차 {m} m": "Known, within {m} m", "지도": "Map",
  "꺼져 있어요. 그 기기에서 기기 페이지를 열어 두면 다시 켜져요.": "Off. It comes back when its device page is open on it.", "지금 이 방": "In the room now", "다시 읽기": "Read again",
  "사진": "Photo", "찍는 중…": "Taking…", "방금 찍었어요": "Just taken", "뒤쪽 카메라로 한 장 찍어요. 저장하지 않아요": "One photo with the back camera, not kept", "다시 찍기": "Take again", "찍기": "Take",
  "{name}에서 방금 찍은 사진": "Photo just taken on {name}", "기기 화면의 기록에 까치 홈에서 읽었다고 남아요.": "The device's own log notes that Kkachi Home read it.",
  "기기 화면을 한 번 눌러야 써요": "Needs a tap on the device's screen first", "이 기기에서 쓸 수 없어요": "Not available on this device", "까치가 {name} {cap}을(를) 쓰기": "Kkachi may use the {cap} on {name}",
  "바꾸지 못했어요": "Could not change it", "까치가 쓸 수 있는 것": "What Kkachi may use", "음성을 끄면 그 기기의 말하기 버튼이 사라져요.": "With Voice off, the device's talk button goes away.",
  "이 기기 삭제": "Delete this device", "'{name}' 기기를 삭제할까요? 다시 쓰려면 그 기기에서 처음부터 다시 붙여야 해요.": "Delete '{name}'? To use it again, add it from the start on that device.", "삭제하지 못했어요": "Could not delete it",
  "음성": "Voice", "스피커": "Speaker", "조명": "Lamp", "카메라": "Camera", "소리 크기": "Sound level", "움직임 센서": "Motion sensors",

  // ---- settings
  "계정": "Accounts", "외형": "Appearance", "모델": "Model", "도구": "Tools", "앱 다시 불러오기": "Reload the app", "새 버전이 있으면 받아요": "Gets the new version, if there is one",
  "화면": "Theme", "폰 설정대로": "As the phone", "밝게": "Light", "어둡게": "Dark", "글자 크기": "Text size", "글자 크기 (px)": "Text size (px)", "글자 {n}px": "Text {n}px",
  "본문 글자 크기예요. 다른 글자도 같은 비율로 바뀌고, 화면과 글자 크기는 이 기기에만 적용돼요.": "The size of body text; the rest follows. Theme and text size apply to this phone only.",
  "답 말풍선 안에 흐리게 보여요. 이 폰에만 적용돼요.": "Shown faintly inside each reply. On this phone only.", "생각 과정 보기": "Show thinking", "답하기 전에 모델이 생각한 것": "What the model thought before answering",
  "도구 사용 보기": "Show tools", "까치가 쓴 도구와 그 결과": "The tools Kkachi used, and how they went", "생각과 도구 보기": "Thinking and tools shown", "생각 보기": "Thinking shown", "도구 보기": "Tools shown",
  "언어": "Language", "화면, 받아쓰기, 기기의 안내가 이 언어로 바뀌어요.": "The screens, dictation and what devices say follow it.",
  "목소리": "Voice", "말 빠르기": "Speed", "이 폰에서 읽어 주기": "Read replies aloud on this phone", "답의 첫 두 문장을 소리로": "The first two sentences of each reply",
  "읽어 주기는 이 폰에만, 목소리와 빠르기는 기기에도 적용돼요.": "Reading aloud is for this phone; the voice and speed are for the devices too.",
  "받아쓰기": "Dictation", "받아쓰는 곳": "Heard by", "다듬기": "Tidy up", "받아쓴 말 다듬기": "Tidy up dictation", "다듬기는 잘못 들은 말, 띄어쓰기, 숫자를 고쳐요.": "Tidying fixes misheard words, spacing and numbers.",
  "목소리를 만드는 곳": "Where the voice is made", "기기 목소리": "Device voice", "이 컴퓨터": "This computer", "온라인": "Online", "끄기": "Off", "받아쓴 그대로": "As heard",
  "폰과 각 기기에 들어 있는 목소리예요. 읽을 말이 밖으로 나가지 않아요.": "The voice built into each phone and device. Nothing leaves the house.",
  "이 컴퓨터의 목소리 서버가 꺼져 있어요. 켜기 전에는 말하지 못해요.": "The voice server on this computer is not running. No speech until it runs.",
  "이 컴퓨터에서 만들어요 (Supertonic). 읽을 말이 밖으로 나가지 않아요.": "Made on this computer (Supertonic). Nothing leaves the house.",
  "edge-tts 가 이 컴퓨터에 없어요. 설치하기 전에는 말하지 못해요.": "edge-tts is not installed on this computer. No speech until it is.",
  "Microsoft Edge 의 목소리예요. 읽을 말이 인터넷으로 나가요.": "Microsoft Edge's voices. The words go online to be spoken.",
  "{engine}. 지금 말하지 못해요": "{engine}. Cannot speak now", "들어보기": "Listen", "목소리를 불러오지 못했어요": "Could not load the voice",
  "Groq 키가 없어요": "No Groq key", "밖으로 안 나가요": "Stays in the house", "서버가 꺼져 있어요": "Server not running", "Groq 로 나가요": "Goes to Groq",
  "안녕하세요, 까치예요. 오늘도 반가운 소식 전해 드릴게요.": "Hi, I'm Kkachi. Here's what's new today.",
  "목소리 {voice}, 받아쓰기 {stt}": "Voice {voice}, dictation {stt}", "기본 {a}개, 추가 {b}개": "{a} built in, {b} added", "연결된 계정 없음": "No account connected",
  "쓰는 모델": "Model", "생각 깊이": "Thinking", "빠르게는 답이 일찍 오고, 꼼꼼하게는 어려운 일을 더 잘해요.": "Fast answers sooner; Thorough does hard things better.",
  "이 모델이 막히면 {list} 순서로 넘어가요.": "If this model is limited, Kkachi moves on to {list}.", "설정을 불러오지 못했어요": "Could not load the settings", "보통": "Normal", "OpenRouter 무료": "OpenRouter free",
  "빠르게": "Fast", "꼼꼼하게": "Thorough",
  // accounts and services
  "AI": "AI", "서비스": "Services", "까치가 생각하고 답할 때 쓰는 AI 계정과, 까치가 다룰 수 있는 내 서비스예요.": "The AI accounts Kkachi thinks and answers with, and your services it can work with.",
  "계정 정보와 토큰은 이 서버에만 저장돼요. 서비스는 기기에 대고 한 말에도 써요.": "Accounts and tokens are kept on this server only. Services are used for what is said to devices too.",
  "구독으로 연결됨": "Connected with a subscription", "API 키로 연결됨": "Connected with an API key", "서버 설정으로 연결됨": "Connected in the server's settings",
  "연결 해제": "Disconnect", "연결": "Connect", "{name} 연결을 해제할까요?": "Disconnect {name}?", "해제하지 못했어요": "Could not disconnect", "연결을 해제했어요": "Disconnected", "취소": "Cancel",
  "{name} 연결": "Connect {name}", "구독으로 로그인": "Sign in with a subscription", "API 키 넣기": "Enter an API key", "API 키": "API key", "{name} 연결했어요": "{name} connected", "{name} API 키": "{name} API key",
  "저장": "Save", "{name} 로그인": "Sign in to {name}", "로그인 준비 중…": "Getting the sign-in ready…", "연결하지 못했어요. {error}": "Could not connect. {error}", "연결하지 못했어요": "Could not connect",
  "다시 시도": "Try again", "로그인 페이지 열기": "Open the sign-in page", "코드": "Code", "코드가 맞지 않아요. {error}": "The code did not work. {error}",
  "1. 로그인 페이지에서 로그인하세요. 끝나면 코드가 나와요.": "1. Sign in on the sign-in page. A code appears at the end.", "2. 그 코드를 복사해서 여기에 붙여 넣으세요.": "2. Copy that code and paste it here.",
  "확인": "OK", "OpenAI 페이지 열기": "Open OpenAI's page", "1. OpenAI 페이지를 열고 로그인하세요.": "1. Open OpenAI's page and sign in.", "2. 이 코드를 넣고 승인하세요. 승인하면 저절로 연결돼요.": "2. Enter this code and approve. It connects by itself then.",
  "확인하는 중…": "Checking…", "Claude Pro 나 Max 구독, 또는 Anthropic API 키": "A Claude Pro or Max subscription, or an Anthropic API key", "ChatGPT Plus 나 Pro 구독": "A ChatGPT Plus or Pro subscription",
  "OpenAI API 키": "An OpenAI API key", "OpenRouter API 키. 무료 모델도 있어요": "An OpenRouter API key. Some models are free", "받아쓰기와 다듬기를 Groq 로 할 때 써요": "For dictation and tidying with Groq",
  "1. 로그인 페이지를 열고 로그인해서 허용하세요.": "1. Open the sign-in page, sign in and allow it.",
  "2. 그러면 열리지 않는 페이지(127.0.0.1)로 넘어가요. 그 페이지의 주소를 통째로 복사해서 붙여 넣으세요.": "2. You then land on a page that does not load (127.0.0.1). Copy that page's whole address and paste it here.",
  "주소": "Address", "기다리는 로그인이 없어요": "No sign-in is waiting", "주소 전체를 붙여 넣어 주세요": "Paste the whole address", "로그인 뒤에 열린 주소가 아니에요": "That is not the address the sign-in ended on", "로그인하지 못했어요": "Could not sign in",
  // tools
  "까치가 집의 기기나 다른 서비스를 다룰 때 쓰는 도구예요. MCP 서버로 붙여요.": "Tools Kkachi uses for things in the home and other services. They come as MCP servers.",
  "기본": "Built in", "추가한 것": "Added", "추가하기": "Add", "추가하거나 바꾼 도구는 다음 말부터 써요. 기기에 대고 한 말에도 같은 도구를 써요.": "Added or changed tools are used from the next message, and for what is said to devices too.",
  "노트": "Notes", "꺼 둠": "Off", "연결됨. 도구 {n}개": "Connected. {n} tools", "로그인이 필요해요": "Needs a sign-in", "연결하지 못했어요. {why}": "Could not connect. {why}", "응답이 없어요": "Not answering",
  "로그인": "Sign in", "{name} 삭제": "Delete {name}", "{name} 쓰기": "Use {name}", "추가": "Add", "직접 추가": "Add your own", "주소나 실행 명령으로 다른 MCP 서버를 붙여요": "Any other MCP server, by its address or command",
  "어디서 받나요?": "Where do I get it?", "자세히": "More", "확인하지 못했어요": "Could not check", "'{name}' 도구를 삭제할까요?": "Delete '{name}'?", "삭제했어요": "Deleted",
  "추가했어요. 다음 말부터 써요": "Added. Used from the next message", "없으면 비워 두세요": "Leave empty if none", "붙이는 방법": "How", "토큰": "Token",
  "실행 명령 (서버에서 실행돼요)": "Command (runs on the server)", "환경 변수 (한 줄에 하나씩)": "Environment (one per line)", "이름 (영문, 숫자, -, _)": "Name (letters, digits, -, _)",
  "이름은 영문, 숫자, -, _ 로 써 주세요": "Use letters, digits, - and _ in the name", "주소는 http 나 https 로 시작해요": "The address starts with http or https", "주소나 명령이 필요해요": "An address or a command is needed",
  "하나 이상 골라 주세요": "Choose at least one", "{label} 이(가) 필요해요": "{label} is needed",
  "집의 조명, 스피커, 센서, 자동화. Hue, Tapo, IKEA, Tuya, Matter, SmartThings 기기도 Home Assistant 에 붙이면 함께 써요.": "The home's lights, speakers, sensors and automations. Hue, Tapo, IKEA, Tuya, Matter and SmartThings devices come along once they are in Home Assistant.",
  "ha-mcp 주소": "ha-mcp address", "LG 공식, 베타": "LG's own, beta", "LG 가전의 상태를 보고 켜고 꺼요. 서버에 uv 가 깔려 있어야 해요.": "Checks LG appliances and switches them. Needs uv on the server.",
  "개인 액세스 토큰 (PAT)": "Personal access token (PAT)", "국가 코드": "Country code", "Google 공식, 미리보기": "Google's own, preview",
  "캘린더 일정, Gmail, 드라이브. Google Cloud 에서 만든 OAuth 클라이언트(데스크톱 앱)의 ID 와 비밀값이 필요해요.": "Calendar, Gmail and Drive. Needs the ID and secret of an OAuth client (desktop app) made in Google Cloud.",
  "클라이언트 ID": "Client ID", "클라이언트 보안 비밀": "Client secret", "캘린더": "Calendar", "드라이브": "Drive", "Notion 공식": "Notion's own",
  "노션 페이지와 데이터베이스를 찾고 고쳐요. 추가한 뒤 노션에 로그인해서 쓸 페이지를 골라요.": "Finds and edits Notion pages and databases. After adding it, sign in to Notion and choose the pages to share.",
  "GitHub 공식": "GitHub's own", "저장소, 이슈, 풀 리퀘스트. GitHub 개인 액세스 토큰(fine-grained)이 필요해요.": "Repositories, issues and pull requests. Needs a GitHub personal access token (fine-grained).", "개인 액세스 토큰": "Personal access token",
  "Google 캘린더": "Google Calendar", "Google Gmail": "Google Gmail", "Google 드라이브": "Google Drive",
  // voices
  "이 폰과 각 기기에 들어 있는 목소리. 까치 서버에서 만들지 않아요": "Built into this phone and each device. Not made on Kkachi's server",
  "여성 1": "Female 1", "여성 2": "Female 2", "여성 3": "Female 3", "여성 4": "Female 4", "여성 5": "Female 5", "남성 1": "Male 1", "남성 2": "Male 2", "남성 3": "Male 3", "남성 4": "Male 4", "남성 5": "Male 5",
  "선희": "SunHi", "인준": "InJoon", "현수": "Hyunsu", "에바": "Ava", "엠마": "Emma", "앤드루": "Andrew",
  "여성, 차분한 한국어": "Female, calm Korean", "남성, 또렷한 한국어": "Male, clear Korean", "남성, 영어 섞인 말에 자연스러움": "Male, natural with English mixed in",
  "여성, 다국어": "Female, multilingual", "여성, 다국어, 밝은 목소리": "Female, multilingual, bright", "남성, 다국어, 따뜻한 목소리": "Male, multilingual, warm",
};

function t(ko, vars) {
  let s = LANG === "en" ? EN[ko] ?? ko : ko;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

// The page's own text, as it appears: text nodes and labels whose whole text is a phrase above.
if (LANG === "en") {
  const SKIP = ".you, .md, .think-text, .tool-line, .chip, .conv .name, .user-code, .url, [translate=no]";
  const ATTRS = ["aria-label", "placeholder", "title", "alt"];
  const swap = (s) => { const k = s.trim(); return k && EN[k] !== undefined ? s.replace(k, EN[k]) : null; };
  const doText = (n) => { const p = n.parentElement; if (p && !p.closest(SKIP)) { const s = swap(n.data); if (s !== null) n.data = s; } };
  const doEl = (el) => {
    if (el.closest(SKIP)) return;
    for (const a of ATTRS) { const v = el.getAttribute(a); if (v) { const s = swap(v); if (s !== null) el.setAttribute(a, s); } }
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode()); ) doText(n);
    for (const c of el.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(","))) if (!c.closest(SKIP)) for (const a of ATTRS) { const v = c.getAttribute(a); if (v) { const s = swap(v); if (s !== null) c.setAttribute(a, s); } }
  };
  const start = () => {
    doEl(document.body);
    document.title = swap(document.title) ?? document.title;
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === "characterData") doText(m.target);
        else if (m.type === "attributes") { const v = m.target.getAttribute(m.attributeName); const s = v && !m.target.closest(SKIP) ? swap(v) : null; if (s !== null) m.target.setAttribute(m.attributeName, s); }
        else for (const n of m.addedNodes) n.nodeType === 1 ? doEl(n) : n.nodeType === 3 && doText(n);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };
  if (document.body) start(); else addEventListener("DOMContentLoaded", start);
}

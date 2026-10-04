# Codex 사용량과 리셋권 확인기 기획서

## 1. 프로젝트 개요

Codex 계정의 5시간·주간 잔여 사용량과 리셋권 개수·지급·만료 시각을 한국 시간으로 확인하는 개인용 로컬 웹앱입니다. 리셋권을 사용하거나 계정 정보를 저장하지 않습니다.

## 2. 목표와 대상

- 대상: ChatGPT/Codex를 개인 PC에서 사용하는 사용자
- 목표: 날짜만 제공되는 만료 정보를 `YYYY-MM-DD HH:mm:ss KST`로 확인
- 실행 위치: 사용자 PC의 `127.0.0.1`
- 계정 범위: 한 번에 현재 로그인된 ChatGPT 계정 하나

## 3. 핵심 사용자 흐름

```text
데스크톱 앱 또는 CLI에서 ChatGPT 로그인
  → npm start
  → 일회용 브라우저 세션 교환
  → 리셋권 조회
  → 만료 시각·남은 시간 표시
```

화면 진입과 수동 새로고침, 사용자가 켠 만료·사용량 알림 확인 시점에 서버 조회를 수행합니다. 추세를 켜면 보이는 화면에서 5분마다 사용량을 조회합니다. 카운트다운은 브라우저 시계로 매초 갱신하고, 5초 상태 확인은 로그인·계정 변경 여부만 확인합니다.

화면은 현재 상태를 항상 보여주는 Main Status Card와 `리셋 일정`, `사용 추세`, `알림`, `리셋 상세` 탭으로 구성합니다. 탭은 `?tab=` 쿼리로 유지하며 API 요청과 데이터 모델에는 영향을 주지 않습니다. 시스템 밝은/어두운 모드를 따르고 reduced-motion 환경에서는 상태 모션을 생략합니다.

## 4. 지원 설치 조합

| 환경 | 지원 여부 | 조건 |
|---|---:|---|
| macOS ChatGPT 데스크톱 앱만 | 지원 | 표준 시스템 앱 폴더 또는 사용자 앱 폴더의 번들 CLI를 자동 탐색합니다. |
| Codex CLI만 | 지원 | `codex login`으로 ChatGPT 로그인합니다. |
| 데스크톱 앱 + CLI | 지원 | `CODEX_CLI_PATH` → PATH의 `codex` → macOS 앱 번들 순서로 선택합니다. |
| Windows/Linux 데스크톱 앱만 | 구현됨, 네이티브 검증 대기 | PATH fallback 뒤 Windows ChatGPT AppX `InstallLocation` 또는 Linux `chatgpt` 패키지 파일 목록에서 CLI 후보를 제한적으로 찾고, 해당 후보에만 `app-server --help` 검증을 실행합니다. |
| API 키 로그인 | 미지원 | 리셋권 조회는 ChatGPT 인증만 허용합니다. |

데스크톱 앱과 CLI는 Codex의 로컬 인증 캐시를 공유합니다. 웹앱은 인증 파일이나 토큰을 직접 읽지 않고 `codex app-server`에 조회를 위임합니다.

실행 파일은 `CODEX_CLI_PATH` → PATH → 플랫폼별 앱 패키지 탐색 순으로 선택합니다. macOS는 기존 ChatGPT 앱 번들 경로를, Windows는 설치된 ChatGPT AppX 패키지의 `InstallLocation` 내부에서 `codex.exe`/`.cmd`/`.bat`를, Linux는 `dpkg-query`/`rpm`/`pacman`으로 `chatgpt` 패키지 소유 파일 목록 중 실행 파일 `codex`를 탐색합니다. Windows/Linux에서 패키지 탐색으로 발견한 후보에만 `codex app-server --help` 지원 검증을 실행하며, macOS 번들 후보는 검증하지 않습니다. 탐색은 시작 때만 하며 조회부터 후보 검증까지 공유 3초 deadline과 후보 개수 제한을 적용합니다. timeout 뒤 caller의 정리 대기는 최대 1초이며, Windows `taskkill`이 이 제한보다 오래 걸리면 wrapper를 먼저 종료하지 않고 taskkill이 독립적으로 정리를 마치도록 둡니다. Windows native와 WSL은 별도 실행 환경으로 취급하며, Windows AppX 탐색은 Windows에서만 수행합니다. 시작 도중 종료 신호를 받으면 남은 탐색을 취소합니다. 그 밖의 설치 위치는 `CODEX_CLI_PATH`로 지정할 수 있습니다.

**검증 상태:** 패키지 조회와 후보 선택은 모의 명령 실행기를 이용한 자동 테스트로 확인합니다. 현재 개발 호스트는 macOS이며 native Windows/Linux 패키지 실행은 아직 검증하지 않았습니다. 해당 교차 플랫폼 실행은 native Windows와 Linux 호스트에서 확인되기 전까지 미검증으로 표시합니다.

## 5. 기능 범위

### 포함

- 사용 가능한 리셋권 개수 표시
- 리셋권별 제목·상태·지급 시각·만료 시각 표시
- KST 변환 및 초 단위 카운트다운
- 만료 시각 없음, 상세 정보 미제공, 부분 조회, 0개 상태 구분
- 수동 새로고침과 로그인·계정 변경 오류 안내
- 이전 계정 결과 삭제 및 일시적 조회 실패 시 마지막 성공 결과 보존
- 원본 식별자와 만료 시각이 확인된 리셋권의 선택적 브라우저 만료 알림
- 5시간·주간 한도의 잔여율·KST 리셋 시각·카운트다운과 잔여량 활용 시점 추천
- 독립 opt-in 사용량 알림: 리셋 30분 전·잔여량 20% 이하·재조회로 확인된 리셋 시각 갱신. 발송 전 검증과 탭 간 중복 방지
- 선택적 사용 추세: 최근 30분의 동일 계정·창 성공 조회 3건 이상으로 %p/시간·소진 시점을 추정. 이력은 메모리에만 보관하고 숨겨진 탭의 주기 조회 중단
- 지금·5시간 리셋 후·주간 리셋 후의 작업 시작 시각 비교. 예정된 리셋과 마지막 조회 한도를 구분하며 미래 잔여량·사용 권한은 확정하지 않음

### 제외

- 리셋권 사용 또는 소비
- 앱이 종료된 뒤의 OS 백그라운드 만료 알림·이메일 발송
- 다중 계정 관리
- 공개 웹서비스 배포
- API 키 기반 조회

## 6. 시스템 구조

```text
브라우저 UI
  → 로컬 HTTP API
  → CreditService
  → CodexClient
  → codex app-server(stdio JSONL)
  → ChatGPT/Codex 서비스
```

허용 RPC는 `account/read`와 `account/rateLimits/read`로 제한합니다. 서버는 원본 응답에서 계정 ID·이메일·인증값·리셋권 원본 ID를 제거한 뒤 브라우저에 전달합니다.

## 7. 보안 요구사항

- 서버는 `127.0.0.1`에만 바인딩
- 브라우저 접속은 일회용 토큰과 `HttpOnly`, `SameSite=Strict` 세션 쿠키로 제한
- Host·Origin·전용 요청 헤더 검증
- 외부 CORS, 임의 RPC 프록시, 토큰 입력 화면 금지
- 원본 응답·stderr·인증 파일을 로그나 저장소에 기록하지 않음
- 응답에 `Cache-Control: no-store`와 CSP 적용
- 원본 계정 데이터는 메모리에만 보관하고 앱 종료 시 폐기. 브라우저에는 알림 설정·항목 지문·발송 시점·계정 범위 지문만 보관

## 8. 검증 방법

- `npm test`로 인증·오류·계정 전환·HTTP 보안·시간 변환·UI 상태 전이를 검증합니다.
- `npm run check`로 서버·클라이언트 모듈의 구문을 검증합니다.
- CLI/App Server 계약 변경은 `codex app-server generate-json-schema --out <임시 디렉터리>`로 해당 CLI 버전의 스키마를 개발 중 비교합니다. 앱 시작 시 스키마 생성이나 별도 호환성 요청은 하지 않습니다.
- `npm run test:browser`로 합성 서비스 기반 headless Chromium QA를 실행합니다. 320/375/640/768/1280px에서 넘침·컨트롤 배치·키보드 포커스와 긴 텍스트, 탭 URL·history·키보드 이동, 밝은/어두운 모드 대비, reduced-motion, 부분/개수만/0개/정보 없음, 새로고침 오류, 로그인 필요 상태를 확인하고 PNG를 저장합니다. `VISUAL_QA_OUTPUT_DIR`로 저장 위치를 지정할 수 있습니다. Playwright는 개발 전용이며 `server.mjs`에서 불러오지 않습니다. Playwright 또는 Chromium을 실행할 수 없으면 테스트가 skip 결과와 함께 종료 코드 1로 실패하므로, `npm install`과 Chromium 설치가 필요합니다.
- 자동 테스트는 합성 응답과 임시 프로세스를 사용하므로 실제 계정이나 특정 사용자 경로에 의존하지 않습니다.
- 실제 ChatGPT 계정 조회는 로그인된 Codex CLI와 계정별 필드 제공 여부가 필요하므로 사용자 환경에서 별도로 확인합니다.

## 9. 다음 단계

1. native Windows/Linux 호스트에서 패키지 탐색 및 App Server 후보 검증 확인
2. 브라우저 기반 시각 QA와 좁은 화면 레이아웃 확인 — 완료. Chromium 브라우저 테스트 결과와 스크린샷은 `npm run test:browser`로 재현합니다.
3. CLI/App Server 인터페이스 변경 감지 및 호환성 안내 보강 — 완료. `account/read`와 `account/rateLimits/read`의 기존 응답 형식만으로 감지하며 별도 RPC·네트워크 probe·시작 시 스키마 생성을 하지 않습니다.
4. 선택적 만료 알림 — 완료. 브라우저 권한과 사용자 opt-in 뒤 열린 탭에서 24시간 전·1시간 전에 알리고, 알림 직전 한 번 재조회합니다. 원본 식별자의 일방향 지문으로 항목을 재검증하며, 식별자가 없는 항목은 알림 대상에서 제외합니다. 설정과 중복 방지 digest는 동일한 브라우저·앱 주소에서 복원합니다. 앱 재실행으로 포트가 바뀌면 새 주소에 이전 설정은 적용되지 않습니다. 계정 전환 시 account-scope digest로 이전 기록을 지우고, 탭 간 설정 해제를 동기화하며 OS 백그라운드 알림은 제공하지 않습니다.

남은 작업은 native Windows/Linux 호스트 검증입니다.

상세 실행 방법은 [README.md](../README.md), 인증 조건은 [authentication.md](authentication.md)를 참고합니다.

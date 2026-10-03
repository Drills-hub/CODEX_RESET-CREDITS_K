const messages = {
  LOGIN_REQUIRED: 'Codex CLI에서 ChatGPT 로그인이 필요합니다. 터미널에서 codex login을 실행해 주세요.',
  AUTH_UNSUPPORTED: 'ChatGPT 계정 유형을 확인할 수 없거나 지원하지 않는 인증 방식입니다. ChatGPT 로그인을 확인해 주세요.',
  INCOMPATIBLE: '현재 Codex CLI와 조회 인터페이스가 호환되지 않습니다. Codex CLI를 최신 버전으로 업데이트한 뒤 다시 실행해 주세요.',
  CLI_MISSING: 'Codex CLI를 찾을 수 없습니다. 설치와 PATH를 확인해 주세요.',
  DISCONNECTED: 'Codex 연결이 종료되었습니다. 새로고침으로 다시 연결해 주세요.',
  TIMEOUT: '15초 안에 조회를 완료하지 못했습니다. 다시 조회해 주세요.',
  ACCOUNT_CHANGED: '계정 상태가 변경되어 이전 결과를 지웠습니다. 다시 조회해 주세요.',
  BUSY: '조회가 진행 중입니다. 완료 후 다시 시도해 주세요.',
  FORBIDDEN: '허용되지 않은 요청입니다.',
  BAD_REQUEST: '요청 형식이 올바르지 않습니다.',
  UPSTREAM: 'Codex 조회에 실패했습니다. 연결과 로그인 상태를 확인해 주세요.',
  INVALID_DATA: '조회 결과의 형식이 올바르지 않습니다.',
};
export class AppError extends Error {
  constructor(code) { super(messages[code] ?? messages.UPSTREAM); this.code = messages[code] ? code : 'UPSTREAM'; }
}
export function safeError(error) { return error instanceof AppError ? error : new AppError('UPSTREAM'); }
export function rpcError(error) {
  if (error?.code === -32601 || /not initialized|requires experimentalApi|unknown method|unsupported method/i.test(error?.message ?? '')) return new AppError('INCOMPATIBLE');
  if (error?.code === 401 || /unauthorized|not authenticated|not logged in|authentication required/i.test(error?.message ?? '')) return new AppError('LOGIN_REQUIRED');
  return new AppError('UPSTREAM');
}

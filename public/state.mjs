export function initialState() { return { snapshot: null, usageStale: false, loading: false, revision: -1, authState: 'unknown', connected: false, message: '', kind: 'info' }; }
export function updateState(state, event) {
  if (event.type === 'loading') return { ...state, loading: true, message: '리셋권 정보를 조회하고 있습니다.', kind: 'loading' };
  if (event.type === 'success') {
    if (event.snapshot.revision < state.revision) return { ...state, loading: false, message: '계정 상태가 변경되었습니다. 다시 조회해 주세요.', kind: 'error' };
    return { ...state, snapshot: event.snapshot, usageStale: false, revision: event.snapshot.revision, loading: false, connected: true, authState: 'chatgpt', message: '조회가 완료되었습니다.', kind: 'info' };
  }
  if (event.type === 'failure') {
    const snapshot = event.error.clearPrevious ? null : state.snapshot;
    const authState = event.error.code === 'LOGIN_REQUIRED' ? 'signed-out' : event.error.code === 'AUTH_UNSUPPORTED' ? 'unsupported' : state.authState;
    return { ...state, snapshot, usageStale: Boolean(snapshot), authState, loading: false, kind: 'error', message: `${snapshot ? '최신 정보 확인 실패 · ' : ''}${event.error.message}` };
  }
  if (event.type === 'status') {
    const status = event.status;
    if (status.revision < state.revision) return state;
    const changed = state.snapshot && (status.revision !== state.snapshot.revision || ['signed-out', 'unsupported'].includes(status.authState));
    return { ...state, ...status, snapshot: changed ? null : state.snapshot, usageStale: changed ? false : state.usageStale || Boolean(state.snapshot && !status.connected),
      ...(changed ? { message: '계정 상태가 변경되어 이전 결과를 지웠습니다. 다시 조회해 주세요.', kind: 'error' } : {}) };
  }
  return state;
}

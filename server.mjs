import { spawn } from 'node:child_process';
import { CodexClient } from './lib/codex.mjs';
import { CreditService } from './lib/service.mjs';
import { createApplication } from './lib/http.mjs';

const client = new CodexClient();
const application = createApplication({ service: new CreditService(client) });
try {
  await application.listen();
  const entry = `${application.origin}/#${application.bootstrapToken}`;
  console.log(`Codex 리셋권 확인 실행 중: ${application.origin}`);
  console.log('브라우저가 자동으로 열립니다. 종료하려면 Ctrl+C를 누르세요.');
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', entry] : [entry];
  const browser = spawn(command, args, { stdio: 'ignore', shell: false });
  browser.on('error', () => console.error('브라우저를 열지 못했습니다. 기본 브라우저 설정을 확인하고 앱을 다시 실행해 주세요.'));
  browser.on('exit', code => { if (code) console.error('브라우저를 열지 못했습니다. 기본 브라우저 설정을 확인해 주세요.'); });
} catch {
  console.error('로컬 서버를 시작하지 못했습니다. Node.js 버전과 실행 권한을 확인해 주세요.');
  client.close(); process.exitCode = 1;
}
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  client.close(); await application.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

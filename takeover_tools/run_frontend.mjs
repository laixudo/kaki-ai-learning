// Start the Kaki Learning frontend dev server in isolated mock mode.
// Usage:
//   node takeover_tools/run_frontend.mjs [--port 15174] [--detach]
// Port default from TAKEOVER_FRONTEND_PORT, falling back to 15174.
//
// Runs vite directly via `node node_modules/vite/bin/vite.js` instead of
// `npm run dev`: spawning npm.cmd from Node on Windows is unreliable when
// detached (batch-file lifecycle kills the child vite process).  This version
// is cross-platform.  VITE_* env vars are injected for mock mode; the dev
// proxy points at TAKEOVER_BACKEND_PORT (default 18001).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const frontendDir = path.join(projectRoot, 'frontend');
const viteBin = path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js');

const args = process.argv.slice(2);
let port = process.env.TAKEOVER_FRONTEND_PORT || '15174';
let backendPort = process.env.TAKEOVER_BACKEND_PORT || '18001';
let detach = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = args[++i];
  else if (args[i] === '--backend-port') backendPort = args[++i];
  else if (args[i] === '--detach') detach = true;
}

if (!existsSync(viteBin)) {
  console.error(`[run_frontend] vite binary missing: ${viteBin}`);
  console.error('[run_frontend] run `npm ci` in frontend/ first.');
  process.exit(2);
}

const env = { ...process.env };
env.VITE_API_PROXY_TARGET = `http://127.0.0.1:${backendPort}`;
env.VITE_API_BASE_URL = `http://127.0.0.1:${backendPort}`;
env.VITE_BROWSER_API_BASE_URL = `http://127.0.0.1:${backendPort}`;
env.VITE_DATA_MODE = 'mock';
env.VITE_BASE_PATH = '/';

const logDir = path.join(projectRoot, 'takeover_tools', 'logs');
mkdirSync(logDir, { recursive: true });
const outPath = path.join(logDir, 'frontend.out.log');
const errPath = path.join(logDir, 'frontend.err.log');

const viteArgs = ['--host', '127.0.0.1', '--port', String(port)];
console.log(`[run_frontend] node ${viteBin} ${viteArgs.join(' ')} (cwd=${frontendDir})`);

const stdio = ['ignore', 'pipe', 'pipe'];
if (detach) {
  // Open log file descriptors in the parent first; passing them via stdio
  // keeps the child alive after this process exits (no pipe keeps a handle).
  stdio[1] = openSync(outPath, 'a');
  stdio[2] = openSync(errPath, 'a');
}

const child = spawn(process.execPath, [viteBin, ...viteArgs], {
  cwd: frontendDir,
  env,
  stdio,
  detached: detach,
  windowsHide: true,
});

if (detach) {
  child.unref();
  writeFileSync(path.join(projectRoot, 'takeover_tools', '.run-frontend.pid'), String(child.pid), 'utf8');
  console.log(`[run_frontend] detached pid=${child.pid}`);
} else {
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('exit', (code) => process.exit(code ?? 0));
}

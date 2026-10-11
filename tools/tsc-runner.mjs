import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function exists(file) { try { await access(file); return true; } catch { return false; } }
export async function runTsc(projectRoot, config, stdio = 'inherit') {
  const localCli = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  const useLocal = await exists(localCli);
  const command = useLocal ? process.execPath : (process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  const args = useLocal ? [localCli, '-p', config] : ['-p', config];
  const child = spawn(command, args, { cwd: projectRoot, stdio, shell: !useLocal && process.platform === 'win32' });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return Number(code ?? 1);
}

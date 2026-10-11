import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const electronCli = path.join(root, 'node_modules', 'electron', 'cli.js');
try { await access(electronCli); } catch {
  console.error('Electron is not installed. Run npm install first.');
  process.exit(2);
}
const temp = await mkdtemp(path.join(os.tmpdir(), 'descendants-generated-electron-e2e-'));
const output = path.join(temp, 'result.json');
const screenshotDir = path.join(root, 'docs', 'screenshots');
const screenshot = path.join(screenshotDir, 'descendants-pda-electron-e2e-1.0.0.png');
const pdaScreenshotDir = path.join(screenshotDir, 'pda-e2e');
await mkdir(screenshotDir, { recursive: true });
try {
  const child = spawn(process.execPath, [electronCli, path.join(root, 'electron', 'main.cjs')], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      DESCENDANTS_GENERATED_E2E_OUTPUT: output,
      DESCENDANTS_GENERATED_E2E_SCREENSHOT: screenshot,
      DESCENDANTS_PDA_E2E_DIR: pdaScreenshotDir,
    },
  });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  if (code !== 0) process.exit(Number(code ?? 1));
  const result = JSON.parse(await readFile(output, 'utf8'));
  if (!result.ready
    || result.title !== 'The Descendants of Criminals — 1.0.0'
    || result.navCount !== 8
    || !result.bodyViewReached
    || result.studioLinks !== 0
    || result.commandCenter?.priorities < 1
    || result.commandCenter?.priorities > 3
    || result.commandCenter?.resourceCards !== 5
    || !['ready','risk','blocked'].includes(result.commandCenter?.readiness)
    || !result.commandCenter?.executePresent
    || !result.compactNoHorizontalOverflow
    || !result.noHorizontalOverflow
    || !['task','body','knowledge','inventory','chronicle','residents','map','system'].every((tab)=>result.reached?.[tab])) {
    console.error(result);
    throw new Error('Generated-world Electron E2E failed.');
  }
  console.log(`Generated-world Electron E2E OK. Screenshot: ${screenshot}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}

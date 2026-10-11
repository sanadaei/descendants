import { rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runTsc } from './tsc-runner.mjs';

export async function compileTestDist() {
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  await rm(new URL('../.test-dist', import.meta.url), { recursive: true, force: true });
  return runTsc(projectRoot, 'tsconfig.test.json');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await compileTestDist();
  process.exit(code);
}

import { fileURLToPath } from 'node:url';
import { runTsc } from './tsc-runner.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const code = await runTsc(root, 'tsconfig.json');
process.exit(code);

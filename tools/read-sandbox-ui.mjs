import { readFile, readdir } from 'node:fs/promises';

/** Source contracts cover the controller and active renderers after UI extraction. */
export async function readSandboxUiSource() {
  const directory=new URL('../src/sandbox/ui/',import.meta.url);
  const files=(await readdir(directory)).filter((name)=>name.endsWith('.ts')).sort();
  return (await Promise.all([
    readFile(new URL('../src/sandbox/app.ts',import.meta.url),'utf8'),
    ...files.map((name)=>readFile(new URL(name,directory),'utf8')),
    readFile(new URL('../src/sandbox/lifeCourseView.ts',import.meta.url),'utf8'),
  ])).join('\n');
}

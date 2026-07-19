import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const source = new URL('../', import.meta.url);
const output = new URL('../www/', import.meta.url);

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL('index.html', source), new URL('index.html', output));
await cp(new URL('src/', source), new URL('src/', output), { recursive: true });
await cp(new URL('styles/', source), new URL('styles/', output), { recursive: true });

const packageJson = JSON.parse(await readFile(new URL('package.json', source), 'utf8'));
const outputIndex = new URL('index.html', output);
const androidIndex = (await readFile(outputIndex, 'utf8'))
  .replace(/src="\.\/src\/app\.js\?v=[^"]+"/, `src="./src/app.js?v=${packageJson.version}"`);
await writeFile(outputIndex, androidIndex);

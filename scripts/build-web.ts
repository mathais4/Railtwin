/**
 * Bundles the browser UI. The simulation engine runs client-side, so the page
 * works with or without the API server. Produces:
 *   web/dist/index.html     full document, served by `npm start`
 *   web/dist/fragment.html  body-only version for hosts that supply their own <html>/<head>
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = await build({
  entryPoints: [root + 'web/src/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
  legalComments: 'none',
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const template = readFileSync(root + 'web/template.html', 'utf8');
const fragment = template.replace('<!--APP-->', () => `<script>${js}</script>`);
const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`;

mkdirSync(root + 'web/dist', { recursive: true });
writeFileSync(root + 'web/dist/index.html', full);
writeFileSync(root + 'web/dist/fragment.html', fragment);
console.log(`web/dist/index.html  ${(full.length / 1024).toFixed(0)} KB (script ${(js.length / 1024).toFixed(0)} KB)`);

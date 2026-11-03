// Assemble l'application en un seul fichier : node build.mjs -> dist/index.html
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
const r = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
let html = r('./src/index.template.html');
const parts = { ENGINE: 'engine.js', DATA: 'data.js', STORE: 'store.js', PIPELINE: 'pipeline.js', CHECKER: 'checker.js', APP: 'app.js' };
for (const [k, f] of Object.entries(parts)) {
  const src = r('./src/' + f).replace(/<\/script/gi, '<\\/script');
  html = html.replace(`/*__${k}__*/`, () => src);
}
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/index.html', import.meta.url), html);
console.log('dist/index.html', (html.length / 1024).toFixed(1), 'Ko');

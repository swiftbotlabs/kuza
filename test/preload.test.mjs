// Every module the app loads must be listed as a modulepreload in index.html.
// A missing one brings back the import waterfall: on a slow phone each level of imports costs a round trip
// while only the boot hexagon shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const DOCS = new URL('../docs/', import.meta.url).pathname;

export function preloads(html) {
  return [...html.matchAll(/<link\s+rel="modulepreload"\s+href="([^"]+)"/g)].map((m) => normalize(m[1]));
}

export function moduleGraph(entry, read = (f) => readFileSync(join(DOCS, f), 'utf8')) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = read(file);
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
      walk(relative(DOCS, join(DOCS, dirname(file), m[1])));
    }
  };
  walk(entry);
  return [...seen];
}

test('index.html preloads every module the app imports, statically or by import()', () => {
  const html = readFileSync(join(DOCS, 'index.html'), 'utf8');
  const listed = new Set(preloads(html));
  const graph = moduleGraph('js/app.js');
  assert.ok(graph.length >= 13, `module graph looks too small (${graph.length}), the import scan may be broken`);
  const missing = graph.filter((f) => !listed.has(f));
  assert.deepEqual(missing, [], `add <link rel="modulepreload"> for: ${missing.join(', ')}`);
  for (const f of listed) assert.ok(existsSync(join(DOCS, f)), `preload points at a missing file: ${f}`);
});

test('the check catches a module that is imported but not preloaded (control)', () => {
  const files = { 'js/a.js': "import { x } from './b.js';\nconst m = await import('./vendor/c.js');", 'js/b.js': '', 'js/vendor/c.js': "import{q}from\"./d.js\";", 'js/vendor/d.js': '' };
  const graph = moduleGraph('js/a.js', (f) => files[f]);
  assert.deepEqual(graph.sort(), ['js/a.js', 'js/b.js', 'js/vendor/c.js', 'js/vendor/d.js']);
  const listed = new Set(preloads('<link rel="modulepreload" href="js/a.js"><link rel="modulepreload" href="js/b.js">'));
  assert.deepEqual(graph.filter((f) => !listed.has(f)).sort(), ['js/vendor/c.js', 'js/vendor/d.js']);
});

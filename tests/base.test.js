const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('base files of the static site exist', () => {
  for (const file of ['index.html', 'styles.css', 'supabase-config.js', 'serve-local.js', '.nojekyll', '.gitignore', 'README.md']) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} exists`);
  }
});

test('colours are defined once as design tokens in :root and used through var()', () => {
  const css = read('styles.css');
  const block = css.match(/:root\{[^}]*\}/)?.[0];
  assert.ok(block, ':root token block exists');
  const outside = css.replace(block, '');
  const raw = outside.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) || [];
  assert.deepEqual(raw, [], 'styles.css must use var(--token) instead of raw colours');
  const defined = new Set([...block.matchAll(/--([a-z0-9-]+):/g)].map(match => match[1]));
  const used = [...outside.matchAll(/var\(--([a-z0-9-]+)\)/g)].map(match => match[1]);
  assert.deepEqual([...new Set(used.filter(name => !defined.has(name)))], [], 'every var(--token) is defined in :root');
});

test('supabase-config.js holds only the public key and points to a Witcher project', () => {
  const source = read('supabase-config.js');
  assert.match(source, /window\.WITCHER_SUPABASE_CONFIG\s*=/);
  assert.match(source, /publishableKey:\s*'sb_publishable_[A-Za-z0-9_-]+'/);
  // Committed copy = production (iwpmsfoovppqnldciric); the local copy may point to staging (dvyeucfxwkibscooocby).
  assert.match(source, /url:\s*'https:\/\/(iwpmsfoovppqnldciric|dvyeucfxwkibscooocby)\.supabase\.co'/, 'points to WitcherAPP or WitcherAPP-staging');
  assert.doesNotMatch(source, /sb_secret_|service_role\s*['"]?\s*[:=]\s*['"]eyJ|eyJhbGci/, 'no secret or JWT key in the browser config');
});

test('no secret-looking value is committed in site files', () => {
  for (const file of ['index.html', 'styles.css', 'supabase-config.js', 'serve-local.js', 'README.md']) {
    const source = read(file);
    assert.doesNotMatch(source, /sb_secret_[A-Za-z0-9_-]+|\bsk_(live|test)_|\bwhsec_[A-Za-z0-9]+|AIza[0-9A-Za-z_-]{20,}|\bre_[A-Za-z0-9]{20,}/, `${file} has no secret`);
  }
});

test('index.html loads the stylesheet with a version query string', () => {
  const html = read('index.html');
  assert.match(html, /<link rel="stylesheet" href="styles\.css\?v=[\w-]+">/);
  assert.match(html, /<html lang="en">/);
});

test('local server uses port 8001 (the origin the edge functions will allow)', () => {
  assert.match(read('serve-local.js'), /const port = 8001;/);
});

test('planning notes with internal decisions stay out of the public repository', () => {
  const ignore = read('.gitignore');
  assert.match(ignore, /^agent\.md$/m);
  assert.match(ignore, /^plano-witcher\.md$/m);
});

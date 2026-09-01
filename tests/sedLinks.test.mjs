import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSedPath, buildSedUrl, resolveSedDeepLink } from '../lib/sedLinks.js';

const seds = { '03483A': { llaves: { A: {} } }, '00338S': { llaves: {} } };

test('a valid dynamic SED resolves from the Base Principal model', () => {
  assert.deepEqual(resolveSedDeepLink(seds, '03483A'), { sedId: '03483A', found: true, notice: '' });
  assert.equal(buildSedPath('03483A'), '/sed/03483A');
});

test('an unknown SED produces a non-blocking notice instead of a route-specific 404', () => {
  const result = resolveSedDeepLink(seds, '05001S');
  assert.equal(result.found, false);
  assert.match(result.notice, /no se encuentra en la Base Principal/);
});

test('SED paths and copied links use safe deterministic URL encoding', () => {
  assert.equal(buildSedPath('SED 01/BT'), '/sed/SED%2001%2FBT');
  assert.equal(buildSedUrl('https://geopluz.example/', 'SED 01/BT'), 'https://geopluz.example/sed/SED%2001%2FBT');
});

test('new SED values require no new route or hardcoded registry', () => {
  const nextSeds = { ...seds, '05001S': { llaves: {} } };
  assert.equal(resolveSedDeepLink(nextSeds, '05001S').found, true);
  const route = readFileSync(new URL('../app/sed/[sedId]/page.js', import.meta.url), 'utf8');
  assert.match(route, /requestedSedId=\{sedId\}/);
  assert.doesNotMatch(route, /03483A|00338S|00813S|05001S/);
});

test('AuthGate preserves the requested pathname through login', () => {
  const authGate = readFileSync(new URL('../components/AuthGate.js', import.meta.url), 'utf8');
  assert.match(authGate, /signInWithPassword/);
  assert.doesNotMatch(authGate, /router\.(push|replace)|window\.location\s*=/);
});

test('main selection updates the route, clearing selection returns home and local projects cannot consume deep links', () => {
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  assert.match(page, /currentSedId \? buildSedPath\(currentSedId\) : '\/'/);
  assert.match(page, /router\.replace\(nextPath, \{ scroll: false \}\)/);
  assert.match(page, /if \(isSedRoute\) \{[\s\S]*?await loadSupabaseData\(\)/);
  assert.match(page, /window\.location\.pathname\.startsWith\('\/sed\/'\)[\s\S]*?router\.replace\('\/'/);
});

test('copy action derives the URL from window origin and selected sedId', () => {
  const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
  const sidebar = readFileSync(new URL('../components/Sidebar.js', import.meta.url), 'utf8');
  assert.match(page, /navigator\.clipboard\.writeText\(buildSedUrl\(window\.location\.origin, currentSedId\)\)/);
  assert.match(sidebar, /Copiar enlace de SED/);
  assert.match(page, /Enlace copiado/);
});

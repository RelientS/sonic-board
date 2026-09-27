import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const landing = readFileSync(new URL('../landing/Landing.tsx', import.meta.url), 'utf8');
const strings = readFileSync(new URL('../landing/StringField.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../landing/landing.css', import.meta.url), 'utf8');
const home = readFileSync(new URL('../page.tsx', import.meta.url), 'utf8');

test('the home page is the landing page and every entry point opens the studio', () => {
  assert.match(home, /return <Landing \/>/);
  assert.equal((landing.match(/href=\{studioHref\}/g) ?? []).length, 3);
  // Invitation links (?ref=) survive the landing page.
  assert.match(landing, /return '\/studio' \+ search;/);
});

test('the string field respects reduced motion and stops when hidden', () => {
  assert.match(strings, /if \(reduceMotion\) \{/);
  assert.match(strings, /new IntersectionObserver/);
  assert.match(strings, /document\.hidden/);
  assert.match(strings, /window\.cancelAnimationFrame\(frame\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  // The canvases are decoration only.
  assert.match(strings, /className="string-field" aria-hidden="true"/);
});

test('the signal chain is an ordered list and the shelf lists the circuit pedals', () => {
  assert.match(landing, /<ol className="chain-steps">/);
  assert.match(landing, /getEffectFidelity\(spec\.id\)\?\.runtime === 'circuit'/);
});

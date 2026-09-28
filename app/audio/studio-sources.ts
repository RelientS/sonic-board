// The studio is split across several components; source-level UI tests read
// them together so an assertion does not depend on which file holds the code.
import { readdirSync, readFileSync } from 'node:fs';

const studioDir = new URL('../studio/', import.meta.url);
const files = readdirSync(studioDir).sort();

export const studioSource = files
  .filter((file) => /\.tsx?$/.test(file))
  .map((file) => readFileSync(new URL(file, studioDir), 'utf8'))
  .join('\n');

export const globalStyles = readFileSync(new URL('../globals.css', import.meta.url), 'utf8');
export const studioStyles = readFileSync(new URL('studio.css', studioDir), 'utf8');

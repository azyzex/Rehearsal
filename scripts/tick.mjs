/**
 * Ticks roadmap items by number: `node scripts/tick.mjs 2 3 4`.
 *
 * The roadmap is a checklist people read to know what is done, so it has to be
 * kept true, and a script is what makes that cheap enough to actually happen.
 */
import * as fs from 'node:fs';

const file = new URL('../ROADMAP.md', import.meta.url);
const numbers = new Set(process.argv.slice(2).map(Number));
let text = fs.readFileSync(file, 'utf8');
let ticked = 0;

text = text.replace(/^- \[ \] (\d+)\./gm, (line, n) => {
  if (!numbers.has(Number(n))) return line;
  ticked += 1;
  return `- [x] ${n}.`;
});

fs.writeFileSync(file, text);
console.log(`ticked ${ticked} of ${numbers.size}`);

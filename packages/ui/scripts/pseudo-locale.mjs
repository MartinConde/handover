import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ACCENTS = {
  a: 'å',
  b: 'ƀ',
  c: 'ç',
  d: 'đ',
  e: 'ë',
  f: 'ƒ',
  g: 'ğ',
  h: 'ħ',
  i: 'ï',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ḿ',
  n: 'ñ',
  o: 'ø',
  p: 'ρ',
  q: 'ǫ',
  r: 'ŕ',
  s: 'š',
  t: 'ŧ',
  u: 'ü',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ÿ',
  z: 'ž',
};

const pseudoText = (value) =>
  [...value]
    .map((character) => {
      const accented = ACCENTS[character.toLowerCase()];
      if (!accented) return character;
      const translated = character === character.toUpperCase() ? accented.toUpperCase() : accented;
      return /[aeiou]/i.test(character) ? translated.repeat(2) : translated;
    })
    .join('');

export const pseudoMessage = (value) =>
  `⟦${value
    .split(/(\{[^{}]+\})/g)
    .map((part) => (part.startsWith('{') && part.endsWith('}') ? part : pseudoText(part)))
    .join('')}⟧`;

export function pseudoCatalog(source) {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => {
      if (typeof value === 'string') return [key, pseudoMessage(value)];
      return [
        key,
        value.map((message) => ({
          ...message,
          match: Object.fromEntries(
            Object.entries(message.match).map(([selector, text]) => [
              selector,
              pseudoMessage(text),
            ]),
          ),
        })),
      ];
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, '../messages/en.json'), 'utf8'),
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'handover-ui-pseudo-'));
  const output = path.join(directory, 'qps-ploc.json');
  fs.writeFileSync(output, `${JSON.stringify(pseudoCatalog(source), null, 2)}\n`);
  process.stdout.write(`${output}\n`);
}

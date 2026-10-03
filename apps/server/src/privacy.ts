// PII guard: masks identifiers (CIN, phone, email, street address) in free text. The schema has no identifier field,
// so anything that looks like one in a text value or a chat message is masked before it is stored or interpreted.

export const MASK = '[masqué]';

const STREET = "rue|avenue|av\\.?|bd|boulevard|lotissement|hay|derb";
const PATTERNS: RegExp[] = [
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // email
  // Moroccan phone: 0[5-7] + 8 digits, or +212 / 00212 + [5-7] + 8 digits; spaces, dots and dashes allowed inside
  /(?<!\d)(?:(?:\+|00)212[\s.-]?(?:\(0\)[\s.-]?)?|0)[5-7](?:[\s.-]?\d){8}(?!\d)/g,
  /(?<![\p{L}\d])[A-Za-z]{1,2}\d{5,7}(?!\d)/gu, // CIN-like: 1-2 letters + 5-7 digits
  // street address: a street word and the (up to 4) words or numbers after it
  new RegExp(`(?<![\\p{L}])(?:${STREET})(?![\\p{L}])(?:\\s+[\\p{L}\\d'’./-]+){1,4}`, 'giu'),
];

export function maskIdentifiers(text: string): { text: string; masked: boolean } {
  const out = PATTERNS.reduce((t, re) => t.replace(re, MASK), text);
  return { text: out, masked: out !== text };
}

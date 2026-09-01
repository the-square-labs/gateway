import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const grantPath = process.argv[2] ?? 'CONTINUITY-MIT-GRANT.md';
const grant = await readFile(grantPath, 'utf8');
const expectedSha256 = 'de7cb3e5aef046afa7379c45761e40c4f59d136a508d31d021dc3d6fd7b1185f';
const actualSha256 = createHash('sha256').update(grant).digest('hex');

if (actualSha256 !== expectedSha256) {
  throw new Error(
    `${grantPath} does not match the canonical continuity grant digest: expected ${expectedSha256}, received ${actualSha256}`
  );
}

const required = [
  '# Good Gateway Product Continuity MIT Grant 1.0',
  'Alexandr Slavinschii',
  'The Square Labs OÜ',
  'Company Ownership Effective Date',
  'Final Dissolution Event',
  'ninety-first consecutive calendar day',
  'Service And Activity Are Not Triggers',
  'Voluntary MIT Election',
  'MIT License Terms',
];

for (const marker of required) {
  if (!grant.includes(marker)) {
    throw new Error(`${grantPath} is missing required continuity marker: ${marker}`);
  }
}

const forbidden = [
  /PolyForm Countdown/i,
  /^## Start Date$/m,
  /24 months/i,
  /180 consecutive calendar days/i,
  /Permanent Cessation Event/i,
];

for (const pattern of forbidden) {
  if (pattern.test(grant)) {
    throw new Error(`${grantPath} contains obsolete release-countdown terms matching ${pattern}`);
  }
}

console.log(`Verified static product continuity grant in ${grantPath}.`);

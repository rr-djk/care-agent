// Final report from the predictions of the VERIFY split (+ the real photo 1-1 against the hand labels): per layout accuracy,
// status accuracy, calibration per category, doubt recall, coverage vs error, latency, clean vs real gap.
// Usage: node --import tsx tools/eval/report.mjs --pred eval-results/predictions-<ts>.jsonl[,photo.jsonl] [--table data/calibration/table.json] [--publish]
// (or: make report ARGS='...'). Output: eval-results/report-<ts>.md; with --publish also a copy in docs/results.md.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fieldRows, readRecords } from './predictions.mjs';
import { ci, pct, wilson } from './stats.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACCEPTED = ['KNOWN', 'NOT_PROVIDED', 'NOT_APPLICABLE']; // statuses that never reach the review queue
const row = (cells) => `| ${cells.join(' | ')} |`;
const table = (head, lines) => [row(head), row(head.map(() => '---')), ...lines.map(row)];
const rate = (k, n) => (n ? `${k}/${n} = ${pct(k / n)} ${ci(...wilson(k, n))}` : 'n/a');
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const s1 = (x) => (x === null ? 'n/a' : x.toFixed(1));

/** Throws on records that are not verify pages (or the real photo): the report is the unbiased measure. */
export function checkRecords(records) {
  if (!records.length) throw new Error('no prediction records');
  for (const r of records) if (!r.photo && r.group !== 'verify') throw new Error(`record ${r.page_no}/${r.variant} is in group "${r.group}": the report takes verify pages only`);
}

/** The markdown report. `realLabels`: real_photos_labels.json; `calibration`: a table or undefined. */
export function buildReport(allRecords, gt, realLabels, calibration, created_at = new Date().toISOString()) {
  checkRecords(allRecords);
  const clean = allRecords.filter((r) => r.variant === 'clean');
  const photos = allRecords.filter((r) => r.photo);
  const ignored = allRecords.length - clean.length - photos.length;
  const rows = fieldRows(clean, gt);
  const photoRows = fieldRows(photos, gt, realLabels);
  const hashes = new Set(allRecords.map((r) => r.pipeline_hash));
  const tableOk = calibration && hashes.size === 1 && hashes.has(calibration.pipeline_hash);
  // the server's rule: a KNOWN field of a demoted category is not auto-accepted
  const demoted = (r) => tableOk && r.field.status === 'KNOWN' && calibration.categories[r.category]?.demote;
  const accepted = (r) => ACCEPTED.includes(r.field.status) && !demoted(r);
  const out = ['# Results on the verify split', ''];
  out.push(`- date: ${created_at}`, `- pages: ${clean.length} clean verify pages${ignored ? ` (${ignored} variant records ignored)` : ''}, real photos: ${photos.length}`);
  out.push(`- pipeline_hash: ${[...hashes].map((h) => `\`${String(h).slice(0, 12)}\``).join(', ')}`);
  out.push(`- calibration table: ${!calibration ? 'none (rows "with table" omitted)' : tableOk ? `applied (pipeline_hash matches, ${Object.values(calibration.categories).filter((c) => c.demote).length} categories demoted)` : 'REFUSED: its pipeline_hash does not match the predictions (ignored)'}`, '');

  out.push('## Accuracy per layout (exact match after normalization)', '');
  const layouts = [...new Set(rows.map((r) => r.record.layout))].sort();
  const acc = (rs) => (rs.length ? rate(rs.filter((r) => r.ok).length, rs.length) : 'n/a');
  out.push(...table(['layout', 'non-empty cells', 'empty cells', 'all'], [...layouts, 'overall'].map((l) => {
    const rs = l === 'overall' ? rows : rows.filter((r) => r.record.layout === l);
    return [l, acc(rs.filter((r) => !r.empty)), acc(rs.filter((r) => r.empty)), acc(rs)];
  })));

  out.push('', '## Status accuracy', '');
  out.push('A status is right when a correct value is accepted (KNOWN, NOT_PROVIDED, NOT_APPLICABLE) or a wrong one is flagged (NEEDS_REVIEW, ILLEGIBLE, UNKNOWN).', '');
  const cells = (rs) => {
    const okAcc = rs.filter((r) => r.ok && accepted(r)).length;
    const wrongFlag = rs.filter((r) => !r.ok && !accepted(r)).length;
    const wrongAcc = rs.filter((r) => !r.ok && accepted(r)).length;
    const okFlag = rs.filter((r) => r.ok && !accepted(r)).length;
    return [rs.length, okAcc, wrongFlag, wrongAcc, okFlag, rate(okAcc + wrongFlag, rs.length)];
  };
  out.push(...table(['population', 'fields', 'correct, accepted', 'wrong, flagged', 'wrong, accepted (silent error)', 'correct, flagged (needless review)', 'status accuracy'], [
    ['all fields', ...cells(rows)],
    ['handwritten (non-empty truth)', ...cells(rows.filter((r) => !r.empty))],
  ]));

  out.push('', '## Calibration per category: accuracy of KNOWN fields', '');
  const cats = [...new Set(rows.map((r) => r.category))].sort();
  out.push(...table(['category', 'KNOWN on verify', 'accuracy [Wilson 95 %]', 'table (calibrate)', 'observed inside the table interval'], cats.map((c) => {
    const known = rows.filter((r) => r.category === c && r.field.status === 'KNOWN');
    const t = tableOk ? calibration.categories[c] : undefined;
    const observed = known.length ? known.filter((r) => r.ok).length / known.length : null;
    const inside = !t || t.accuracy === null || observed === null ? 'n/a' : observed >= t.low && observed <= t.high ? 'yes' : 'NO';
    return [c, known.length, acc(known), t ? (t.accuracy === null ? 'insufficient n' : `${pct(t.accuracy)} ${ci(t.low, t.high)}${t.demote ? ' demoted' : ''}`) : 'n/a', inside];
  })));

  out.push('', '## Doubt recall: wrong values that were flagged', '');
  out.push(...table(['category', 'doubt recall'], [...cats, 'all'].map((c) => {
    const wrong = rows.filter((r) => (c === 'all' || r.category === c) && !r.ok);
    return [c, wrong.length ? rate(wrong.filter((r) => r.flagged).length, wrong.length) : 'no wrong value'];
  })));

  out.push('', '## Coverage against error (auto-accepted = no review needed)', '');
  const cov = (rs, pred) => {
    const a = rs.filter(pred);
    return [rate(a.length, rs.length), rate(a.filter((r) => !r.ok).length, a.length)];
  };
  const populations = [['all fields', rows], ['handwritten text (non-empty truth)', rows.filter((r) => !r.empty && r.field.type !== 'checkbox')]];
  const covRows = [];
  for (const [name, rs] of populations) {
    covRows.push([name, 'as read (KNOWN, NOT_PROVIDED, NOT_APPLICABLE)', ...cov(rs, (r) => ACCEPTED.includes(r.field.status))]);
    covRows.push([name, 'only KNOWN', ...cov(rs, (r) => r.field.status === 'KNOWN')]);
    if (tableOk) covRows.push([name, 'with the table (demoted categories reviewed)', ...cov(rs, accepted)]);
  }
  out.push(...table(['population', 'auto-accepted', 'coverage', 'error rate among accepted'], covRows));

  out.push('', '## Latency per page (model time measured by Ollama, cache hits included)', '');
  const lat = (rs) => rs.map((r) => r.latency.model_s);
  out.push(...table(['layout', 'pages', 'mean s', 'median s', 'max s'], [...layouts, 'all pages'].map((l) => {
    const xs = lat(l === 'all pages' ? clean : clean.filter((r) => r.layout === l));
    return [l, xs.length, s1(mean(xs)), s1(median(xs)), s1(xs.length ? Math.max(...xs) : null)];
  })));

  out.push('', '## Clean specimens against the real photo', '');
  if (!photos.length) out.push('No real photo record (run make predict ... --real 1-1 --limit 0).');
  else {
    const coverClean = rows.filter((r) => r.record.layout === 'cover');
    const line = (name, rs) => [name, acc(rs.filter((r) => !r.empty && r.field.type !== 'checkbox')), acc(rs.filter((r) => r.field.type === 'checkbox')), acc(rs)];
    out.push(...table(['reading', 'handwritten text', 'checkboxes', 'all labelled fields'], [line('clean cover (verify specimens)', coverClean), line('real photo 1-1 (real_cover vs hand labels)', photoRows)]));
    const bad = photoRows.filter((r) => !r.ok);
    out.push('', `Real photo gate: ${photos.map((p) => `${p.photo} ${p.gate.outcome}`).join(', ')}. Wrong fields (${bad.length}):`, '');
    out.push(...bad.map((r) => `- \`${r.field.field_id}\` read ${JSON.stringify(r.field.value)} status ${r.field.status}${accepted(r) ? ' (accepted: silent error)' : ' (sent to review)'}`));
    out.push('', 'The hand labels were written by an AI and are to be verified by a human (docs/labeling.md); the photo was never used to tune or calibrate anything.');
  }
  return out.join('\n') + '\n';
}

async function main() {
  const { values } = parseArgs({ options: { pred: { type: 'string' }, table: { type: 'string', default: 'data/calibration/table.json' }, publish: { type: 'boolean', default: false } } });
  if (!values.pred) throw new Error('--pred <predictions.jsonl[,photo.jsonl]> is required (make predict --split verify ...)');
  const records = await readRecords(values.pred.split(','));
  const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
  let calibration;
  try {
    calibration = read(resolve(repo, values.table));
  } catch {} // no table yet: the report omits the "with table" rows
  const report = buildReport(records, read(resolve(repo, 'tools/eval/data/ground_truth.json')), read(resolve(repo, 'tools/eval/data/real_photos_labels.json')), calibration);
  mkdirSync(resolve(repo, 'eval-results'), { recursive: true });
  const file = resolve(repo, `eval-results/report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  writeFileSync(file, report);
  console.log(report);
  console.log(`wrote ${file}`);
  if (values.publish) {
    copyFileSync(file, resolve(repo, 'docs/results.md'));
    console.log(`published to ${resolve(repo, 'docs/results.md')}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`report failed: ${e.message}`);
    process.exit(1);
  });
}

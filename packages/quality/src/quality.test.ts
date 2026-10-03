import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { assess, createStability, loadCv, TEMPLATE, THRESHOLDS, warpPage, type Quad } from './index';
import { cropLeft, exposure, gaussianBlur, glareBlob, MILD, motionBlur, onTable, STRONG, syntheticPage } from './synthetic';

before(() => loadCv());

const page = () => syntheticPage();
const run = (img = page(), opts?: { live?: boolean }) => assess(img, opts);

test('metrics: sharp vs blurred, motion, dark, glare', () => {
  const sharp = run();
  assert.ok(sharp.details.blur.sharpness > THRESHOLDS.blurMin * 4, `sharp ${sharp.details.blur.sharpness}`);
  assert.ok(sharp.details.blur.tiles > 20);
  for (const sigma of [2, 4, 8]) {
    const blurred = run(gaussianBlur(page(), sigma));
    assert.ok(blurred.details.blur.sharpness < sharp.details.blur.sharpness / 4, `sigma ${sigma}: ${blurred.details.blur.sharpness}`);
  }
  assert.ok(run(motionBlur(page(), 25)).details.blur.isotropy < THRESHOLDS.isotropyMin);
  assert.ok(run(exposure(page(), 0.4)).result.metrics.brightness < THRESHOLDS.lumaDarkMax);
  assert.ok(run().result.metrics.glare < 0.001);
  assert.ok(run(glareBlob(page(), 0.08)).result.metrics.glare > THRESHOLDS.glareMax);
});

test('a flat full-page render counts as well framed (quad = whole image)', () => {
  const { details, result } = run();
  assert.equal(details.fullPage, true);
  assert.equal(result.metrics.framing, 1);
  assert.deepEqual(details.quad!.map((p) => [Math.round(p.x * 100), Math.round(p.y * 100)]), [[0, 0], [100, 0], [100, 100], [0, 100]]);
});

test('quad detection on a page photographed on a dark table, with perspective', () => {
  for (const corners of [MILD, STRONG]) {
    const img = onTable(page(), corners);
    const { quad, fullPage } = run(img).details;
    assert.equal(fullPage, false);
    assert.ok(quad);
    quad!.forEach((p, i) => {
      assert.ok(Math.abs(p.x - corners[i][0]) < 0.02 && Math.abs(p.y - corners[i][1]) < 0.02, `corner ${i}: ${p.x},${p.y} vs ${corners[i]}`);
    });
  }
});

test('warpPage: rectified to the template size, page corners land on the corners; full-page and no-page images unchanged', () => {
  const photo = onTable(page(), STRONG);
  const w = warpPage(photo);
  assert.equal(w.warped, true);
  assert.deepEqual([w.image.width, w.image.height, w.image.channels], [TEMPLATE.width, TEMPLATE.height, 3]);
  const px = (x: number, y: number) => [0, 1, 2].map((c) => w.image.data[(y * w.image.width + x) * 3 + c]);
  for (const [x, y] of [[20, 20], [TEMPLATE.width - 20, 20], [20, TEMPLATE.height - 20], [TEMPLATE.width - 20, TEMPLATE.height - 20]]) {
    const [r, g] = px(x, y);
    assert.ok(r > 200 && g > 150, `corner (${x},${y}) is not paper: ${px(x, y)}`); // the dark table (35,33,30) would fail
  }
  const flat = page();
  const same = warpPage(flat);
  assert.equal(same.warped, false);
  assert.equal(same.image, flat);
  const black = exposure(page(), 0);
  assert.equal(warpPage(black).warped, false);
});

test('gate outcomes', () => {
  const cases: [string, ReturnType<typeof page>, 'OK' | 'WARNING' | 'REJECT', RegExp?][] = [
    ['clean', page(), 'OK'],
    ['clean on table', onTable(page(), MILD), 'OK'],
    ['blur', gaussianBlur(page(), 4), 'WARNING', /floue/],
    ['motion', motionBlur(page(), 25), 'WARNING', /bougée/],
    ['dark', exposure(page(), 0.4), 'WARNING', /sombre/],
    ['black', exposure(page(), 0.05), 'REJECT', /noire/],
    ['overexposed', exposure(page(), 1.3, 70), 'WARNING', /clair|Reflet|détectée/],
    ['glare', glareBlob(page(), 0.08), 'WARNING', /Reflet/],
    ['cropped 20%', cropLeft(page(), 0.2), 'WARNING', /coupée/],
    ['strong perspective', onTable(page(), STRONG), 'WARNING', /biais/],
    ['no paper', onTable(exposure(page(), 0), MILD), 'REJECT', /noire|Aucune page/],
  ];
  for (const [name, img, outcome, message] of cases) {
    const { result } = run(img);
    assert.equal(result.outcome, outcome, `${name}: ${result.outcome} ${result.messages}`);
    if (message) assert.ok(result.messages.some((m) => message.test(m)), `${name}: ${result.messages}`);
    if (outcome === 'OK') assert.deepEqual(result.messages, []);
  }
});

test('live mode skips glare', () => {
  const { details, result } = run(glareBlob(page(), 0.08), { live: true });
  assert.equal(details.glare, null);
  assert.equal(result.metrics.glare, 0);
});

test('stability: auto-capture after 0.5 s of passing frames that hold still', () => {
  const quad: Quad = [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }];
  const moved: Quad = quad.map((p) => ({ x: p.x + 0.05, y: p.y })) as Quad;
  const s = createStability();
  assert.equal(s.push(0, true, quad), false);
  assert.equal(s.push(300, true, quad), false);
  assert.equal(s.push(600, true, quad), true);
  s.reset();
  assert.equal(s.push(0, true, quad), false);
  assert.equal(s.push(400, false, quad), false); // a failing frame restarts the hold
  assert.equal(s.push(500, true, quad), false);
  assert.equal(s.push(900, true, moved), false); // the page moved: restart
  assert.equal(s.push(1500, true, moved), true);
});

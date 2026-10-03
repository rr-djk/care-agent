#!/usr/bin/env node
// One-shot bootstrap of packages/schema/pages/{identification,pregnancy,delivery}.json from the ground truth
// (printed labels + observed values over the 10 specimen patients) and tools/eval/data/zones/*.json.
// The generated JSON files are then the source of truth and may be hand-edited: re-running this script
// (`make schemas`) OVERWRITES those edits.
// Usage: build_schemas.mjs [--out dir]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const LAYOUTS = ['identification', 'pregnancy', 'delivery'];

// --- hand-written knowledge (everything else is inferred from the observed values) ---------------------------

// English label per row (key without the page prefix and the column part).
const EN = {
  age: 'Age', niveau_d_instruction: 'Education level', profession: 'Occupation', consanguinite: 'Consanguinity',
  grossesse_desiree: 'Wanted pregnancy', hta: 'Hypertension', diabete: 'Diabetes', maladies_hereditaires: 'Hereditary diseases',
  malformations: 'Malformations', allergie_s: 'Allergies', antecedents_de_la_femme: "Woman's history",
  avortement: 'Abortion', accouchement_premature: 'Preterm delivery', mort_foetale_in_utero: 'Intrauterine fetal death',
  autres_a_preciser: 'Other (specify)', date: 'Date', modalite_d_extraction: 'Mode of delivery',
  si_cesarienne_indication: 'If caesarean: indication', complication_type: 'Complication (type)',
  poids_nouveau_ne_s: 'Newborn weight', compl_nouveau_ne_type: 'Newborn complication (type)', gestation: 'Gravidity',
  parite: 'Parity', nombre_d_enfants_vivants: 'Number of living children', vat_1: 'Tetanus vaccine dose 1',
  vat_2: 'Tetanus vaccine dose 2', vat_3: 'Tetanus vaccine dose 3', vat_4: 'Tetanus vaccine dose 4',
  vat_5: 'Tetanus vaccine dose 5', vaccinee_contre_la_rubeole: 'Vaccinated against rubella',
  le_vaccinee_contre_la_rubeole: 'Rubella vaccination date', vaccinee_contre_l_hepatite_b: 'Vaccinated against hepatitis B',
  le_vaccinee_contre_l_hepatite_b: 'Hepatitis B vaccination date', frottis_cervical_iva_moins_de_3_ans: 'Cervical smear / VIA (< 3 years)',
  ddr: 'LMP', taille: 'Height', groupage_a: 'Blood group A', groupage_b: 'Blood group B', groupage_o: 'Blood group O',
  groupage_ab: 'Blood group AB', rh_minus: 'Rh negative', rh_plus: 'Rh positive', date_prevue_d_accouchement: 'Expected delivery date',
  date_de_depassement_de_terme: 'Post-term date', rendez_vous: 'Appointment', venue_le: 'Came on', visites_de_relance: 'Follow-up visits',
  age_probable: 'Probable gestational age', poids_kg: 'Weight (kg)', ta: 'Blood pressure', anomalies_squelette: 'Skeletal anomalies',
  etat_des_conjonctives: 'Conjunctivae', examen_des_seins: 'Breast exam', oedemes: 'Edema', mouvements_actifs: 'Active movements',
  hu_cm: 'Fundal height (cm)', bcf: 'Fetal heart rate', examen_au_speculum: 'Speculum exam', tv_etat_du_col: 'VE: cervix state',
  tv_presentation: 'VE: presentation', tv_bassin: 'VE: pelvis', glucosurie: 'Glycosuria', albuminurie: 'Albuminuria',
  rubeole: 'Rubella', toxoplasmose: 'Toxoplasmosis', syphilis_tpha_vdrl: 'Syphilis (TPHA/VDRL)', ag_hbs: 'HBs antigen',
  serologie_vih: 'HIV serology', hemoglobine: 'Hemoglobin', plaquettes: 'Platelets', bilan_glycemique: 'Glycemic assessment',
  rai_si_rh_negatif: 'RAI (if Rh negative)', fer: 'Iron', examen_fait_par: 'Examined by',
  maison_d_accouchement: 'Birth house', en_milieu_surveille: 'Supervised setting', maternite: 'Maternity ward',
  clinique_privee: 'Private clinic', autres: 'Other place of delivery', a_domicile: 'At home',
  assiste_par_un_personnel_qualifie: 'Attended by skilled personnel', autres_2: 'Other (attendance)',
  date_de_l_accouchement: 'Delivery date', voie_basse_non_instrumentale: 'Vaginal, non-instrumental',
  voie_basse_instrumentale: 'Vaginal, instrumental', forceps: 'Forceps', ventouse: 'Vacuum', avec_episiotomie: 'With episiotomy',
  cesarienne_programmee: 'Caesarean: planned', urgence: 'Caesarean: emergency', presence_de_complications: 'Complications present',
  au_moment_de_l_accouchement: 'Complications at delivery', suites_de_couches: 'Complications in postpartum',
  pre_eclampsie: 'Pre-eclampsia', eclampsie: 'Eclampsia', hemorragie: 'Hemorrhage', infection: 'Infection',
  autres_type_de_complications: 'Other complications', si_autres_a_preciser: 'If other, specify', deces_24_heures: 'Death < 24 hours',
  vivant: 'Alive', mort_ne: 'Stillborn', sexe: 'Sex', poids_a_la_naissance: 'Birth weight',
  perimetre_cranien_a_la_naissance: 'Head circumference at birth', anomalie_a_preciser: 'Anomaly (specify)',
  age_gestationnel: 'Gestational age', preciser_l_indication_text: 'Indication (specify)',
};

// Column parts of a key: key suffix -> [short header (prompt), label_fr part, label_en part].
const COLS = {
  famille_de_la_femme: ['Famille de la femme', 'famille de la femme', "woman's family"],
  mari_famille: ['Mari / famille', 'mari / famille', "partner's family"],
  medicaux: ['Médicaux', 'médicaux', 'medical'],
  chirurgicaux: ['Chirurgicaux', 'chirurgicaux', 'surgical'],
  gynecologiques: ['Gynécologiques', 'gynécologiques', 'gynecological'],
  nombre: ['Nombre', 'nombre', 'number'],
  date: ['Date', 'date', 'date'],
  lieu: ['Lieu', 'lieu', 'place'],
  age_gestationnel_sa: ['Âge gest. (SA)', 'âge gestationnel (SA)', 'gestational age (SA)'],
};
function column(suffix) {
  if (COLS[suffix]) return COLS[suffix];
  let m = /^accouch_(\d)$/.exec(suffix);
  if (m) return [`Acc. ${m[1]}`, `accouchement ${m[1]}`, `delivery ${m[1]}`];
  m = /^v(\d)_t(\d)$/.exec(suffix);
  if (m) return [`T${m[2]} V${m[1]}`, `${m[2] === '1' ? '1er' : `${m[2]}ème`} trim. visite ${m[1]}`, `T${m[2]} visit ${m[1]}`];
  m = /^m(\d)_t3$/.exec(suffix);
  if (m) return [`T3 M${m[1]}`, `3ème trim. mois ${m[1]}`, `T3 month ${m[1]}`];
  throw new Error(`no column definition for key suffix "${suffix}"`);
}

// printed label -> label_fr when the printed text alone is ambiguous
const FR = {
  'p02.vat_1': 'VAT dose 1', 'p02.vat_2': 'VAT dose 2', 'p02.vat_3': 'VAT dose 3', 'p02.vat_4': 'VAT dose 4', 'p02.vat_5': 'VAT dose 5',
  'p02.le_vaccinee_contre_la_rubeole': 'Vaccinée contre la rubéole : date', 'p02.le_vaccinee_contre_l_hepatite_b': "Vaccinée contre l'hépatite B : date",
  'p03.groupage_a': 'Groupage A', 'p03.groupage_b': 'Groupage B', 'p03.groupage_o': 'Groupage O', 'p03.groupage_ab': 'Groupage AB',
  'p04.autres': "Autres (lieu d'accouchement)", 'p04.autres_2': 'Autres (assistance)', 'p04.urgence': 'Césarienne : urgence',
  'p04.autres_type_de_complications': 'Complications : autres', 'p04.au_moment_de_l_accouchement': "Complications au moment de l'accouchement",
  'p04.suites_de_couches': 'Complications : suites de couches',
};

// Enum-like rows: allowed values are advisory (supersets of what the specimens show).
const OUI_NON = ['Oui', 'Non'];
const NEG_POS = ['Neg', 'Pos'];
const IMMUNE = ['Immune', 'Non immune'];
const ENUMS = {
  'p03.visites_de_relance': OUI_NON, 'p03.oedemes': OUI_NON, 'p03.mouvements_actifs': OUI_NON, 'p03.fer': OUI_NON,
  'p03.rubeole': IMMUNE, 'p03.toxoplasmose': IMMUNE,
  'p03.glucosurie': NEG_POS, 'p03.albuminurie': NEG_POS, 'p03.syphilis_tpha_vdrl': NEG_POS, 'p03.ag_hbs': NEG_POS,
  'p03.serologie_vih': NEG_POS, 'p03.rai_si_rh_negatif': NEG_POS,
  'p03.etat_des_conjonctives': ['Normales', 'Pâles', 'Décolorées'], 'p03.examen_des_seins': ['Normaux', 'Anormaux'],
  'p03.tv_bassin': ['Normal', 'Anormal'], 'p03.tv_presentation': ['Céphalique', 'Siège', 'Transverse'],
  'p02.modalite_d_extraction': ['Voie basse', 'Césarienne'], 'p02.frottis_cervical_iva_moins_de_3_ans': ['Normal', 'Anormal', 'Non fait'],
  'p04.sexe': ['M', 'F'],
};

// Numeric plausibility ranges (validator range:<min>:<max>), by row.
const RANGES = {
  'p02.age': [12, 55], 'p03.taille': [120, 200], 'p03.poids_kg': [30, 200], 'p03.hu_cm': [5, 45], 'p03.bcf': [100, 180],
  'p03.hemoglobine': [4, 20], 'p02.poids_nouveau_ne_s': [400, 6000], 'p04.poids_a_la_naissance': [400, 6000],
  'p04.perimetre_cranien_a_la_naissance': [20, 45], 'p03.age_probable': [4, 45], 'p04.age_gestationnel': [4, 45],
};
const UNITS = { 'p03.bcf': 'bpm' }; // not printed in the label nor in the values

// Type/category overrides by field id (first match wins) for what the observed values cannot tell.
const OVERRIDES = [
  [/^p02\.[a-z_]+\.nombre$/, { type: 'number', category: 'admin_number' }],
  [/^p02\.[a-z_]+\.age_gestationnel_sa$/, { type: 'number', category: 'vital_number', unit: 'SA', range: [4, 45] }],
  [/^p02\.[a-z_]+\.(date|lieu)$/, { type: 'short_text', category: 'short_text' }], // "date" is a year here ("2023")
  [/^p02\.antecedents_de_la_femme\./, { type: 'free_text', category: 'free_text' }],
  [/^p04\.(autres|autres_2)$/, { type: 'short_text', category: 'short_text' }],
  [/^p04\.(si_autres_a_preciser|preciser_l_indication_text)$/, { type: 'free_text', category: 'free_text' }],
  [/^p03\.examen_fait_par\./, { type: 'short_text', category: 'short_text' }], // staff name: stored as "<staff>" in the ground truth
  [/^p02\.(gestation|parite|nombre_d_enfants_vivants)$/, { type: 'number', category: 'admin_number' }],
];

// Applicability, written "<field id> = <value>" ("{n}" = same accouchement number).
const APPLICABILITY = [
  [/^(p02\.si_cesarienne_indication\.accouch_(\d))$/, (m) => `p02.modalite_d_extraction.accouch_${m[2]} = Césarienne`],
  [/^p03\.rai_si_rh_negatif\./, () => 'p03.rh_minus = true'],
  [/^p04\.si_autres_a_preciser$/, () => 'p04.autres_type_de_complications = true'],
];

// --- inference -----------------------------------------------------------------------------------------------

const LAB = /hemoglobine|plaquettes|bilan_glycemique|glucosurie|albuminurie|rubeole|toxoplasmose|syphilis|ag_hbs|vih|rai_|frottis/;
const DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const BP = /^\d{2,3}\/\d{2,3}$/;
const NUM = /^\d+(?:[.,]\d+)?\s*(\D*)$/;
const NOTHING = new Set(['', '—', '<staff>']);

// "p03.poids_kg.v2_t2" -> row "p03.poids_kg", column suffix "v2_t2" (null for single cells).
function split(key) {
  const [page, row, col] = key.split('.');
  return { row: `${page}.${row}`, col: col ?? null };
}

function infer(id, row, kind, label, values) {
  const seen = values.map((v) => String(v).replace(/\0/g, '').trim()).filter((v) => !NOTHING.has(v));
  const out = { confident: true, validators: [] };
  if (kind === 'checkbox') return { ...out, type: 'checkbox', category: 'checkbox' };
  if (ENUMS[row]) {
    Object.assign(out, { type: 'enum', allowed_values: ENUMS[row], category: LAB.test(row) ? 'lab_result' : 'short_text' });
  } else if (seen.length && seen.every((v) => DATE.test(v))) {
    Object.assign(out, { type: 'date', category: /rendez_vous|venue_le/.test(row) ? 'date_admin' : 'date_clinical', validators: ['date'] });
  } else if (seen.length && seen.every((v) => BP.test(v))) {
    Object.assign(out, { type: 'short_text', category: 'vital_number', unit: 'mmHg', validators: ['bp'] });
  } else if (seen.length && seen.every((v) => NUM.test(v))) {
    const units = new Set(seen.map((v) => NUM.exec(v)[1]));
    const fromLabel = /\(([^)]+)\)/.exec(label)?.[1];
    const unit = units.size === 1 && [...units][0] ? [...units][0] : fromLabel;
    Object.assign(out, { type: 'number', category: LAB.test(row) ? 'lab_result' : 'vital_number', ...(unit && { unit }) });
  } else if (seen.length) {
    Object.assign(out, { type: 'short_text', category: LAB.test(row) ? 'lab_result' : 'short_text' });
  } else {
    Object.assign(out, { type: 'free_text', category: 'free_text', confident: false });
  }
  for (const [re, o] of OVERRIDES) {
    if (re.test(id)) {
      Object.assign(out, o, { confident: true });
      if (o.type !== 'enum') delete out.allowed_values;
      break;
    }
  }
  if (UNITS[row]) out.unit = UNITS[row];
  const range = RANGES[row] ?? out.range;
  delete out.range;
  if (range && out.type === 'number') out.validators = [`range:${range[0]}:${range[1]}`];
  if (out.type === 'number' && /^p02\.(age|gestation|parite|nombre_d_enfants_vivants)$|\.nombre$/.test(id)) out.category = 'admin_number';
  return out;
}

// --- build ---------------------------------------------------------------------------------------------------

function buildLayout(zonesFile, gt) {
  const pageNos = Object.keys(gt).filter((n) => gt[n].layout === zonesFile.layout);
  const slotByKey = {}; // key -> {label, kind, values[]}
  for (const n of pageNos) {
    for (const s of gt[n].slots) (slotByKey[s.key] ??= { label: s.label, kind: s.kind, values: [] }).values.push(s.value);
  }
  const valuesByRow = {};
  for (const [key, s] of Object.entries(slotByKey)) (valuesByRow[split(key).row] ??= []).push(...s.values);

  const fields = [];
  const zones = [];
  const unconfident = [];
  for (const z of zonesFile.zones) {
    // table zone: cells come in consecutive groups of one row each, all of the same size >= 2
    const groups = [];
    for (const c of z.cells) {
      const { row } = split(c.key);
      if (groups.at(-1)?.row === row) groups.at(-1).cells.push(c);
      else groups.push({ row, cells: [c] });
    }
    const size = groups[0].cells.length;
    const isTable = groups.length > 1 && size > 1 && groups.every((g) => g.cells.length === size);
    for (const c of z.cells) {
      const slot = slotByKey[c.key];
      if (!slot) throw new Error(`no ground-truth slot for zone cell ${c.key}`);
      const { row, col } = split(c.key);
      const label = slot.label.replace(/\s*:$/, ''); // "Autres à préciser :"
      const base = row.slice(4);
      if (!EN[base]) throw new Error(`no English label for row "${base}" (${c.key})`);
      const [, colFr, colEn] = col ? column(col) : [];
      const f = infer(c.key, row, slot.kind, slot.label, valuesByRow[row]);
      if (!f.confident) unconfident.push(c.key);
      const applic = APPLICABILITY.map(([re, fn]) => { const m = re.exec(c.key); return m && fn(m); }).find(Boolean);
      fields.push({
        id: c.key,
        label_fr: (FR[row] ?? label) + (col ? ` — ${colFr}` : ''),
        label_en: EN[base] + (col ? ` — ${colEn}` : ''),
        type: f.type,
        category: f.category,
        ...(f.unit && { unit: f.unit }),
        ...(f.allowed_values && { allowed_values: f.allowed_values }),
        ...(applic && { applicability: applic }),
        validators: f.validators,
        zone: z.id,
      });
    }
    const zone = { id: z.id, bbox_frac: z.bbox_frac };
    if (isTable) {
      zone.rows = groups.map((g) => slotByKey[g.cells[0].key].label.replace(/\s*:$/, ''));
      zone.columns = groups[0].cells.map((c) => column(split(c.key).col)[0]);
      // visit columns 2 and 3 of the pregnancy table have no row labels in their crop: prepend the c1 label column
      const m = /^(p03\.visits\.r\d)c([23])$/.exec(z.id);
      if (m) {
        const c1 = zonesFile.zones.find((q) => q.id === `${m[1]}c1`);
        zone.label_strip = [c1.bbox_frac[0], c1.bbox_frac[1], Math.min(...c1.cells.map((c) => c.bbox_frac[0])), c1.bbox_frac[3]];
      }
    }
    zone.cells = z.cells.map((c) => c.key);
    zones.push(zone);
  }
  return { schema: { layout: zonesFile.layout, page_types: [zonesFile.page_type], fields, zones, masks: zonesFile.masks }, unconfident };
}

// One field/zone per line: readable diffs for a hand-edited file.
const j = JSON.stringify;
function render(s) {
  return `{\n"layout": ${j(s.layout)},\n"page_types": ${j(s.page_types)},\n"fields": [\n${s.fields.map((f) => `  ${j(f)}`).join(',\n')}\n],\n`
    + `"zones": [\n${s.zones.map((z) => `  ${j(z)}`).join(',\n')}\n],\n"masks": ${j(s.masks)}\n}\n`;
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string', default: resolve(here, '..', '..', 'packages', 'schema', 'pages') } } });
  const gt = JSON.parse(await readFile(join(here, 'data', 'ground_truth.json'), 'utf8'));
  await mkdir(values.out, { recursive: true });
  for (const layout of LAYOUTS) {
    const zonesFile = JSON.parse(await readFile(join(here, 'data', 'zones', `${layout}.json`), 'utf8'));
    const { schema, unconfident } = buildLayout(zonesFile, gt);
    await writeFile(join(values.out, `${layout}.json`), render(schema));
    const by = (k) => Object.entries(schema.fields.reduce((a, f) => ({ ...a, [f[k]]: (a[f[k]] ?? 0) + 1 }), {})).map(([n, c]) => `${n}=${c}`).join(' ');
    console.log(`${layout}: ${schema.fields.length} fields, ${schema.zones.length} zones\n  type: ${by('type')}\n  category: ${by('category')}`);
    if (unconfident.length) console.log(`  not typed confidently (free_text by default): ${unconfident.join(', ')}`);
  }
}

main().catch((e) => {
  console.error(`build_schemas failed: ${e.message}`);
  process.exit(1);
});

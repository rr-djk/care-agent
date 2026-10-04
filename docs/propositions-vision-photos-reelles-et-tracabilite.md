# Propositions : vision sur photos réelles, traçabilité et prudence

Brouillon de discussion (3 octobre 2026), à relire. Ce document rassemble les ajouts envisagés pour que la lecture des pages tienne sur les **photos du jury** : « photos dégradées comme sur le terrain (flou, ombres, inclinaison, faible lumière) », d'après les consignes DayOne §4. Certaines idées sont reprises du défi L2C.

Chaque proposition indique ce qui **existe déjà** dans `main`, d'après l'état du dépôt à l'étape 13.

## Constats de départ

- Les consignes DayOne ne recommandent **aucune** technologie. La liste « PyMuPDF, OpenCV, PaddleOCR/Tesseract, YOLO, Pydantic, ReportLab, Streamlit » vient des consignes **L2C**. Les consignes DayOne demandent au contraire de « définir le schéma de champs […] plutôt que faire de l'OCR générique ».
- Une image coûte un nombre de tokens à peu près fixe : Ollama ne permet pas de régler ce budget (`docs/runtime-notes.md`). Plus le crop est petit, plus l'écriture est lisible. Le coût vient du nombre de crops (~15–25 s de lecture par appel), pas du nombre de cellules (`docs/scaling.md`).
- Donner des coordonnées **en texte** au modèle (« regarde en x=0.32 ») marche mal avec un petit VLM. Il vaut mieux **modifier l'image** qu'on lui envoie.
- Ce que montre la photo `1-3.jpg` : perspective et fond de table, livret ouvert (page voisine visible), encre bleue sur papier rose, imprimé gris. On y voit aussi des **traits en diagonale qui barrent plusieurs cellules** (« RAS », « 1G ») et de l'écriture qui **déborde** des petites zones `/__/` (« 1G », « 00 »).

## A. Vision : rendre le pipeline robuste aux photos

### A1. Type de page : vérification automatique

- **Existe** : la sage-femme choisit le type de page à la capture (étape 7). Le CLI prend `--layout` ou le lit dans la vérité terrain (`apps/server/src/cli/pages.ts`).
- **Proposition** : lire le titre et quelques labels imprimés par OCR (Tesseract via `tesseract.js`, pour rester en TS) et comparer au type choisi. En cas de désaccord, demander confirmation, sans jamais bloquer. Le texte imprimé est toujours du Helvetica, que Tesseract en français lit de façon fiable.
- Pas d'OCR pour lire le **manuscrit** : Tesseract et PaddleOCR y sont faibles, Gemma garde ce rôle.

### A2. Recalage fin sur le gabarit

- **Existe** : `warpPage` (étape 10, `docs/quality.md`) trouve les 4 coins de la page et la redresse en A4 1654 × 2339. Limites notées dans ce document : un livret ouvert (1-2 … 1-5) donne les deux pages comme une seule, qui ne correspond plus au gabarit d'une page.
- **Proposition** :
  1. Pour un livret ouvert, isoler une seule page (repérer la reliure, puis recadrer) avant le redressement.
  2. Ajouter un recalage **fin** après le redressement : détecter les lignes de la grille des tableaux, ou les labels imprimés lus par OCR, et calculer une petite homographie de correction vers le gabarit. Les 4 coins de la page ne suffisent pas si le papier est courbé ou si la page est mal détectée.
  3. Calculer une **erreur de recalage** (écart moyen entre les points de repère attendus et ceux trouvés). Elle alimente la proposition C2.

### A3. Détection d'encre par la couleur

- **Existe** : un seuil de luminosité fixe, `INK_LUMA = 140` (`apps/server/src/vision/ink.ts`), réglé sur les rendus propres. L'étape 12 relève des faux positifs d'encre sur les cases à cocher de la photo réelle 1-1.
- **Proposition** : séparer par la teinte et la saturation. L'encre est bleue (ou noire), le papier rose, l'imprimé gris foncé, c'est-à-dire peu saturé. On garde la teinte bleue avec une saturation suffisante, et le noir peu lumineux pour les stylos noirs. L'imprimé disparaît alors par construction, et les ombres touchent beaucoup moins la mesure qu'avec la luminosité. À recalibrer avec `npm run ink-eval` (rendus) et sur les photos étiquetées.

### A4. Traits « néant » qui barrent plusieurs cellules

- **Proposition** : repérer les composantes d'encre longues, fines et en diagonale qui traversent plusieurs cellules. Elles signifient « rien à signaler » pour le bloc, pas une valeur dans chaque cellule. Les cellules barrées passent à `NOT_PROVIDED` (ou on demande au modèle de lire la mention une seule fois) au lieu d'envoyer des fragments au modèle. Si c'est ambigu, `NEEDS_REVIEW`.

## B. Ce qu'on montre au modèle

À mesurer avec `make eval` contre le crop de zone actuel, en exactitude et en temps.

- **B1. Crop serré sur l'encre réelle.** La boîte englobante des pixels d'encre de la zone, plus une marge, au lieu de la boîte du gabarit. On gagne de la résolution et on rattrape l'écriture qui déborde.
- **B2. Cadres numérotés sur le crop** (« Set-of-Mark »). Dessiner autour de chaque cellule demandée un cadre portant le numéro de sa ligne dans le prompt guidé. Le contexte visuel reste intact.
- **B3. Mosaïque de fragments d'encre.** Assembler dans une seule image les fragments d'encre des cellules demandées, chacun numéroté. Cela donne la meilleure résolution par cellule pour un seul appel, et seule l'encre des champs autorisés quitte l'appareil (confidentialité par construction). Le prix : moins de contexte visuel, compensé en partie par le nom du champ dans le prompt.

## C. Repris de L2C : traçabilité et prudence

### C1. Position source de chaque valeur

L2C exige « le feuillet et les coordonnées X, Y comme point de référence » et note la « facilité pour l'ingénieur de retrouver l'élément sur le feuillet ».

- **Existe** : `ExtractedField.evidence` = l'id du crop de **zone** (`packages/schema/src/field.ts`), pas la position de la cellule.
- **Proposition** : ajouter `bbox_frac` (optionnel) à `ExtractedField`, dans les coordonnées de la photo d'origine (boîte du gabarit recalée, ou boîte de l'encre de B1). Mettre à jour `docs/api.md`. La PWA affiche alors le petit crop de la cellule, masques d'identifiants appliqués, à côté de la valeur proposée : la sage-femme vérifie d'un coup d'œil au lieu de chercher sur la photo.

### C2. Rappel avant précision : `NEEDS_REVIEW` dans le doute

L2C : « une non-conformité manquée a plus de conséquences qu'une fausse alerte ». DayOne : « l'agent dit quand il doute ».

- **Existe** : `cellStatus` met `NEEDS_REVIEW` quand l'encre et le modèle se contredisent. `LOW_QUALITY` fait passer les champs `KNOWN` à `NEEDS_REVIEW` (étape 10), et la calibration fait de même via `low_category_confidence` (étape 13).
- **Proposition** : les mêmes conséquences pour trois nouveaux cas :
  - erreur de recalage élevée (A2) ;
  - labels lus par OCR qui ne correspondent pas aux `label_fr` attendus autour de la cellule (A1/A2) ;
  - cellule traversée par un trait (A4) ou encre qui déborde fortement de la cellule (B1).

  Le signal `confidence_signals.quality` reçoit la qualité de recalage, à recalibrer ensuite (`make calibrate`, le `pipeline_hash` change).

## Écarté pour l'instant

| Techno | Pourquoi |
| --- | --- |
| YOLO / Detectron2 | Il faudrait des données annotées. La géométrie du gabarit et l'encre suffisent, et les cases à cocher sont déjà à 1.00 sur les rendus. |
| PaddleOCR / Tesseract pour le manuscrit | Faibles sur le manuscrit français. Tesseract ne sert qu'à l'imprimé (A1, A2). |
| PyMuPDF / pdfplumber | Déjà utilisés hors ligne (`extract_pdf.py`). Au moment de l'analyse, on n'a qu'une image. |
| Pydantic | Doublon de zod (`packages/schema`). |
| ReportLab / WeasyPrint, Streamlit / Gradio | Hors sujet pour la détection. La PWA couvre l'interface. |

## Ordre suggéré

1. **A3** (encre par couleur) : petit changement, gain direct sur photos, mesurable avec `ink-eval`.
2. **A2** (page unique d'un livret ouvert + recalage fin + erreur de recalage), puis **C2**, qui en découle.
3. **C1** (`bbox_frac` + affichage du crop dans la PWA).
4. **A1** (vérification du type de page par OCR).
5. **B1**, puis **A4**, **B2** et **B3**, chacun mesuré avec `make eval` (exactitude et temps).

// Lebenslauf-PDF im Browser zu Text machen. Die Datei verlässt das Gerät erst beim Speichern.

export const CV_MAX_BYTES = 5 * 1024 * 1024;
export const CV_MAX_TEXT = 30_000;

export type CvResult = { text: string; seiten: number; warnung: string | null };

export function cleanCvText(raw: string): string {
  return raw
    .replaceAll('\u0000', '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, CV_MAX_TEXT);
}

export function checkCvFile(file: File): string | null {
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return 'Bitte lade eine PDF-Datei hoch.';
  if (file.size > CV_MAX_BYTES) return 'Die Datei ist größer als 5 MB. Bitte speichere sie kleiner.';
  if (file.size < 500) return 'Die Datei ist leer oder beschädigt.';
  return null;
}

export async function readCv(file: File): Promise<CvResult> {
  const pdfjs = await import('pdfjs-dist');
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const teile: string[] = [];
  for (let n = 1; n <= Math.min(pdf.numPages, 8); n++) {
    const page = await pdf.getPage(n);
    const inhalt = await page.getTextContent();
    let letzteY: number | null = null;
    let zeile = '';
    for (const item of inhalt.items as { str: string; transform: number[]; hasEOL?: boolean }[]) {
      const y = Math.round(item.transform[5]);
      if (letzteY !== null && Math.abs(y - letzteY) > 2) {
        teile.push(zeile);
        zeile = '';
      }
      zeile += (zeile && !zeile.endsWith(' ') ? ' ' : '') + item.str;
      letzteY = y;
      if (item.hasEOL) {
        teile.push(zeile);
        zeile = '';
        letzteY = null;
      }
    }
    if (zeile) teile.push(zeile);
    teile.push('');
  }
  const text = cleanCvText(teile.join('\n'));
  let warnung: string | null = null;
  if (text.length < 200) warnung = 'Aus dieser PDF ließ sich kaum Text lesen, vermutlich ist sie eingescannt. Füge den Text unten selbst ein.';
  else if (pdf.numPages > 8) warnung = 'Nur die ersten 8 Seiten wurden gelesen.';
  return { text, seiten: pdf.numPages, warnung };
}

// Anschreiben als PDF und DOCX, direkt im Browser. Nichts verlässt das Gerät.
import { fileName } from './logic';

export type LetterInput = { text: string; name: string; email?: string | null; phone?: string | null; company: string; title: string };

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function absender(i: LetterInput): string[] {
  return [i.name, [i.email, i.phone].filter(Boolean).join(' · ')].filter((z) => z && z.trim());
}

function heute(): string {
  return new Intl.DateTimeFormat('de-AT', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Europe/Vienna' }).format(new Date());
}

/** Text in Absätze teilen: Leerzeile trennt Absätze, einfache Zeilenumbrüche bleiben. */
export function paragraphs(text: string): string[][] {
  return text.replace(/\r/g, '').split(/\n{2,}/).map((p) => p.split('\n').map((z) => z.trimEnd())).filter((p) => p.some((z) => z.trim()));
}

export async function letterPdf(i: LetterInput): Promise<{ blob: Blob; name: string; seiten: number }> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const titel = fileName('Anschreiben', i.name, i.company);
  doc.setProperties({ title: titel, subject: `Bewerbung als ${i.title}`, author: i.name, creator: 'Jobbster' });
  const links = 25, rechts = 20, breite = 210 - links - rechts;
  let y = 25;
  const zeile = (text: string, groesse: number, stil: 'normal' | 'bold' = 'normal', abstand = 5.2) => {
    doc.setFont('helvetica', stil);
    doc.setFontSize(groesse);
    for (const teil of doc.splitTextToSize(text, breite) as string[]) {
      if (y > 280) { doc.addPage(); y = 25; }
      doc.text(teil, links, y);
      y += abstand;
    }
  };
  for (const [n, z] of absender(i).entries()) zeile(z, n === 0 ? 12 : 9.5, n === 0 ? 'bold' : 'normal', n === 0 ? 5.5 : 4.6);
  y += 8;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(heute(), 210 - rechts, y, { align: 'right' });
  y += 10;
  for (const absatz of paragraphs(i.text)) {
    for (const z of absatz) zeile(z, 10.5);
    y += 3;
  }
  return { blob: doc.output('blob'), name: `${titel}.pdf`, seiten: doc.getNumberOfPages() };
}

export async function letterDocx(i: LetterInput): Promise<{ blob: Blob; name: string }> {
  const { Document, Packer, Paragraph, TextRun, AlignmentType } = await import('docx');
  const titel = fileName('Anschreiben', i.name, i.company);
  const kinder = [
    ...absender(i).map((z, n) => new Paragraph({ children: [new TextRun({ text: z, bold: n === 0, size: n === 0 ? 24 : 19 })] })),
    new Paragraph({ text: '' }),
    new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: heute(), size: 20 })] }),
    new Paragraph({ text: '' }),
    ...paragraphs(i.text).map((absatz) => new Paragraph({
      spacing: { after: 160 },
      children: absatz.flatMap((z, n) => [new TextRun({ text: z, size: 21, break: n > 0 ? 1 : 0 })]),
    })),
  ];
  const doc = new Document({
    creator: 'Jobbster', title: titel, description: `Bewerbung als ${i.title}`,
    styles: { default: { document: { run: { font: 'Arial' } } } },
    sections: [{ properties: { page: { margin: { top: 1418, bottom: 1134, left: 1418, right: 1134 } } }, children: kinder }],
  });
  return { blob: await Packer.toBlob(doc), name: `${titel}.docx` };
}

/** In die Zwischenablage, mit Rückfall auf Markieren. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = document.createElement('textarea');
    t.value = text;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    t.remove();
    return ok;
  }
}

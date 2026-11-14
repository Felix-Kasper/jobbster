// Jobbster · Ende-zu-Ende-Test: echter Browser gegen das nachgebildete Backend, Handy und Laptop.
// Start: npm run e2e (baut die App mit der Test-Adresse und prüft die Hauptabläufe). Nur erfundene Daten.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// Playwright ist auf dem Rechner global installiert (nicht in package.json), deshalb über require
const { chromium, devices } = createRequire(import.meta.url)('playwright');
import { jsPDF } from 'jspdf';
import { createMock } from './mock-backend.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4799;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.join(ROOT, 'test', 'out');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

execSync('npx vite build --outDir dist-test --emptyOutDir', { cwd: ROOT, stdio: 'ignore', env: { ...process.env, VITE_SUPABASE_URL: BASE, VITE_SUPABASE_KEY: 'test-key' } });

// Erfundener Lebenslauf als echte PDF
const doc = new jsPDF();
const zeilen = ['Lena Beispiel', 'Wirtschaftsingenieurwesen Maschinenbau, TU Graz, Abschluss Februar 2027', '', 'Praktikum Qualitätsmanagement, 6 Monate: 8D-Reports,', 'Reklamationsquote um 18 % gesenkt',
  'Werkstudentin Produktionsplanung, 12 Monate: SAP PP, Power BI', 'Formula Student: Teilprojektleitung Fahrwerk mit 5 Personen', '', 'Sprachen: Deutsch Muttersprache, Englisch C1', 'Kenntnisse: SAP PP, Power BI, Python, SolidWorks,', 'Lean, Six Sigma Yellow Belt'];
zeilen.forEach((z, i) => doc.text(z, 15, 20 + i * 8));
const CV = path.join(OUT, 'lebenslauf.pdf');
fs.writeFileSync(CV, Buffer.from(doc.output('arraybuffer')));

const { server, db } = createMock({ dist: path.join(ROOT, 'dist-test') });
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const browser = await chromium.launch();
let bestanden = 0;
const ok = (name) => { bestanden++; console.log(`  ok  ${name}`); };

async function lauf(name, kontext, email) {
  console.log(`\n${name}`);
  const ctx = await browser.newContext({ ...kontext, acceptDownloads: true, locale: 'de-AT', timezoneId: 'Europe/Vienna' });
  const page = await ctx.newPage();
  const fehler = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fehler.push(m.text()); });
  page.on('pageerror', (e) => fehler.push(e.message));
  const breiteOk = async (wo) => {
    const r = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const zu = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > w + 1 && !e.closest('.seg, .table-wrap')).slice(0, 3).map((e) => `${e.tagName}.${e.className}`);
      return { ueber: document.documentElement.scrollWidth - w, zu };
    });
    assert.ok(r.ueber <= 1, `${wo}: Seite ist ${r.ueber}px zu breit (${r.zu.join(', ')})`);
  };

  // 1. Ohne Anmeldung landet man beim Login
  await page.goto(`${BASE}/treffer`);
  await page.waitForURL('**/anmelden');
  ok('ohne Anmeldung: Weiterleitung zum Login');
  await page.screenshot({ path: path.join(OUT, `${name}-anmelden.png`) });

  // 2. Registrieren mit Code
  await page.getByRole('link', { name: 'Registrieren' }).click();
  await page.locator('#reg-email').fill(email);
  await page.locator('#reg-pw').fill('kurz');
  await page.getByRole('button', { name: 'Konto anlegen' }).click();
  await page.getByText('mindestens 10 Zeichen', { exact: false }).first().waitFor();
  await page.locator('#reg-pw').fill('Ein-sicheres-Testpasswort-1');
  await page.locator('#reg-code').fill('falscher-code-123');
  await page.locator('#reg-ok').check();
  await page.getByRole('button', { name: 'Konto anlegen' }).click();
  await page.getByText('Dieser Code gilt nicht').waitFor();
  await page.locator('#reg-code').fill('zs-test-0000-0000-0001');
  await page.getByRole('button', { name: 'Konto anlegen' }).click();
  await page.waitForURL('**/start');
  ok('Registrierung: zu kurzes Passwort und falscher Code werden erklärt, gültiger Code führt zum Start');
  await breiteOk('Start');

  // 3. Fragebogen mit Lebenslauf
  await page.getByRole('button', { name: 'Weiter' }).click();
  await page.getByText('Lade deinen Lebenslauf hoch').waitFor();
  await page.locator('#cv-datei').setInputFiles(CV);
  await page.getByText(/Gelesen: 1 Seite/).waitFor({ timeout: 20000 });
  const cv = await page.locator('#cv-text').inputValue();
  assert.match(cv, /Reklamationsquote um 18 % gesenkt/);
  ok('Lebenslauf-PDF wird im Browser gelesen');
  await page.screenshot({ path: path.join(OUT, `${name}-start.png`) });
  await page.getByRole('button', { name: 'Weiter' }).click();
  await page.locator('#p-name').fill('Lena Beispiel');
  await page.locator('#p-spr').fill('Deutsch Muttersprache, Englisch C1');
  await page.getByRole('button', { name: 'Weiter' }).click();
  await page.getByRole('button', { name: 'Weiter' }).click();
  await page.getByText('Noch offen: Zielrollen, Orte, Start.').waitFor();
  await page.locator('#s-traumjob').fill('Ich will als Trainee in der Qualität eines Industriebetriebs anfangen, am liebsten in Graz oder Linz, ab März. Kein Außendienst.');
  await page.locator('#s-vorschlag').click();
  await page.getByText('Felder ausgefüllt. Prüf sie kurz').waitFor();
  assert.match(await page.locator('#s-rollen').inputValue(), /Trainee Qualitätsmanagement/);
  assert.equal(await page.locator('#s-orte').inputValue(), 'Graz, Linz');
  assert.equal(await page.locator('#s-start').inputValue(), 'ab März 2027');
  ok('„Beschreib deinen perfekten Job“ füllt die Suchfelder aus');
  await page.locator('#s-rollen').fill('Trainee Qualitätsmanagement, Junior Produktionsplanung');
  await page.locator('#s-orte').fill('Graz, Linz, München');
  await page.locator('#s-start').fill('ab März 2027');
  assert.equal(await page.locator('#s-pro-tag').inputValue(), '10', 'Empfohlen sind 10 pro Tag');
  await page.locator('#s-pro-tag').fill('12');
  await page.getByRole('button', { name: 'Weiter' }).click();
  await page.locator('#f-eng').fill('Formula Student, Teilprojektleitung Fahrwerk');
  await page.getByRole('button', { name: 'Weiter' }).click();
  const profil = db.job_profile.find((p) => p.full_name === 'Lena Beispiel');
  assert.ok(profil, 'Profil wurde zwischengespeichert');
  assert.deepEqual(profil.preferences.orte, ['Graz', 'Linz', 'München']);
  assert.equal(profil.preferences.pro_tag, 12, 'Bewerbungen pro Tag gespeichert');
  assert.match(profil.preferences.traumjob, /Trainee in der Qualität/, 'Perfekter Job gespeichert');
  assert.ok([...db.files.keys()].some((k) => k.startsWith('cvs/') && k.endsWith('/lebenslauf.pdf')), 'PDF liegt im Speicher');
  ok('Fragebogen: Pflichtangaben werden geprüft, jeder Schritt wird gespeichert, Bewerbungen pro Tag einstellbar, PDF liegt im eigenen Ordner');
  await page.getByRole('button', { name: 'Erste Suche starten' }).click();
  await page.waitForURL('**/treffer');
  await page.getByText('Der erste Suchlauf läuft').waitFor();
  ok('Abschluss startet den ersten Suchlauf');
  await page.screenshot({ path: path.join(OUT, `${name}-treffer.png`), fullPage: true });
  await breiteOk('Treffer');

  // 4. Treffer öffnen, Entwurf schreiben lassen
  await page.getByRole('button', { name: /^Neu/ }).click();
  await page.getByText('Trainee Qualitätsmanagement').click();
  await page.getByRole('dialog').waitFor();
  await page.getByText('Passt zum Praktikum. Chance: hoch.').waitFor();
  await page.getByRole('button', { name: 'Entwurf schreiben' }).click();
  await page.getByText('Der Entwurf ist fertig').waitFor();
  await page.getByText('Reklamationsquote um 18 % gesenkt', { exact: false }).first().waitFor();
  ok('Entwurf auf Knopfdruck, sofort sichtbar');
  await page.screenshot({ path: path.join(OUT, `${name}-entwurf.png`) });

  // 5. PDF und Word
  let dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'PDF' }).click();
  let d = await dl;
  assert.match(d.suggestedFilename(), /^Anschreiben Lena Beispiel Beispielwerk GmbH\.pdf$/);
  const pdf = fs.readFileSync(await d.path());
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Word' }).click();
  d = await dl;
  assert.match(d.suggestedFilename(), /\.docx$/);
  const docx = fs.readFileSync(await d.path());
  assert.equal(docx.subarray(0, 2).toString(), 'PK');
  ok('Anschreiben als PDF und als Word-Datei');

  // 6. Beworben, Einladung, Vorbereitung
  await page.getByRole('button', { name: 'Beworben', exact: true }).click();
  await page.getByText('Als beworben markiert.').waitFor();
  await page.getByRole('button', { name: 'Einladung erhalten' }).click();
  await page.locator('#iv-mail').fill('Wir laden Sie am 26.11. um 10 Uhr zu einem Videogespräch mit Frau Muster (HR) ein.');
  await page.locator('#iv-wann').fill('2026-11-26T10:00');
  await page.locator('#iv-format').selectOption('video');
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  await page.getByText('Fordere jetzt die Vorbereitung an').waitFor();
  await page.getByRole('button', { name: 'Vorbereitung anfordern' }).click();
  await page.getByText('Die Vorbereitung ist angefordert').waitFor();
  const lead = db.job_leads.find((l) => l.company === 'Beispielwerk GmbH');
  assert.equal(lead.status, 'interview');
  assert.ok(lead.applied_at && lead.next_at && lead.prep_requested_at);
  ok('Funnel: beworben, Einladung mit Termin, Vorbereitung angefordert');
  await page.getByRole('button', { name: 'Schließen' }).click();
  await page.getByRole('button', { name: /^Gespräche/ }).click();
  await page.getByText('Trainee Qualitätsmanagement').waitFor();

  // 7. Verwerfen mit Grund
  await page.getByRole('button', { name: /^Neu/ }).click();
  await page.getByText('Junior Produktionsplanerin').click();
  await page.getByRole('button', { name: 'Passt nicht' }).click();
  await page.locator('#grund').fill('Zu viel Schichtarbeit');
  await page.getByRole('button', { name: 'Verwerfen' }).click();
  await page.getByText('Verworfen. Die Suche lernt daraus.').waitFor();
  assert.equal(db.job_leads.find((l) => l.company === 'Muster AG').archive_reason, 'Zu viel Schichtarbeit');
  await page.keyboard.press('Escape');
  ok('Verwerfen mit Grund, Blatt schließt mit Escape');

  // 8. Konto
  await page.goto(`${BASE}/konto`);
  await page.getByText('Beta', { exact: true }).waitFor();
  await page.getByRole('button', { name: /gratis testen|Abo starten/ }).click();
  await page.getByText('Die Bezahlung ist noch nicht freigeschaltet').waitFor();
  await page.locator('#k-code-feld').fill('ZS-GIBT-ESNI-CHT0-0000');
  await page.getByRole('button', { name: 'Einlösen' }).click();
  await page.getByText('Dieser Code gilt nicht oder wurde schon eingelöst.').waitFor();
  await page.locator('#k-code-feld').fill('zs-pass-0000-0000-0002');
  await page.getByRole('button', { name: 'Einlösen' }).click();
  await page.getByText(/Eingelöst\. Dein Zugang läuft jetzt bis/).waitFor();
  ok('Konto: Bezahlung meldet ehrlich „nicht freigeschaltet“, Code einlösen verlängert');
  dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Alle Daten exportieren' }).click();
  d = await dl;
  const daten = JSON.parse(fs.readFileSync(await d.path(), 'utf8'));
  assert.equal(daten.konto.email, email);
  assert.equal(daten.treffer.length, 2);
  assert.equal(daten.profil.full_name, 'Lena Beispiel');
  ok('Datenexport enthält Konto, Profil und Treffer');
  await page.locator('#k-fb-feld').fill('Test-Rückmeldung');
  await page.getByRole('button', { name: 'Senden' }).click();
  await page.getByText('Danke, angekommen.').waitFor();
  await breiteOk('Konto');
  await page.screenshot({ path: path.join(OUT, `${name}-konto.png`), fullPage: true });

  // 9. Admin ist gesperrt
  await page.goto(`${BASE}/admin`);
  await page.waitForURL('**/treffer');
  ok('Admin-Bereich für normale Nutzer gesperrt');

  // 10. Profil bearbeiten
  await page.goto(`${BASE}/profil`);
  await page.locator('#s-start').fill('ab April 2027');
  await page.getByRole('button', { name: 'Speichern' }).first().click();
  await page.getByText('Gespeichert. Der nächste Suchlauf nutzt die neuen Angaben.').waitFor();
  assert.equal(db.job_profile.find((p) => p.full_name === 'Lena Beispiel').preferences.start, 'ab April 2027');
  ok('Profil ändern und speichern');

  // 11. Konto löschen
  await page.goto(`${BASE}/konto`);
  await page.locator('#k-loeschen').fill('löschen');
  await page.getByRole('button', { name: 'Endgültig löschen' }).click();
  await page.getByText('Tipp LÖSCHEN in Großbuchstaben ein.').waitFor();
  await page.locator('#k-loeschen').fill('LÖSCHEN');
  await page.getByRole('button', { name: 'Endgültig löschen' }).click();
  await page.waitForURL('**/anmelden');
  assert.ok(!db.users.some((u) => u.email === email));
  assert.ok(!db.job_leads.some((l) => l.user_id === profil.user_id));
  ok('Konto löschen mit Bestätigung, Daten weg');

  // 12. Erneut anmelden geht nicht mehr
  await page.locator('#login-email').fill(email);
  await page.locator('#login-pw').fill('Ein-sicheres-Testpasswort-1');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await page.getByText('E-Mail oder Passwort stimmt nicht.').waitFor();
  ok('Gelöschtes Konto kann sich nicht anmelden');

  for (const [pfad, titel] of [['/impressum', 'Impressum'], ['/datenschutz', 'Datenschutz'], ['/bedingungen', 'Bedingungen']]) {
    await page.goto(`${BASE}${pfad}`);
    await page.getByRole('heading', { name: titel, level: 1 }).waitFor();
    if (titel === 'Impressum') await page.getByText('fehlt noch: Anschrift').waitFor();
  }
  await breiteOk('Rechtliches');
  ok('Impressum, Datenschutz und Bedingungen erreichbar, fehlende Pflichtangaben sichtbar markiert');

  assert.deepEqual(fehler, [], `Fehler in der Konsole: ${fehler.join(' | ')}`);
  ok('keine Fehler in der Konsole');
  await ctx.close();
}

try {
  await lauf('handy', { ...devices['iPhone 13'] }, 'lena.handy@test.example');
  await lauf('laptop', { viewport: { width: 1440, height: 900 } }, 'lena.laptop@test.example');
  console.log(`\n${bestanden} Prüfungen bestanden.`);
} catch (e) {
  console.log(`\nFEHLGESCHLAGEN: ${e.message}\nProtokoll: ${db.log.slice(-15).join(' | ')}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}

// Jobbster · Rauchtest gegen die veröffentlichte Seite. Schreibt nichts, meldet sich nirgends an.
// Start: node test/live.mjs https://felix-kasper.github.io/jobbster
import { createRequire } from 'node:module';
const { chromium, devices } = createRequire(import.meta.url)('playwright');

const ziel = (process.argv[2] || '').replace(/\/$/, '');
if (!ziel) throw new Error('Adresse fehlt');
const browser = await chromium.launch();
let fehler = 0;
const pruefe = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e) { fehler++; console.log(`  FEHLER  ${name}: ${e.message}`); }
};

for (const [geraet, optionen] of [['Laptop', { viewport: { width: 1280, height: 800 } }], ['Handy', devices['iPhone 13']]]) {
  console.log(`\n${geraet}`);
  const seite = await (await browser.newContext(optionen)).newPage();
  const probleme = [];
  seite.on('pageerror', (e) => probleme.push(e.message));
  seite.on('console', (m) => m.type() === 'error' && !/Failed to load resource.*404/.test(m.text()) && probleme.push(m.text()));

  await pruefe('Landingpage lädt mit Titel und „Gratis testen“', async () => {
    await seite.goto(`${ziel}/`, { waitUntil: 'networkidle' });
    if (!/Jobbster/.test(await seite.title())) throw new Error(`Titel: ${await seite.title()}`);
    await seite.getByRole('link', { name: 'Gratis testen' }).first().waitFor({ timeout: 5000 });
  });
  await pruefe('„Anmelden“ führt in die App', async () => {
    await seite.goto(`${ziel}/`, { waitUntil: 'networkidle' });
    const link = seite.locator('a[href="app/anmelden"]').first();
    if (await link.isVisible()) await link.click(); else await seite.goto(`${ziel}/app/anmelden`);
    await seite.waitForURL(/\/app\/anmelden$/, { timeout: 10000 });
    await seite.getByText('Willkommen zurück.').waitFor({ timeout: 10000 });
  });
  await pruefe('Tiefer Link /app/registrieren zeigt das Formular', async () => {
    await seite.goto(`${ziel}/app/registrieren`, { waitUntil: 'networkidle' });
    await seite.getByLabel(/Einladungscode|Code/).first().waitFor({ timeout: 10000 });
  });
  await pruefe('Impressum erreichbar', async () => {
    await seite.goto(`${ziel}/app/impressum`, { waitUntil: 'networkidle' });
    await seite.getByRole('heading', { name: /Impressum/ }).first().waitFor({ timeout: 10000 });
  });
  await pruefe('Anmeldung mit falschem Passwort zeigt eine verständliche Meldung (Supabase erreichbar)', async () => {
    await seite.goto(`${ziel}/app/anmelden`, { waitUntil: 'networkidle' });
    await seite.getByLabel('E-Mail-Adresse').fill('rauchtest@jobbster.invalid');
    await seite.getByLabel('Passwort').fill('falsches-passwort-123');
    await seite.getByRole('button', { name: 'Anmelden' }).click();
    await seite.getByRole('alert').or(seite.locator('[role=status], .fehler, .meldung')).first().waitFor({ timeout: 10000 });
  });
  await pruefe('keine Fehler im Browser', async () => {
    const echt = probleme.filter((p) => !/400|Invalid login credentials/i.test(p));
    if (echt.length) throw new Error(echt.slice(0, 3).join(' | '));
  });
}
// Der ganze Weg eines neuen Nutzers, ohne KI-Kosten: Registrieren, Fragebogen mit echtem PDF, Treffer-Seite,
// abmelden, wieder anmelden, Konto löschen. Der Code unten gilt nur für Adressen auf @jobbster.invalid (geprüft in signup).
const RAUCHTEST_CODE = 'ZS-FCA8-93EE-8FE5-206E';
{
  console.log('\nNeuer Nutzer, von der Registrierung bis zur App');
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();
  ['Rauch Test', 'Bachelor Betriebswirtschaft, Abschluss Februar 2027', 'Praktikum Controlling, 6 Monate: Reporting in Power BI'].forEach((z, i) => doc.text(z, 15, 20 + i * 8));
  const cv = (await import('node:path')).join((await import('node:os')).tmpdir(), 'rauchtest-lebenslauf.pdf');
  (await import('node:fs')).writeFileSync(cv, Buffer.from(doc.output('arraybuffer')));

  const email = `rauchtest-${Date.now()}@jobbster.invalid`;
  const pw = `Rauchtest-${Math.random().toString(36).slice(2)}-Aa1`;
  const seite = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const probleme = [];
  seite.on('pageerror', (e) => probleme.push(e.message));
  seite.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log(`    Browser ${m.type()}: ${m.text().slice(0, 300)}`));
  seite.on('requestfailed', (r) => console.log(`    Abruf fehlgeschlagen: ${r.url().slice(0, 150)} (${r.failure()?.errorText})`));
  seite.on('response', (r) => /pdf\.worker/.test(r.url()) && console.log(`    PDF-Worker: ${r.status()} ${r.headers()['content-type']} ${r.url().split('/').pop()}`));
  let angelegt = false;
  try {
    await pruefe('Registrieren mit Einladungscode führt zum Fragebogen', async () => {
      await seite.goto(`${ziel}/app/registrieren`, { waitUntil: 'networkidle' });
      await seite.locator('#reg-email').fill(email);
      await seite.locator('#reg-pw').fill(pw);
      await seite.locator('#reg-code').fill(RAUCHTEST_CODE);
      await seite.locator('#reg-ok').check();
      await seite.getByRole('button', { name: 'Konto anlegen' }).click();
      await seite.waitForURL('**/start', { timeout: 20000 });
      angelegt = true;
    });
    await pruefe('Fragebogen: Lebenslauf-PDF wird gelesen, alle Schritte gehen durch', async () => {
      try {
      await seite.getByRole('button', { name: 'Weiter' }).click();
      await seite.locator('#cv-datei').setInputFiles(cv);
      await seite.getByText(/Gelesen: 1 Seite/).waitFor({ timeout: 20000 });
      await seite.getByRole('button', { name: 'Weiter' }).click();
      await seite.locator('#p-name').fill('Rauch Test');
      await seite.locator('#p-spr').fill('Deutsch Muttersprache');
      await seite.getByRole('button', { name: 'Weiter' }).click();
      await seite.getByRole('button', { name: 'Weiter' }).click();
      // ohne „Felder daraus ausfüllen“: kein KI-Aufruf
      await seite.locator('#s-rollen').fill('Junior Controller');
      await seite.locator('#s-orte').fill('Innsbruck');
      await seite.locator('#s-start').fill('ab März 2027');
      await seite.getByRole('button', { name: 'Weiter' }).click();
      await seite.getByRole('button', { name: 'Weiter' }).click();
      await seite.getByRole('button', { name: 'Erste Suche starten' }).waitFor({ timeout: 10000 });
      } catch (e) {
        await seite.screenshot({ path: 'rauchtest-fragebogen.png', fullPage: true });
        console.log(`    Sichtbar: ${(await seite.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 600)}`);
        throw e;
      }
    });
    await pruefe('Abschluss führt in die App, die erste Suche ist angemeldet', async () => {
      await seite.getByRole('button', { name: 'Erste Suche starten' }).click();
      await seite.waitForURL('**/treffer', { timeout: 20000 });
      await seite.getByText('Der erste Suchlauf läuft').waitFor({ timeout: 10000 });
    });
    await pruefe('Abmelden und wieder anmelden', async () => {
      await seite.goto(`${ziel}/app/konto`, { waitUntil: 'networkidle' });
      await seite.getByRole('button', { name: 'Abmelden' }).first().click();
      await seite.waitForURL('**/anmelden', { timeout: 10000 });
      await seite.getByLabel('E-Mail-Adresse').fill(email);
      await seite.getByLabel('Passwort').fill(pw);
      await seite.getByRole('button', { name: 'Anmelden' }).click();
      await seite.waitForURL(/\/app\/(treffer|start)$/, { timeout: 20000 });
    });
  } finally {
    if (angelegt) {
      await pruefe('Konto löschen entfernt alles', async () => {
        await seite.goto(`${ziel}/app/konto`, { waitUntil: 'networkidle' });
        await seite.locator('#k-loeschen').fill('LÖSCHEN');
        await seite.getByRole('button', { name: 'Endgültig löschen' }).click();
        await seite.waitForURL('**/anmelden', { timeout: 20000 });
        await seite.getByLabel('E-Mail-Adresse').fill(email);
        await seite.getByLabel('Passwort').fill(pw);
        await seite.getByRole('button', { name: 'Anmelden' }).click();
        await seite.getByRole('alert').first().waitFor({ timeout: 10000 });
      });
    }
  }
  await pruefe('keine Fehler im Browser', async () => {
    if (probleme.length) throw new Error(probleme.slice(0, 3).join(' | '));
  });
}

await browser.close();
console.log(fehler ? `\n${fehler} Prüfungen fehlgeschlagen.` : '\nAlle Prüfungen bestanden.');
process.exitCode = fehler ? 1 : 0;

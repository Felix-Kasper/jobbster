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
    await seite.getByRole('heading', { name: /Willkommen zurück/ }).waitFor({ timeout: 10000 });
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
await browser.close();
console.log(fehler ? `\n${fehler} Prüfungen fehlgeschlagen.` : '\nAlle Prüfungen bestanden.');
process.exitCode = fehler ? 1 : 0;

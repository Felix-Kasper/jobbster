import { Link, NavLink, useLocation } from 'react-router-dom';
import { Marke } from '../App';
import { IMPRESSUM, LEGAL_VERSION, SUPPORT_EMAIL } from '../lib/config';

// ENTWURF von Claude, kein Rechtsrat. Vor dem ersten zahlenden Nutzer von WKO oder Anwalt prüfen lassen.
// Fehlen Pflichtangaben (Impressum), zeigt die Seite deutlich, dass sie fehlen, statt etwas zu erfinden.

function Fehlt({ was }: { was: string }) {
  return <span className="pill orange">fehlt noch: {was}</span>;
}

function Impressum() {
  const i = IMPRESSUM;
  return (
    <>
      <h1>Impressum</h1>
      <dl className="kv">
        <dt>Anbieter</dt><dd>{i.name ?? <Fehlt was="Name" />}</dd>
        <dt>Anschrift</dt><dd>{i.anschrift ?? <Fehlt was="Anschrift" />}</dd>
        <dt>E-Mail</dt><dd>{i.email ?? <Fehlt was="E-Mail" />}</dd>
        <dt>Gewerbe</dt><dd>{i.gewerbe ?? <Fehlt was="Gewerbewortlaut" />}</dd>
        <dt>Behörde</dt><dd>{i.behoerde ?? <Fehlt was="Gewerbebehörde" />}</dd>
        <dt>Kammer</dt><dd>{i.kammer ?? <Fehlt was="Kammer" />}</dd>
        {i.uid && <><dt>UID</dt><dd>{i.uid}</dd></>}
      </dl>
      <p className="muted">Umsatzsteuerbefreit als Kleinunternehmer, sofern zutreffend. Plattform der EU zur Online-Streitbeilegung: ec.europa.eu/odr.</p>
    </>
  );
}

function Datenschutz() {
  return (
    <>
      <h1>Datenschutz</h1>
      <p className="muted small">Stand {LEGAL_VERSION}. Verantwortlich: siehe <Link to="/impressum">Impressum</Link>.</p>
      <h2>Welche Daten</h2>
      <p>Konto (E-Mail-Adresse, Passwort als Hash), dein Profil und dein Lebenslauf (PDF und Text), die Stellen, Entwürfe, Notizen und Gesprächstermine, die in Jobbster entstehen, deine Einwilligungen, Rückmeldungen und ein Protokoll der KI-Läufe (Dauer, Menge, Kosten, ohne Inhalte). Bei einem Abo: Kundennummer und Abo-Status bei Stripe. Kartendaten sieht Jobbster nie.</p>
      <h2>Wozu</h2>
      <p>Um für dich Stellen zu suchen und zu bewerten, Bewerbungsentwürfe und Gesprächsvorbereitungen zu schreiben und dein Abo abzurechnen. Rechtsgrundlage ist der Vertrag mit dir (Art. 6 Abs. 1 lit. b DSGVO). Die Verarbeitung deines Lebenslaufs durch die KI-Dienstleister erfolgt zusätzlich mit deiner Einwilligung bei der Registrierung (Art. 6 Abs. 1 lit. a, Art. 49 Abs. 1 lit. a DSGVO für die Übermittlung in die USA).</p>
      <h2>Dienstleister</h2>
      <ul className="bullets">
        <li>Supabase (Datenbank, Anmeldung, Dateien), Server in Frankfurt am Main.</li>
        <li>Anthropic PBC, USA (Claude API): verarbeitet Profil, Lebenslauf und Stellenanzeigen, um Texte zu erzeugen. Laut Anthropic werden Daten aus der API standardmäßig nicht zum Training verwendet.</li>
        <li>GitHub, USA (Ausführung der Suchläufe im Hintergrund, ohne dauerhafte Speicherung von Inhalten).</li>
        <li>Stripe, Irland und USA (Zahlung und Abo).</li>
        <li>Cloudflare (Auslieferung der Website).</li>
      </ul>
      <h2>Wie lange</h2>
      <p>Solange dein Konto besteht. Wenn du dein Konto löschst, werden Profil, Lebenslauf, Treffer, Entwürfe und Dateien sofort gelöscht. Rechnungsdaten bewahrt Stripe nach den gesetzlichen Fristen auf.</p>
      <h2>Deine Rechte</h2>
      <p>Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerruf deiner Einwilligung. Export und Löschung gehen direkt im Konto. Beschwerden an die Österreichische Datenschutzbehörde (dsb.gv.at).</p>
      {SUPPORT_EMAIL && <p>Fragen: {SUPPORT_EMAIL}</p>}
    </>
  );
}

function Bedingungen() {
  return (
    <>
      <h1>Bedingungen</h1>
      <p className="muted small">Stand {LEGAL_VERSION}.</p>
      <h2>Was Jobbster tut</h2>
      <p>Jobbster sucht öffentlich ausgeschriebene Stellen, bewertet sie und schreibt auf Anforderung Entwürfe für Bewerbungen und Gesprächsvorbereitungen, nur mit den Angaben aus deinem Profil. Jobbster sendet keine Bewerbungen und loggt sich nirgends ein. Du prüfst jeden Entwurf und sendest selbst. Eine Einladung oder Jobbster wird nicht versprochen.</p>
      <h2>Probe und Abo</h2>
      <p>Die ersten 7 Tage sind kostenlos und haben den vollen Umfang. Ohne Kündigung geht die Probe danach in ein Monatsabo über, das monatlich im Voraus abgerechnet wird. Den aktuellen Preis siehst du vor dem Abschluss. Du kannst jederzeit im Konto unter „Abo verwalten“ kündigen, die Kündigung gilt zum Ende des bezahlten Monats. Wer in der Probe kündigt, zahlt nichts.</p>
      <h2>Grenzen</h2>
      <p>Ein automatischer Suchlauf pro Tag mit so vielen Treffern wie im Profil eingestellt (1 bis 12), dazu ein Suchlauf von Hand. Pro Tag bis zu 12 Entwürfe, pro Woche bis zu 2 Gesprächsvorbereitungen. Bei Missbrauch oder Störungen kann Jobbster Läufe pausieren.</p>
      <h2>Rücktrittsrecht</h2>
      <p>Als Verbraucher kannst du binnen 14 Tagen ab Vertragsabschluss ohne Angabe von Gründen zurücktreten, zum Beispiel über „Abo verwalten“ oder per E-Mail{SUPPORT_EMAIL ? ` an ${SUPPORT_EMAIL}` : ''}. Hast du verlangt, dass die Leistung schon vor Ablauf der Frist beginnt, zahlst du für die bis dahin erbrachte Leistung anteilig. Jobbster erstattet in diesem Fall im Zweifel den vollen Betrag.</p>
      <h2>Deine Pflichten</h2>
      <p>Lade nur deinen eigenen Lebenslauf hoch und gib nur wahre Angaben an. Prüfe Entwürfe vor dem Absenden.</p>
      <h2>Haftung</h2>
      <p>KI-Texte können Fehler enthalten. Für Inhalte, die du absendest, bist du verantwortlich. Jobbster haftet nach den gesetzlichen Bestimmungen, bei leichter Fahrlässigkeit nur für die Verletzung wesentlicher Pflichten.</p>
      <p>Es gilt österreichisches Recht unter Ausschluss der Verweisungsnormen. Zwingender Verbraucherschutz deines Wohnsitzlandes bleibt unberührt.</p>
    </>
  );
}

export default function Legal() {
  const { pathname } = useLocation();
  const seite = pathname.startsWith('/datenschutz') ? <Datenschutz /> : pathname.startsWith('/bedingungen') ? <Bedingungen /> : <Impressum />;
  return (
    <main className="main legal">
      <nav className="legal-nav" aria-label="Rechtliches">
        <Marke to="/" />
        <span style={{ flex: 1 }} />
        {[['/impressum', 'Impressum'], ['/datenschutz', 'Datenschutz'], ['/bedingungen', 'Bedingungen']].map(([to, t]) => (
          <NavLink key={to} to={to}>{t}</NavLink>
        ))}
      </nav>
      <article className="stack fade-in" style={{ gap: 12 }}>{seite}</article>
    </main>
  );
}

import { describe, expect, it } from 'vitest';
import { accessOf, chanceOf, countByTab, daysUntil, fileName, mailtoFor, missingForSearch, parseOrte, proTag, reasonText, sortLeads, tabOf } from './logic';
import { cleanCvText } from './cv';
import { paragraphs } from './docs';
import type { Lead, Member } from './types';

const lead = (p: Partial<Lead>): Lead => ({
  id: Math.random().toString(36).slice(2), kind: 'stelle', source: null, company: 'Firma', title: 'Trainee', location: null, url: null, apply_channel: 'portal',
  apply_email: null, contact_name: null, posted_at: null, deadline: null, salary: null, language: 'de', match_score: 70, keywords: [], summary: null,
  requirements: null, why_fit: null, pre_info: null, status: 'neu', email_subject: null, email_body: null, cover_letter_md: null, cv_highlights: null,
  drafted_at: null, applied_at: null, notes: null, archive_reason: null, requested_at: null, next_at: null, stage_updated_at: null, interview1_input: null,
  interview1_prep: null, interview2_input: null, interview2_prep: null, prep_requested_at: null, created_at: '2026-11-10T08:00:00Z', updated_at: '2026-11-10T08:00:00Z', ...p,
});
const member = (p: Partial<Member>): Member => ({ user_id: 'u', plan: 'beta', status: 'aktiv', valid_until: null, limits: null, sub_status: null, cancel_at_period_end: false, trial_used: false, joined_at: '2026-11-01T00:00:00Z', ...p });
const NOW = Date.parse('2026-11-12T12:00:00Z');

describe('Reiter', () => {
  it('ordnet jeden Status genau einem Reiter zu, gelöschte keinem', () => {
    expect(tabOf({ status: 'entwurf' })).toBe('bereit');
    expect(tabOf({ status: 'interview2' })).toBe('gespraeche');
    expect(tabOf({ status: 'verworfen' })).toBe('archiv');
    expect(tabOf({ status: 'geloescht' })).toBeNull();
    expect(countByTab([lead({ status: 'neu' }), lead({ status: 'neu' }), lead({ status: 'vertrag' }), lead({ status: 'geloescht' })])).toEqual({ neu: 2, bereit: 0, beworben: 0, gespraeche: 1, archiv: 0 });
  });
  it('sortiert Neu: Frist zuerst, dann Match', () => {
    const a = lead({ company: 'A', match_score: 90 });
    const b = lead({ company: 'B', match_score: 60, deadline: '2026-11-20' });
    const c = lead({ company: 'C', match_score: 95 });
    expect(sortLeads([a, b, c], 'neu').map((l) => l.company)).toEqual(['B', 'C', 'A']);
  });
  it('sortiert Gespräche nach dem nächsten Termin, ohne Termin ans Ende', () => {
    const a = lead({ company: 'A', status: 'interview' });
    const b = lead({ company: 'B', status: 'interview', next_at: '2026-11-20T09:00:00Z' });
    const c = lead({ company: 'C', status: 'interview', next_at: '2026-11-15T09:00:00Z' });
    expect(sortLeads([a, b, c], 'gespraeche').map((l) => l.company)).toEqual(['C', 'B', 'A']);
  });
});

describe('Texte', () => {
  it('liest die Chance aus why_fit', () => {
    expect(chanceOf('Passt gut. Chance: hoch. Einsteiger gesucht.')).toBe('hoch');
    expect(chanceOf('Chance: Niedrig, C1 fehlt')).toBe('niedrig');
    expect(chanceOf(null)).toBeNull();
  });
  it('erklärt jeden Grund aus request_run verständlich', () => {
    for (const g of ['nicht_angemeldet', 'kein_zugang', 'abgelaufen', 'pausiert', 'profil_fehlt', 'treffer_fehlt', 'laeuft_schon', 'nicht_im_paket']) {
      expect(reasonText(g)).not.toMatch(/nicht geklappt/);
    }
    expect(reasonText('limit', '2026-11-13T05:30:00Z', 3)).toMatch(/Grenze erreicht \(3 im Zeitraum\)\. Wieder möglich ab 13\.11\./);
    expect(reasonText('irgendwas')).toMatch(/nicht geklappt/);
  });
  it('enthält keinen Gedankenstrich', () => {
    const alle = ['nicht_angemeldet', 'kein_zugang', 'abgelaufen', 'limit'].map((g) => reasonText(g)).join(' ');
    expect(alle).not.toMatch(/[–—]/);
  });
});

describe('Zugang', () => {
  it('Probe mit Abo, noch nicht gekündigt', () => {
    const a = accessOf(member({ plan: 'abo', sub_status: 'trialing', valid_until: '2026-11-19T12:00:00Z' }), NOW);
    expect(a.aktiv).toBe(true);
    expect(a.text).toMatch(/19\.11\.2026 beginnt das Abo/);
  });
  it('Abo gekündigt läuft bis zum Ende der Periode', () => {
    const a = accessOf(member({ plan: 'abo', sub_status: 'active', cancel_at_period_end: true, valid_until: '2026-12-01T00:00:00Z' }), NOW);
    expect(a.aktiv).toBe(true);
    expect(a.titel).toBe('Abo gekündigt');
  });
  it('abgelaufener Code ohne Probe bietet die Probe an, nach der Probe das Abo', () => {
    expect(accessOf(member({ plan: 'beta', valid_until: '2026-11-01T00:00:00Z' }), NOW)).toMatchObject({ aktiv: false, aktion: 'probe' });
    expect(accessOf(member({ plan: 'beta', valid_until: '2026-11-01T00:00:00Z', trial_used: true }), NOW)).toMatchObject({ aktiv: false, aktion: 'abo' });
  });
  it('neues Konto ohne Start ist nicht aktiv', () => {
    expect(accessOf(member({ plan: 'neu', valid_until: '2026-11-12T11:00:00Z' }), NOW).aktiv).toBe(false);
    expect(accessOf(null, NOW).aktiv).toBe(false);
  });
  it('offene Zahlung wird gemeldet', () => {
    expect(accessOf(member({ plan: 'abo', sub_status: 'past_due', valid_until: '2026-11-14T00:00:00Z' }), NOW).aktion).toBe('zahlung');
  });
});

describe('Profil und Hilfen', () => {
  it('meldet fehlende Angaben für den ersten Suchlauf', () => {
    expect(missingForSearch({ cv_text: 'x'.repeat(250), full_name: 'Lena', preferences: { zielrollen: 'Trainee', orte: ['Graz'], start: 'März 2027' } })).toEqual([]);
    expect(missingForSearch({ cv_text: 'kurz', preferences: {} })).toEqual(['Lebenslauf', 'Name', 'Zielrollen', 'Orte', 'Start']);
  });
  it('liest Orte als Liste ohne Doppelte', () => {
    expect(parseOrte('Graz, Linz;München\nGraz , ')).toEqual(['Graz', 'Linz', 'München']);
  });
  it('baut den mailto-Link und kürzt zu lange Texte', () => {
    expect(mailtoFor({ apply_email: 'jobs@example.com', email_subject: 'Bewerbung', email_body: 'Hallo' })?.href).toBe('mailto:jobs@example.com?subject=Bewerbung&body=Hallo');
    const lang = mailtoFor({ apply_email: 'jobs@example.com', email_subject: 'B', email_body: 'ä'.repeat(800) });
    expect(lang?.kurz).toBe(true);
    expect(lang?.href).not.toContain('body=');
    expect(mailtoFor({ apply_email: null, email_subject: 'x', email_body: 'y' })).toBeNull();
  });
  it('macht sichere Dateinamen', () => {
    expect(fileName('Anschreiben', 'Lena', 'A/B: GmbH?')).toBe('Anschreiben Lena A B GmbH');
  });
  it('räumt Lebenslauf-Text auf', () => {
    expect(cleanCvText('  Lena   Beispiel \n\n\n\nGraz\u0000 ')).toBe('Lena Beispiel\n\nGraz');
  });
  it('teilt Anschreiben in Absätze', () => {
    expect(paragraphs('Betreff\n\nSehr geehrte Frau Muster,\n\nText eins.\nZeile zwei.\n\n\n')).toEqual([['Betreff'], ['Sehr geehrte Frau Muster,'], ['Text eins.', 'Zeile zwei.']]);
  });
  it('rechnet Tage bis zur Frist', () => {
    expect(daysUntil('2026-11-14', NOW)).toBe(3);
    expect(daysUntil(null, NOW)).toBeNull();
  });
});

describe('proTag', () => {
  it('begrenzt auf 1 bis 12, leer heißt 10', () => {
    expect(proTag(20)).toBe(12);
    expect(proTag(0)).toBe(1);
    expect(proTag(null)).toBe(10);
    expect(proTag('7')).toBe(7);
  });
});

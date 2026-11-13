/** Produktname an einer Stelle. */
export const MARKE = 'Jobbster';
// Angaben, die vor dem Start feststehen müssen. Fehlen sie, zeigt die App die Stelle nicht an, statt etwas zu erfinden.
export const SUPPORT_EMAIL: string | null = import.meta.env.VITE_SUPPORT_EMAIL || null;

/** Impressum nach § 5 ECG und § 25 MedienG: Werte kommen beim Build aus den Umgebungsvariablen. */
export const IMPRESSUM = {
  name: import.meta.env.VITE_IMPRESSUM_NAME || null,
  anschrift: import.meta.env.VITE_IMPRESSUM_ANSCHRIFT || null,
  email: import.meta.env.VITE_SUPPORT_EMAIL || null,
  gewerbe: import.meta.env.VITE_IMPRESSUM_GEWERBE || null,
  behoerde: import.meta.env.VITE_IMPRESSUM_BEHOERDE || null,
  kammer: import.meta.env.VITE_IMPRESSUM_KAMMER || null,
  uid: import.meta.env.VITE_IMPRESSUM_UID || null,
};

export const LEGAL_VERSION = '2026-11-beta';

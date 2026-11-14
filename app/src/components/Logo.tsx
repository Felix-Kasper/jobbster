/** App-Symbol von Jobbster: ein schlichtes j, der Punkt leuchtet grün wie eine neue Nachricht. */
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="5.6" fill="var(--primary)" />
      <path d="M13.6 10.2v6.1a3.6 3.6 0 0 1-3.6 3.6H8.6" fill="none" stroke="var(--primary-ink)" strokeWidth="2.7" strokeLinecap="round" />
      <circle cx="13.6" cy="5.7" r="1.95" fill="var(--licht)" />
    </svg>
  );
}

import { Logo } from './components/Logo';
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { auth, getConfig, getMember, getProfile, isAdmin } from './lib/api';
import { accessOf, type Access } from './lib/logic';
import type { Member, Profile, PublicConfig } from './lib/types';
import Login from './pages/Login';
import Register from './pages/Register';

const Onboarding = lazy(() => import('./pages/Onboarding'));
const Leads = lazy(() => import('./pages/Leads'));
const Account = lazy(() => import('./pages/Account'));
const Admin = lazy(() => import('./pages/Admin'));
const Legal = lazy(() => import('./pages/Legal'));

type AppState = {
  session: Session | null;
  member: Member | null;
  profile: Profile | null;
  config: PublicConfig;
  access: Access;
  admin: boolean;
  reload: () => Promise<void>;
  setProfile: (p: Profile) => void;
};

const Ctx = createContext<AppState | null>(null);
export function useApp(): AppState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp außerhalb des Providers');
  return c;
}

function Provider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [member, setMember] = useState<Member | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [config, setConfig] = useState<PublicConfig>({ offene_registrierung: false, preis: null, pausiert: false });
  const [admin, setAdmin] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    const s = await auth.session();
    setSession(s);
    if (!s) {
      setMember(null); setProfile(null); setAdmin(false); setLoaded(true);
      return;
    }
    const [m, p, a] = await Promise.all([getMember().catch(() => null), getProfile().catch(() => null), isAdmin().catch(() => false)]);
    setMember(m); setProfile(p); setAdmin(a); setLoaded(true);
  }, []);

  // Anmeldestand vom Auth-Server übernehmen: einmal beim Start, danach bei jedem Wechsel des Nutzers neu laden.
  useEffect(() => {
    getConfig().then(setConfig).catch(() => undefined);
    const start = setTimeout(() => { void reload(); }, 0);
    const sub = auth.onChange((s) => {
      setSession((alt) => {
        if (alt !== undefined && (alt?.user.id ?? null) !== (s?.user.id ?? null)) setTimeout(() => { void reload(); }, 0);
        return s;
      });
    });
    return () => { clearTimeout(start); sub.unsubscribe(); };
  }, [reload]);

  const value = useMemo<AppState>(() => ({
    session: session ?? null, member, profile, config, admin, reload, setProfile, access: accessOf(member),
  }), [session, member, profile, config, admin, reload]);

  if (session === undefined || !loaded) {
    return <div className="auth" aria-busy="true"><span className="spinner muted" aria-label="Lädt" /></div>;
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const svg = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const Icon = {
  liste: <svg {...svg}><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth="2.4" /></svg>,
  profil: <svg {...svg}><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20.5c1.4-3.7 4.2-5.6 7.5-5.6s6.1 1.9 7.5 5.6" /></svg>,
  konto: <svg {...svg}><rect x="3" y="5.5" width="18" height="13" rx="2.2" /><path d="M3 10h18M7 15h3" /></svg>,
  admin: <svg {...svg}><path d="M4 20V11M10 20V5M16 20v-6M21 20H3" /></svg>,
};

export function Marke({ to = '/treffer' }: { to?: string }) {
  return <Link className="marke" to={to} aria-label="Jobbster, zur Startseite"><Logo />Jobbster</Link>;
}

function Shell({ children }: { children: ReactNode }) {
  const { admin, access, member, config } = useApp();
  const loc = useLocation();
  const links = [
    { to: '/treffer', label: 'Treffer', icon: Icon.liste },
    { to: '/profil', label: 'Profil', icon: Icon.profil },
    { to: '/konto', label: 'Konto', icon: Icon.konto },
    ...(admin ? [{ to: '/admin', label: 'Admin', icon: Icon.admin }] : []),
  ];
  const zeigeBanner = !access.aktiv && !loc.pathname.startsWith('/konto');
  return (
    <div className="shell">
      <header className="top">
        <div className="top-in">
          <Marke />
          <nav aria-label="Hauptbereiche">{links.map((l) => <NavLink key={l.to} to={l.to}>{l.label}</NavLink>)}</nav>
        </div>
      </header>
      <main className="main" id="inhalt">
        {config.pausiert && <div className="banner warn" role="status">Jobbster ist gerade pausiert. Neue Läufe starten wieder, sobald die Pause vorbei ist.</div>}
        {zeigeBanner && (
          <div className={`banner ${member?.sub_status === 'past_due' ? 'bad' : 'warn'}`} role="status">
            <span><b>{access.titel}.</b> {access.text}</span>
            <Link className="btn second" to="/konto">Zum Konto</Link>
          </div>
        )}
        <Suspense fallback={<div className="empty"><span className="spinner muted" aria-label="Lädt" /></div>}>{children}</Suspense>
      </main>
      <nav className="tabbar" style={{ ['--n' as string]: links.length }} aria-label="Hauptbereiche">
        {links.map((l) => <NavLink key={l.to} to={l.to}>{l.icon}<span>{l.label}</span></NavLink>)}
      </nav>
    </div>
  );
}

function Guard({ children, admin: nurAdmin = false }: { children: ReactNode; admin?: boolean }) {
  const { session, profile, admin } = useApp();
  const loc = useLocation();
  if (!session) return <Navigate to="/anmelden" replace state={{ von: loc.pathname }} />;
  if (nurAdmin && !admin) return <Navigate to="/treffer" replace />;
  if (!profile?.onboarded_at && !loc.pathname.startsWith('/start') && !loc.pathname.startsWith('/konto')) return <Navigate to="/start" replace />;
  return <>{children}</>;
}

function Start() {
  const { session, profile } = useApp();
  if (!session) return <Navigate to="/anmelden" replace />;
  return <Navigate to={profile?.onboarded_at ? '/treffer' : '/start'} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <Provider>
        <Routes>
          <Route path="/" element={<Start />} />
          <Route path="/anmelden" element={<Login />} />
          <Route path="/registrieren" element={<Register />} />
          <Route path="/start" element={<Guard><Suspense fallback={null}><Onboarding /></Suspense></Guard>} />
          <Route path="/profil" element={<Guard><Shell><Onboarding asProfile /></Shell></Guard>} />
          <Route path="/treffer" element={<Guard><Shell><Leads /></Shell></Guard>} />
          <Route path="/treffer/:id" element={<Guard><Shell><Leads /></Shell></Guard>} />
          <Route path="/konto" element={<Guard><Shell><Account /></Shell></Guard>} />
          <Route path="/admin" element={<Guard admin><Shell><Admin /></Shell></Guard>} />
          {['/impressum', '/datenschutz', '/bedingungen'].map((p) => <Route key={p} path={p} element={<Suspense fallback={null}><Legal /></Suspense>} />)}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Provider>
    </BrowserRouter>
  );
}

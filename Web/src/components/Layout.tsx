import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCloseDropdowns } from '../lib/useCloseDropdowns';
import { HOME, visibleGroups, groupKeyForPath } from '../lib/navMenu';

// The top bar: the brand and the person's name on the first row, and on the second the Dashboard and the six dropdown tabs (lib/navMenu.ts).
// Pressing a tab opens its list; pressing another one (or moving onto it, while one is open) switches; pressing anywhere else, Escape, tabbing away or
// choosing a page closes it. On a phone the tabs fold into a menu button, and each tab opens in place.
export default function Layout() {
  const { signOut, name, role } = useAuth();
  useCloseDropdowns();   // tick-box dropdowns close when you click anywhere outside them
  const { pathname } = useLocation();
  const groups = visibleGroups(role);
  const here = groupKeyForPath(pathname);
  const [open, setOpen] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const bar = useRef<HTMLElement>(null);

  // Going to a page closes whatever was open.
  useEffect(() => { setOpen(null); setMenuOpen(false); }, [pathname]);

  useEffect(() => {
    const away = (e: Event) => {
      if (bar.current && !bar.current.contains(e.target as Node)) { setOpen(null); setMenuOpen(false); }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(null); setMenuOpen(false); } };
    // pointerdown (not click) so a tap on empty space counts on phones; focusin so tabbing out of the bar closes it too.
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('focusin', away, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('focusin', away, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const toggleMenu = () => {
    setOpen(menuOpen ? null : here);   // opening the phone menu shows the tab you are in
    setMenuOpen(!menuOpen);
  };

  return (
    <div id="app">
      {import.meta.env.VITE_APP_ENV === 'staging' && (
        <div className="env-banner" role="status">SANDBOX: a test copy with made-up data. Nothing here is real, and nothing you do here changes the live Radar.</div>
      )}
      <header className={'topnav' + (menuOpen ? ' menu-open' : '')} ref={bar}>
        <div className="brand">Rhino <span>Radar</span></div>

        <button type="button" className="topnav-burger" aria-label="Menu" aria-expanded={menuOpen} aria-controls="topnav-tabs" onClick={toggleMenu}>
          {menuOpen ? '✕' : '☰'}
        </button>

        <nav className="topnav-tabs" id="topnav-tabs" aria-label="Main">
          <NavLink to={HOME.to} end className={({ isActive }) => 'topnav-tab' + (isActive ? ' active' : '')}>{HOME.label}</NavLink>
          {groups.map(g => {
            const isOpen = open === g.key;
            return (
              <div key={g.key} className={'topnav-group' + (isOpen ? ' open' : '') + (here === g.key ? ' has-active' : '')}>
                <button
                  type="button"
                  className="topnav-tab"
                  aria-haspopup="true"
                  aria-expanded={isOpen}
                  onClick={() => setOpen(isOpen ? null : g.key)}
                  onMouseEnter={() => { if (open && open !== g.key) setOpen(g.key); }}
                >
                  {g.label}<span className="topnav-caret" aria-hidden="true">▾</span>
                </button>
                <div className="topnav-panel">
                  {g.items.map(item => (
                    <NavLink key={item.to} to={item.to} className={({ isActive }) => 'topnav-link' + (isActive ? ' active' : '')}>{item.label}</NavLink>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="topnav-user">
          {name && <span className="topnav-name">{name}</span>}
          {role && <span className="topnav-role">{role}</span>}
          <button className="btn secondary" style={{ padding: '6px 14px', fontSize: 14 }} onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <div className="main">
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

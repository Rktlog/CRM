import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCloseDropdowns } from '../lib/useCloseDropdowns';

const NAV = [
  { to: '/', label: 'Dashboard' },
  { to: '/planner', label: 'Planner' },
  { to: '/pipeline', label: 'Pipeline' },
  { to: '/customers', label: 'Customers' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/orders', label: 'Orders' },
  { to: '/credit', label: 'Credit' },
  { to: '/products', label: 'Products' },
  { to: '/catalogue', label: 'Catalogue' },
  { to: '/abandoned-carts', label: 'Abandoned carts' },
  { to: '/marketing', label: 'Marketing', managerOnly: true },
  { to: '/sales-data', label: 'Sales Data' },
  { to: '/assistant', label: 'Assistant' },
  { to: '/reports', label: 'Reports' },
  { to: '/activity', label: 'Activity log' },
  { to: '/misc', label: 'Misc' },
  { to: '/settings', label: 'Settings' },
];

export default function Layout() {
  const { signOut, name, role } = useAuth();
 useCloseDropdowns();   // tick-box dropdowns close when you click anywhere outside them
 
  return (
    <div id="app">
      <div className="rail">
        <div className="brand">Rhino <span>Radar</span></div>
        {NAV.filter(item => !('managerOnly' in item) || role === 'manager').map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}
          >
            {item.label}
          </NavLink>
        ))}
      </div>
      <div className="main">
        <div className="top-header">
          <div className="top-header-user">
            {name && <span className="top-header-name">{name}</span>}
            {role && <span className="badge muted" style={{ textTransform: 'capitalize' }}>{role}</span>}
          </div>
          <button className="btn secondary" style={{ padding: '5px 12px', fontSize: 12 }} onClick={signOut}>
            Sign out
          </button>
        </div>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Pipeline from './pages/Pipeline';
import Accounts from './pages/Accounts';
import AccountDetail from './pages/AccountDetail';
import SalesData from './pages/SalesData';
import Settings from './pages/Settings';
import Visits from './pages/Visits';
import Planner from './pages/Planner';
import Reports from './pages/Reports';
import Misc from './pages/Misc';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { session, loading } = useAuth();
  if (loading) return <div className="empty-state">Loading…</div>;
  if (!session) return <Navigate to="/login" replace />;
  return children;
}

function Routed() {
  const { session } = useAuth();
  return (
    <Routes>
      <Route path="/login" element={session ? <Navigate to="/" replace /> : <Login />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="planner" element={<Planner />} />
        <Route path="pipeline" element={<Pipeline />} />
        <Route path="accounts" element={<Accounts />} />
        <Route path="accounts/:id" element={<AccountDetail />} />
        <Route path="sales-data" element={<SalesData />} />
        <Route path="reports" element={<Reports />} />
        <Route path="misc" element={<Misc />} />
        <Route path="settings" element={<Settings />} />
        <Route path="visits" element={<Visits />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routed />
      </BrowserRouter>
    </AuthProvider>
  );
}
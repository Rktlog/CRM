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
import ProductSearch from './pages/ProductSearch';
import Orders from './pages/Orders';
import OrderDetail from './pages/OrderDetail';
import AbandonedCarts from './pages/Abandonedcarts';
import Customers from './pages/Customers';
import InactiveStockists from './pages/InactiveStockists';
import Credit from './pages/Credit';
import Catalogue from './pages/Catalogue';

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
        <Route path="products" element={<ProductSearch />} />
        <Route path="catalogue" element={<Catalogue />} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/:id" element={<OrderDetail />} />
        <Route path="abandoned-carts" element={<AbandonedCarts />} />
        <Route path="customers" element={<Customers />} />
        <Route path="inactive-stockists" element={<InactiveStockists />} />
        <Route path="credit" element={<Credit />} />
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
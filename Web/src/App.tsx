import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Pipeline from './pages/Pipeline';
import Accounts from './pages/Accounts';
import AccountDetail from './pages/AccountDetail';
import CouncilStores from './pages/CouncilStores';
import SalesData from './pages/SalesData';
import Settings from './pages/Settings';
import ActivityLog from './pages/ActivityLog';
import Planner from './pages/Planner';
import Reports from './pages/Reports';
import ReportBuilder from './pages/ReportBuilder';
import Misc from './pages/Misc';
import ProductSearch from './pages/ProductSearch';
import Orders from './pages/Orders';
import OrderDetail from './pages/OrderDetail';
import AbandonedCarts from './pages/Abandonedcarts';
import Customers from './pages/Customers';
import InactiveStockists from './pages/InactiveStockists';
import Credit from './pages/Credit';
import Catalogue from './pages/Catalogue';
import Conversion from './pages/Conversion';
import Marketing from './pages/Marketing';
import MarketingCampaigns from './pages/MarketingCampaigns';
import MarketingCampaign from './pages/MarketingCampaign';
import MarketingReport from './pages/MarketingReport';
import MarketingAudience from './pages/MarketingAudience';
import MarketingTemplates from './pages/MarketingTemplates';
import MarketingAutomations from './pages/MarketingAutomations';
import MarketingSettings from './pages/MarketingSettings';
import Assistant from './pages/Assistant';
import Ordering from './pages/Ordering';

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
        <Route path="council/:name" element={<CouncilStores />} />
        <Route path="sales-data" element={<SalesData />} />
        <Route path="reports" element={<Reports />} />
        <Route path="reports/builder" element={<ReportBuilder />} />
        <Route path="misc" element={<Misc />} />
        <Route path="products" element={<ProductSearch />} />
        <Route path="catalogue" element={<Catalogue />} />
        <Route path="conversion" element={<Conversion />} />
        <Route path="marketing" element={<Marketing />} />
        <Route path="marketing/campaigns" element={<MarketingCampaigns />} />
        <Route path="marketing/campaigns/:id" element={<MarketingCampaign />} />
        <Route path="marketing/campaigns/:id/report" element={<MarketingReport />} />
        <Route path="marketing/audience" element={<MarketingAudience />} />
        <Route path="marketing/templates" element={<MarketingTemplates />} />
        <Route path="marketing/automations" element={<MarketingAutomations />} />
        <Route path="marketing/settings" element={<MarketingSettings />} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/:id" element={<OrderDetail />} />
        <Route path="abandoned-carts" element={<AbandonedCarts />} />
        <Route path="customers" element={<Customers />} />
        <Route path="inactive-stockists" element={<InactiveStockists />} />
        <Route path="credit" element={<Credit />} />
        <Route path="settings" element={<Settings />} />
        <Route path="activity" element={<ActivityLog />} />
        <Route path="assistant" element={<Assistant />} />
        <Route path="ordering" element={<Ordering />} />
        {/* the old address for this page */}
        <Route path="visits" element={<Navigate to="/activity" replace />} />
        {/* an address that does not exist: say so, with the menu still there, instead of a blank page */}
        <Route path="*" element={<div className="empty-state">That page does not exist. Pick something from the menu.</div>} />
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
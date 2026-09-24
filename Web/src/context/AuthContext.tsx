import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { apiGet } from '../lib/api';

type AuthState = {
  session: Session | null;
  loading: boolean;
  role: 'rep' | 'manager' | null;
  name: string | null;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({ session: null, loading: true, role: null, name: null, signOut: async () => {} });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState<'rep' | 'manager' | null>(null);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setRole(null);
      setName(null);
      return;
    }
    // Fetched once per login — used only to show/hide manager-only UI
    // like the team activity view, nothing security-sensitive (the
    // API itself re-checks role on every request regardless).
    apiGet('/me').then(me => { setRole(me.role); setName(me.name ?? null); }).catch(() => { setRole(null); setName(null); });
  }, [session]);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return <AuthContext.Provider value={{ session, loading, role, name, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
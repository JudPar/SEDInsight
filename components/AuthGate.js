'use client';

import { useEffect, useState } from 'react';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';

export default function AuthGate({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setLoading(false);
      return undefined;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (signInError) setError('No fue posible iniciar sesión. Verifica tus credenciales.');
  }

  if (loading) return <main className="auth-screen"><p>Comprobando sesión…</p></main>;
  if (!isSupabaseConfigured || !supabase) {
    return <main className="auth-screen"><section className="auth-card"><h1>GEOPLUZ</h1><p>La conexión segura con Supabase aún no está configurada.</p></section></main>;
  }
  if (!session) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={handleSubmit}>
          <h1>GEOPLUZ</h1>
          <p>Acceso para personal autorizado.</p>
          <label htmlFor="auth-email">Correo electrónico</label>
          <input id="auth-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <label htmlFor="auth-password">Contraseña</label>
          <input id="auth-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="btn btn-cyan" type="submit" disabled={submitting}>{submitting ? 'Ingresando…' : 'Ingresar'}</button>
        </form>
      </main>
    );
  }

  return <>{children}<button className="auth-logout" onClick={() => supabase.auth.signOut()} title="Cerrar sesión"><i className="fa-solid fa-right-from-bracket" /> Salir</button></>;
}

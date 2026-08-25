'use client';

import { useEffect, useState } from 'react';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';

function getAuthCallbackState() {
  if (typeof window === 'undefined') return { isInvite: false, hasError: false };

  // Supabase handles the session and token fragment itself. We only inspect the
  // non-sensitive callback type/error indicators to select the appropriate UI.
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const queryParams = new URLSearchParams(window.location.search);
  const callbackType = hashParams.get('type') || queryParams.get('type');
  const hasError = Boolean(
    hashParams.get('error') ||
    hashParams.get('error_code') ||
    queryParams.get('error') ||
    queryParams.get('error_code')
  );

  return { isInvite: callbackType === 'invite', hasError };
}

export default function AuthGate({ children }) {
  const [authCallback] = useState(getAuthCallbackState);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const [invitePasswordCreated, setInvitePasswordCreated] = useState(false);
  const [inviteFlowComplete, setInviteFlowComplete] = useState(false);

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
  async function handleInvitePassword(event) {
    event.preventDefault();
    setInviteError('');

    if (newPassword.length < 12) {
      setInviteError('La contraseña debe tener al menos 12 caracteres.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setInviteError('Las contraseñas no coinciden.');
      return;
    }

    setInviteSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    setInviteSubmitting(false);
    setNewPassword('');
    setConfirmPassword('');

    if (updateError) {
      setInviteError('No fue posible crear la contraseña. Solicita una nueva invitación al administrador.');
      return;
    }

    setInvitePasswordCreated(true);
  }

  if (!isSupabaseConfigured || !supabase) {
    return <main className="auth-screen"><section className="auth-card"><h1>GEOPLUZ</h1><p>La conexión segura con Supabase aún no está configurada.</p></section></main>;
  }
  if (authCallback.hasError || (authCallback.isInvite && !session)) {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <h1>GEOPLUZ</h1>
          <p>La invitación ha expirado o ya fue utilizada. Solicita una nueva invitación al administrador.</p>
        </section>
      </main>
    );
  }
  if (authCallback.isInvite && session && !invitePasswordCreated && !inviteFlowComplete) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={handleInvitePassword}>
          <h1>Crear contraseña</h1>
          <p>Define una contraseña para completar tu acceso a GEOPLUZ.</p>
          <label htmlFor="invite-new-password">Nueva contraseña</label>
          <input id="invite-new-password" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength="12" required />
          <label htmlFor="invite-confirm-password">Confirmar contraseña</label>
          <input id="invite-confirm-password" type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength="12" required />
          {inviteError && <p className="auth-error" role="alert">{inviteError}</p>}
          <button className="btn btn-cyan" type="submit" disabled={inviteSubmitting}>{inviteSubmitting ? 'Creando contraseña…' : 'Crear contraseña'}</button>
        </form>
      </main>
    );
  }
  if (authCallback.isInvite && session && invitePasswordCreated && !inviteFlowComplete) {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <h1>Contraseña creada</h1>
          <p>Tu acceso ya está listo. A partir de ahora podrás iniciar sesión con tu correo y contraseña.</p>
          <button className="btn btn-cyan" type="button" onClick={() => setInviteFlowComplete(true)}>Continuar a GEOPLUZ</button>
        </section>
      </main>
    );
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

import { Button, Field } from '@ipc/design-system';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, NetworkError } from '../../lib/api.js';

export function loginErrorKey(e: unknown): string {
  if (e instanceof NetworkError) return 'auth.offline';
  if (e instanceof ApiError) {
    if (e.status === 401 || e.status === 400) return 'auth.invalid';
    if (e.status === 429) return 'auth.rateLimited';
  }
  return 'auth.unavailable';
}

export function LoginForm({ onSubmit }: { onSubmit: (identifier: string, password: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await onSubmit(identifier.trim(), password);
    } catch (err) {
      setError(t(loginErrorKey(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)} noValidate>
      {error && (
        <p role="alert" className="rounded-md bg-feedback-error p-3 text-feedback-error-fg">
          {error}
        </p>
      )}
      <Field label={t('auth.identifier')} autoComplete="username" required maxLength={254} value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
      <Field label={t('auth.password')} type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={(e) => setPassword(e.target.value)} />
      <Button type="submit" busy={busy} disabled={!identifier || !password}>
        {t('auth.submit')}
      </Button>
    </form>
  );
}

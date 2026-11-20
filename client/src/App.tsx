import { useEffect, useState } from 'react';

// A shell until PLAN-001 Task 5 builds the dashboard on @terjeballestad/bob.
// It shows that the image serves the client and that the API reaches Postgres.
export function App() {
  const [health, setHealth] = useState<'checking' | 'ok' | 'down'>('checking');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((b: { ok: boolean }) => setHealth(b.ok ? 'ok' : 'down'))
      .catch(() => setHealth('down'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 32, color: '#e6e7ec', background: '#0f1014', minHeight: '100vh', margin: 0 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>pm board</h1>
      <p>Path: {window.location.pathname}</p>
      <p>Database: {health}</p>
    </main>
  );
}

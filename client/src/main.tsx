import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@terjeballestad/bob/styles.css';
import './app.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

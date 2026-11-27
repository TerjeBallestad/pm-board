import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastStack } from '@terjeballestad/bob';
import './app.css';
import { App } from './App';
import { toast } from './toast';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastStack toastManager={toast} timeout={3000}>
      <App />
    </ToastStack>
  </StrictMode>,
);

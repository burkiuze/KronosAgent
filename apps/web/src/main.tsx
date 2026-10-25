import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bootTheme } from './lib/themes';
import { installCopyHandler } from './lib/markdown';
import { startRealtime } from './lib/store';
import 'highlight.js/styles/github-dark-dimmed.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

bootTheme();
installCopyHandler();
startRealtime();

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

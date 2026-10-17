import { createRoot } from 'react-dom/client';
import App from './App';
import { ensureApiBase } from './api';
import './styles.css';

void ensureApiBase().finally(() => {
  createRoot(document.getElementById('root')!).render(<App />);
});

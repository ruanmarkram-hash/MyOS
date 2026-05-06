import { render } from 'preact';
import { App } from './App';
import './styles/main.css';
import './lib/theme'; // initializes the theme effect on import
import './lib/api';   // initializes the dashboard token cache from URL
import { registerPwaServiceWorker } from './lib/pwa';

registerPwaServiceWorker();

const root = document.getElementById('app');
if (root) {
  render(<App />, root);
}

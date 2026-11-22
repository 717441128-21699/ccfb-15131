import { renderShell, currentPage } from './ui/router';
import { renderMediaPage } from './ui/mediaPage';
import { renderCalibrationPage, disposeEngine, getEngineDebug } from './ui/calibrationPage';
import { renderPreviewPage } from './ui/previewPage';
import { renderExportPage } from './ui/exportPage';
import { store } from './state/store';
import './styles.css';

const mount = document.querySelector<HTMLElement>('#app')!;

renderShell(mount, () => {
  switch (currentPage()) {
    case 'media':
      return renderMediaPage();
    case 'calibration':
      return renderCalibrationPage();
    case 'preview':
      return renderPreviewPage();
    case 'export':
      return renderExportPage();
    default:
      return renderMediaPage();
  }
});

window.addEventListener('beforeunload', () => {
  disposeEngine();
});

// Test/debug hook (local tool, no network exposure).
declare global {
  interface Window {
    __app?: { store: typeof store; getEngine?: () => unknown };
  }
}
window.__app = { store, getEngine: () => getEngineDebug() };

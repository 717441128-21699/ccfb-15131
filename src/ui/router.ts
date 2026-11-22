/**
 * Hash router and app shell. Four pages:
 * #/media -> #/calibration -> #/preview -> #/export
 */

import { store, type PageId } from '../state/store';

const ROUTES: PageId[] = ['media', 'calibration', 'preview', 'export'];
const LABELS: Record<PageId, string> = {
  media: '1. 素材',
  calibration: '2. 屏幕标定',
  preview: '3. 处理预览',
  export: '4. 导出',
};

export function currentPage(): PageId {
  const hash = location.hash.replace('#/', '').replace('#', '') as PageId;
  return ROUTES.includes(hash) ? hash : 'media';
}

export function navigate(page: PageId): void {
  location.hash = `/${page}`;
}

export function renderShell(mount: HTMLElement, pageRenderer: () => HTMLElement): () => void {
  const render = () => {
    const page = currentPage();
    store.update({ page });
    const state = store.get();
    mount.innerHTML = `
      <header class="topbar">
        <div class="brand">LED 屏闪烁修复台 <span class="tag">WebGL2 · TypeScript</span></div>
        <nav class="steps">
          ${ROUTES.map((r, i) => `
            <button class="step ${r === page ? 'active' : ''} ${r !== page && i > ROUTES.indexOf(page) && !state.clip ? 'locked' : ''}"
              data-page="${r}" ${!state.clip && i > 0 ? 'disabled' : ''}>
              ${LABELS[r]}
            </button>`).join('')}
        </nav>
      </header>
      <main id="page-root"></main>
      <footer class="statusbar">
        <span id="status-line">${state.clip ? `${state.clip.name} · ${state.clip.width}×${state.clip.height} · ${state.clip.fps}fps` : '未加载素材'}</span>
      </footer>
    `;
    mount.querySelectorAll<HTMLButtonElement>('.step').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!btn.disabled) navigate(btn.dataset.page as PageId);
      });
    });
    const root = mount.querySelector('#page-root')!;
    root.appendChild(pageRenderer());
  };
  render();
  window.addEventListener('hashchange', render);
  return () => window.removeEventListener('hashchange', render);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

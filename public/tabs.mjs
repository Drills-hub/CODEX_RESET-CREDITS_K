export const TAB_IDS = Object.freeze(['schedule', 'forecast', 'alerts', 'credits']);
export const DEFAULT_TAB = 'schedule';

export function normalizeTab(value) {
  return TAB_IDS.includes(value) ? value : DEFAULT_TAB;
}

export function tabUrl(href, tabId) {
  const url = new URL(href);
  url.hash = '';
  url.searchParams.set('tab', normalizeTab(tabId));
  return `${url.pathname}${url.search}`;
}

export function createTabController({ tablist, tabs, panels, initialTab, onSelect = () => {}, motion, resizeTarget = globalThis }) {
  const tabById = new Map(tabs.map(tab => [tab.dataset.tab, tab]));
  const panelById = new Map(panels.map(panel => [panel.dataset.tabPanel, panel]));
  const indicator = tablist.querySelector('[data-tab-indicator]');
  let current = normalizeTab(initialTab);

  function positionIndicator(tab) {
    if (!indicator || !tab?.getBoundingClientRect) return;
    const listRect = tablist.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    motion?.moveIndicator(indicator, { x: tabRect.left - listRect.left + tablist.scrollLeft, width: tabRect.width });
  }

  function revealTab(tab) {
    if (!tab || typeof tablist.scrollTo !== 'function') return;
    const start = tab.offsetLeft;
    const end = start + tab.offsetWidth;
    const visibleStart = tablist.scrollLeft;
    const visibleEnd = visibleStart + tablist.clientWidth;
    if (start < visibleStart) tablist.scrollTo({ left: start, behavior: 'auto' });
    else if (end > visibleEnd) tablist.scrollTo({ left: end - tablist.clientWidth, behavior: 'auto' });
  }

  function activate(tabId, { focus = false, notify = true, animate = true } = {}) {
    const next = normalizeTab(tabId);
    const changed = current !== next;
    current = next;
    for (const [id, tab] of tabById) {
      const selected = id === current;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const [id, panel] of panelById) panel.hidden = id !== current;
    const tab = tabById.get(current);
    const panel = panelById.get(current);
    if (focus) tab?.focus();
    revealTab(tab);
    positionIndicator(tab);
    if (changed && animate) motion?.enterPanel(panel);
    if (notify && changed) onSelect(current);
    return current;
  }

  function onClick(event) {
    const tab = event.target.closest('[role="tab"]');
    if (tablist.contains(tab)) activate(tab.dataset.tab);
  }

  function onKeydown(event) {
    const tab = event.target.closest('[role="tab"]');
    if (!tablist.contains(tab)) return;
    const index = TAB_IDS.indexOf(tab.dataset.tab);
    let next;
    if (event.key === 'ArrowRight') next = TAB_IDS[(index + 1) % TAB_IDS.length];
    else if (event.key === 'ArrowLeft') next = TAB_IDS[(index - 1 + TAB_IDS.length) % TAB_IDS.length];
    else if (event.key === 'Home') next = TAB_IDS[0];
    else if (event.key === 'End') next = TAB_IDS[TAB_IDS.length - 1];
    else if (event.key === 'Enter' || event.key === ' ') next = tab.dataset.tab;
    else return;
    event.preventDefault();
    activate(next, { focus: true });
  }

  const onResize = () => positionIndicator(tabById.get(current));
  tablist.addEventListener('click', onClick);
  tablist.addEventListener('keydown', onKeydown);
  resizeTarget.addEventListener?.('resize', onResize);
  activate(current, { notify: false, animate: false });

  return {
    activate,
    current: () => current,
    destroy() {
      tablist.removeEventListener('click', onClick);
      tablist.removeEventListener('keydown', onKeydown);
      resizeTarget.removeEventListener?.('resize', onResize);
    },
  };
}

const defaultReducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export function createMotionController({ reduceMotion = defaultReducedMotion } = {}) {
  const running = new WeakMap();
  const active = new Set();

  function play(element, keyframes, options) {
    if (!element?.animate || element.hidden || reduceMotion()) return null;
    running.get(element)?.cancel();
    const animation = element.animate(keyframes, { fill: 'none', easing: 'cubic-bezier(0.2, 0, 0, 1)', ...options });
    running.set(element, animation);
    active.add(animation);
    const release = () => active.delete(animation);
    animation.addEventListener?.('finish', release, { once: true });
    animation.addEventListener?.('cancel', release, { once: true });
    return animation;
  }

  function moveIndicator(element, { x, width }) {
    const previousX = Number(element?.dataset?.x ?? x);
    const previousWidth = Number(element?.dataset?.width ?? width);
    if (element?.style) {
      element.style.transform = `translateX(${x}px)`;
      element.style.width = `${width}px`;
    }
    if (element?.dataset) {
      element.dataset.x = String(x);
      element.dataset.width = String(width);
    }
    return play(element, [
      { transform: `translateX(${previousX}px)`, width: `${previousWidth}px` },
      { transform: `translateX(${x}px)`, width: `${width}px` },
    ], { duration: 180 });
  }

  return {
    moveIndicator,
    enterPanel: element => play(element, [
      { opacity: 0, transform: 'translateY(6px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 200 }),
    emphasizeValue: element => play(element, [
      { opacity: 0.58, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 220 }),
    showNotice: element => play(element, [
      { opacity: 0, transform: 'translateY(-4px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 180 }),
    cancelAll() {
      for (const animation of active) animation.cancel();
      active.clear();
    },
  };
}

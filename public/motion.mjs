// Gentle ease-in-out: no abrupt start, so ~0.4s effects read as smooth rather than snappy.
const easeOut = 'cubic-bezier(0.4, 0, 0.2, 1)';
const systemReducesMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// Web Animations API only: nothing persists after an effect ends, so layout and final styles never depend on motion.
export function createMotionController({ reduceMotion = systemReducesMotion } = {}) {
  const running = new Map();

  function play(element, keyframes, duration) {
    if (!element?.animate || reduceMotion()) return null;
    running.get(element)?.cancel();
    const animation = element.animate(keyframes, { duration, easing: easeOut });
    running.set(element, animation);
    animation.onfinish = animation.oncancel = () => { if (running.get(element) === animation) running.delete(element); };
    return animation;
  }

  function moveIndicator(element, { x, width }, { animate = false } = {}) {
    const from = { transform: element?.style?.transform, width: element?.style?.width };
    const to = { transform: `translateX(${x}px)`, width: `${width}px` };
    if (element?.style) Object.assign(element.style, to);
    if (element?.dataset) {
      element.dataset.x = String(x);
      element.dataset.width = String(width);
    }
    return animate && from.transform ? play(element, [from, to], 400) : null;
  }

  return {
    moveIndicator,
    enterPanel: element => play(element, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], 380),
    emphasizeValue: element => play(element, [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], 440),
    showNotice: element => play(element, [{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'none' }], 380),
    cancelAll() { for (const animation of [...running.values()]) animation.cancel(); },
  };
}

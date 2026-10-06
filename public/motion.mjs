export function createMotionController() {
  function moveIndicator(element, { x, width }) {
    if (element?.style) {
      element.style.transform = `translateX(${x}px)`;
      element.style.width = `${width}px`;
    }
    if (element?.dataset) {
      element.dataset.x = String(x);
      element.dataset.width = String(width);
    }
  }

  return {
    moveIndicator,
    enterPanel: () => null,
    emphasizeValue: () => null,
    showNotice: () => null,
    cancelAll() {},
  };
}

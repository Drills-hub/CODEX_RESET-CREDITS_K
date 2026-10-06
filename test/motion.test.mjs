import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionController } from '../public/motion.mjs';

function animatedElement() {
  const calls = [];
  return {
    calls,
    style: {},
    dataset: {},
    hidden: false,
    animate(keyframes, options) {
      const animation = { cancelled: false, cancel() { this.cancelled = true; } };
      calls.push({ keyframes, options, animation });
      return animation;
    },
  };
}

test('reduced motion suppresses every Web Animations API effect', () => {
  const element = animatedElement();
  const motion = createMotionController({ reduceMotion: () => true });
  motion.enterPanel(element);
  motion.emphasizeValue(element);
  motion.showNotice(element);
  motion.moveIndicator(element, { x: 12, width: 80 });
  assert.equal(element.calls.length, 0);
});

test('content and tab indicator updates do not play automatic animations', () => {
  const element = animatedElement();
  const motion = createMotionController({ reduceMotion: () => false });
  motion.enterPanel(element);
  motion.emphasizeValue(element);
  motion.showNotice(element);
  motion.moveIndicator(element, { x: 12, width: 80 });
  assert.equal(element.calls.length, 0);
  assert.equal(element.style.transform, 'translateX(12px)');
  assert.equal(element.style.width, '80px');
});

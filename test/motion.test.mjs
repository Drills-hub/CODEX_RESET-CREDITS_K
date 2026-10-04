import test from 'node:test';
import assert from 'node:assert/strict';
import { createMotionController } from '../public/motion.mjs';

function animatedElement() {
  const calls = [];
  return {
    calls,
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

test('restarting an effect cancels its previous animation', () => {
  const element = animatedElement();
  const motion = createMotionController({ reduceMotion: () => false });
  motion.emphasizeValue(element);
  const first = element.calls[0].animation;
  motion.emphasizeValue(element);
  assert.equal(first.cancelled, true);
  assert.equal(element.calls.length, 2);
});

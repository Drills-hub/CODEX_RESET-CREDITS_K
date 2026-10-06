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
  motion.moveIndicator(element, { x: 0, width: 40 });
  motion.moveIndicator(element, { x: 12, width: 80 }, { animate: true });
  assert.equal(element.calls.length, 0);
  assert.equal(element.style.transform, 'translateX(12px)');
});

test('panel, value and notice effects play short animations that end in the resting state', () => {
  const motion = createMotionController({ reduceMotion: () => false });
  for (const [effect, duration] of [['enterPanel', 380], ['emphasizeValue', 440], ['showNotice', 380]]) {
    const element = animatedElement();
    motion[effect](element);
    assert.equal(element.calls.length, 1, effect);
    assert.equal(element.calls[0].options.duration, duration, effect);
    const frames = element.calls[0].keyframes;
    assert.ok(['none', 'scale(1)'].includes(frames.at(-1).transform), effect);
  }
});

test('indicator slides from its previous position only when asked', () => {
  const element = animatedElement();
  const motion = createMotionController({ reduceMotion: () => false });
  motion.moveIndicator(element, { x: 0, width: 40 }, { animate: true });
  assert.equal(element.calls.length, 0, 'first placement has no previous position');
  motion.moveIndicator(element, { x: 12, width: 80 });
  assert.equal(element.calls.length, 0, 'resize repositioning is instant');
  motion.moveIndicator(element, { x: 100, width: 60 }, { animate: true });
  assert.deepEqual(element.calls[0].keyframes, [{ transform: 'translateX(12px)', width: '80px' }, { transform: 'translateX(100px)', width: '60px' }]);
  assert.equal(element.style.transform, 'translateX(100px)');
  assert.equal(element.dataset.width, '60');
});

test('a new effect on the same element replaces the running one, and cancelAll stops everything', () => {
  const element = animatedElement();
  const other = animatedElement();
  const motion = createMotionController({ reduceMotion: () => false });
  motion.emphasizeValue(element);
  motion.emphasizeValue(element);
  assert.equal(element.calls[0].animation.cancelled, true);
  motion.showNotice(other);
  motion.cancelAll();
  assert.equal(element.calls[1].animation.cancelled, true);
  assert.equal(other.calls[0].animation.cancelled, true);
});

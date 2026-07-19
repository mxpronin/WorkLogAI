import test from 'node:test';
import assert from 'node:assert/strict';
import { getNativePlugin } from '../src/platform/capacitor.js';

test('uses plugins exported by the native Capacitor bridge', () => {
  const plugin = { checkPermissions() {} };
  const capacitor = { isNativePlatform: () => true, Plugins: { LocalNotifications: plugin } };
  assert.equal(getNativePlugin('LocalNotifications', capacitor), plugin);
});

test('supports the registerPlugin API when Capacitor core is bundled', () => {
  const plugin = { checkPermissions() {} };
  const capacitor = { isNativePlatform: () => true, registerPlugin: () => plugin };
  assert.equal(getNativePlugin('LocalNotifications', capacitor), plugin);
});

test('does not expose native plugins in a browser', () => {
  const capacitor = { isNativePlatform: () => false, Plugins: { LocalNotifications: {} } };
  assert.equal(getNativePlugin('LocalNotifications', capacitor), null);
});

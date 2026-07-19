export function getNativePlugin(name, capacitor = globalThis.Capacitor) {
  if (!capacitor?.isNativePlatform?.()) return null;
  return capacitor.Plugins?.[name] ?? capacitor.registerPlugin?.(name) ?? null;
}

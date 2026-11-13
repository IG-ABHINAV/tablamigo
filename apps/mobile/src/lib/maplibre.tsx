// Native maps. The web build resolves maplibre.web.tsx instead (maplibre-gl, same API subset).
// Keep the .tsx extension: Metro only prefers a .web file over one with the same extension.
export * from '@maplibre/maplibre-react-native';

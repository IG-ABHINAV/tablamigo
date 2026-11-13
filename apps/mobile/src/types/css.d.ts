// A stylesheet imported for its side effect (src/lib/maplibre.web.tsx pulls in maplibre-gl's CSS on the web build).
// TypeScript 6 checks that such an import resolves; Metro handles the file itself, so a bare declaration is all it needs.
declare module '*.css';

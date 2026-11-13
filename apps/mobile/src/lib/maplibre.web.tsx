// Web maps: maplibre-gl behind the small slice of the MapLibre React Native API the app uses
// (Map, Camera, Marker, ViewAnnotation), so screens render the same pins on both platforms.
import React, { createContext, useContext, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import type maplibregl from 'maplibre-gl';
// Expo hoists every CSS import into index.html (10 KB gzipped), so importing it lazily gains nothing.
import 'maplibre-gl/dist/maplibre-gl.css';

// maplibre-gl itself is ~1 MB: load it when the first map mounts, not with the app.
type GL = typeof maplibregl;
let gl: GL | null = null;
let loading: Promise<GL> | null = null;
const loadGL = () => loading ??= import('maplibre-gl')
  .then(mod => (gl = mod.default))
  .catch(e => { loading = null; throw e; });

type LngLat = [number, number];
type Padding = { top?: number; right?: number; bottom?: number; left?: number };
type Anim = { zoom?: number; padding?: Padding; duration?: number };
export type CameraRef = {
  flyTo(o: Anim & { center: LngLat }): void;
  fitBounds(b: [number, number, number, number], o?: Anim): void;
};

const Ctx = createContext<maplibregl.Map | null>(null);

type MapProps = {
  style?: StyleProp<ViewStyle>; mapStyle: string; attribution?: boolean; logo?: boolean; compass?: boolean; androidView?: string;
  dragPan?: boolean; touchZoom?: boolean; doubleTapZoom?: boolean; doubleTapHoldZoom?: boolean; touchRotate?: boolean; touchPitch?: boolean;
  children?: React.ReactNode;
};

function MapView({ style, mapStyle, attribution, dragPan, touchZoom, children }: MapProps) {
  const box = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  useEffect(() => {
    let dead = false, m: maplibregl.Map | undefined, ro: ResizeObserver | undefined;
    loadGL().then(GL => {
      const el = box.current;
      if (dead || !el) return;
      const map = m = new GL.Map({
        container: el, style: mapStyle, attributionControl: attribution ? { compact: true } : false,
        interactive: dragPan !== false || touchZoom !== false, dragRotate: false, pitchWithRotate: false,
      });
      map.touchZoomRotate.disableRotation();
      // The compact attribution starts expanded on wide maps and covers the small chat cards; start it as the (i) button.
      map.once('load', () => el.querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show'));
      // Tabs and sheets resize the container without a window resize.
      ro = new ResizeObserver(() => map.resize());
      ro.observe(el);
      setMap(map);
    }, () => {});   // offline with the chunk not cached yet: no map, the rest of the screen still works
    return () => { dead = true; ro?.disconnect(); m?.remove(); };
  }, [mapStyle]);
  return (
    <View style={[{ overflow: 'hidden' }, style]}>
      <div ref={box} style={{ position: 'absolute', inset: 0 }} />
      {map ? <Ctx.Provider value={map}>{children}</Ctx.Provider> : null}
    </View>
  );
}
export { MapView as Map };

const padding = (p?: Padding) => p && { top: p.top ?? 0, right: p.right ?? 0, bottom: p.bottom ?? 0, left: p.left ?? 0 };
/** Drops undefined keys: maplibre treats a present-but-undefined option differently from a missing one. */
const defined = <O extends object>(o: O) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as O;
const safe = (what: string, f: () => void) => { try { f(); } catch (e) { console.error(`map ${what} failed`, e); } };

export function Camera({ ref, initialViewState, center, zoom, duration }: {
  ref?: React.Ref<CameraRef>; initialViewState?: { center: LngLat; zoom?: number }; center?: LngLat; zoom?: number; duration?: number;
}) {
  const map = useContext(Ctx)!;
  useImperativeHandle(ref, () => ({
    // maplibre reads every key it is given: `padding: undefined` crashes flyTo inside isPaddingEqual, so only pass
    // what is set. Camera moves are cosmetic, so a bad one is logged and skipped rather than taking the screen down.
    flyTo: o => safe('flyTo', () => map.flyTo(defined({ center: o.center, zoom: o.zoom, padding: padding(o.padding), duration: o.duration }))),
    fitBounds: (b, o) => safe('fitBounds', () => {
      if (!b.every(Number.isFinite)) return;
      // maplibre refuses (and logs) when the padding leaves no room, e.g. a short desktop window.
      const c = map.getContainer(), p = padding(o?.padding);
      const room = !p || (c.clientWidth - p.left - p.right > 40 && c.clientHeight - p.top - p.bottom > 40);
      map.fitBounds([[b[0], b[1]], [b[2], b[3]]], defined({ padding: room ? p : 40, duration: o?.duration, maxZoom: 15 }));
    }),
  }), [map]);
  useEffect(() => { if (initialViewState) safe('jumpTo', () => map.jumpTo(defined({ center: initialViewState.center, zoom: initialViewState.zoom }))); }, [map]);
  const first = useRef(true);
  useEffect(() => {
    if (!center) return;
    safe('move', () => { if (first.current) map.jumpTo(defined({ center, zoom })); else map.easeTo(defined({ center, zoom, duration })); });
    first.current = false;
  }, [map, center?.[0], center?.[1], zoom]);
  return null;
}

/** A DOM marker; its children (React Native views) render into it through a portal. */
export function Marker({ lngLat, anchor = 'center', onPress, children }: {
  lngLat: LngLat; anchor?: maplibregl.PositionAnchor; onPress?: () => void; children?: React.ReactNode;
}) {
  const map = useContext(Ctx)!;
  const [el] = useState(() => document.createElement('div'));
  const mk = useRef<maplibregl.Marker | null>(null);
  const press = useRef(onPress);
  useEffect(() => { press.current = onPress; });
  const ok = Number.isFinite(lngLat[0]) && Number.isFinite(lngLat[1]);   // setLngLat throws on NaN/undefined
  useEffect(() => {
    if (!ok) return;
    const m = mk.current = new gl!.Marker({ element: el, anchor }).setLngLat(lngLat).addTo(map);
    const node = m.getElement();
    const click = (e: MouseEvent) => { if (!press.current) return; e.stopPropagation(); press.current(); };
    node.style.cursor = press.current ? 'pointer' : '';
    node.addEventListener('click', click);
    return () => { node.removeEventListener('click', click); m.remove(); mk.current = null; };
  }, [map, anchor, ok]);
  useEffect(() => { if (ok) mk.current?.setLngLat(lngLat); }, [lngLat[0], lngLat[1]]);
  return createPortal(children, el);
}
export const ViewAnnotation = Marker;

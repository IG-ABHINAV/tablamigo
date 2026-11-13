// The smallest tap target a finger hits reliably (Apple HIG: 44pt). react-native-web ignores hitSlop, so on the web an icon
// button gets a real 44pt box, with negative margins that keep its footprint in the layout what it was before (the icon plus
// the padding it had), so nothing around it moves. Used by IconButton (components/ui.tsx).
export const MIN_TAP = 44;
export type Edge = 'left' | 'right' | 'none';

/** The web style for an icon of `size` that had `pad` padding: a box of at least 44 with the icon where it was. 'left' / 'right':
 *  the button ends its row, so the box grows into the row's padding on that side; 'none' pulls both sides back to the old
 *  footprint. */
export function webTapBox(size: number, pad = 0, edge: Edge = 'left') {
  const footprint = size + 2 * pad, box = Math.max(MIN_TAP, footprint), pull = (box - footprint) / 2 || 0;
  return {
    width: box, height: box, alignItems: 'center' as const, justifyContent: 'center' as const, marginVertical: pull ? -pull : 0,
    ...(edge === 'left' ? { marginLeft: -pull } : edge === 'right' ? { marginRight: -pull } : { marginHorizontal: -pull }),
  };
}

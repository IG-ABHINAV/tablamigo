// Safe-area edges for screens with a text field. While the on-screen keyboard is up it covers the home indicator, so the
// bottom inset would only leave a gap between the composer and the keyboard (web: lib/viewport.web.ts; native: never).
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useKeyboardOpen } from './viewport';
import { edgesFor, type Edge } from './viewport-fit';

export { edgesFor, type Edge };
const ALL: readonly Edge[] = ['top', 'right', 'bottom', 'left'];

/** For SafeAreaView's edges prop. Defaults to all four, like SafeAreaView itself. */
export const useSafeEdges = (edges: readonly Edge[] = ALL) => edgesFor(edges, useKeyboardOpen());

/** insets.bottom, or 0 while the keyboard is up. For sheets that pad themselves. */
export function useBottomInset() {
  const insets = useSafeAreaInsets();
  return useKeyboardOpen() ? 0 : insets.bottom;
}

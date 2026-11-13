import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { C, R } from '../lib/theme';

/**
 * Last line of defence: a render or effect crash anywhere below shows "Something went wrong" with a Reload button
 * instead of unmounting the whole app (a blank white page on the web). System fonts only, since it may be showing
 * because something around the app failed.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('App crashed', error, info.componentStack);
  }

  reload = () => {
    // The web loads the app afresh from its start page: once the tree has unmounted the router can leave the address
    // bar on an unrelated screen, and the screen that crashed may crash again. Native remounts the tree.
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.location.assign(window.location.pathname.startsWith('/app') ? '/app/' : '/');
    else this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12, backgroundColor: '#fff' }}>
        <Text style={{ fontSize: 44 }}>🙈</Text>
        <Text style={{ fontSize: 22, fontWeight: '800', color: C.ink, textAlign: 'center' }}>Something went wrong</Text>
        <Text style={{ fontSize: 15, lineHeight: 21, color: C.ink2, textAlign: 'center', maxWidth: 320 }}>
          Sorry about that. Reload to pick up where you left off.
        </Text>
        <Pressable onPress={this.reload} accessibilityRole="button"
          style={({ pressed }) => ({ marginTop: 8, height: 50, paddingHorizontal: 36, borderRadius: R.pill, backgroundColor: C.primary, alignItems: 'center', justifyContent: 'center', opacity: pressed ? 0.85 : 1 })}>
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Reload</Text>
        </Pressable>
      </View>
    );
  }
}

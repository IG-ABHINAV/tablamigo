import React from 'react';
import { Linking, View } from 'react-native';
import { router } from 'expo-router';
import { Modal } from './Modal';
import { T, Muted, Button } from './ui';
import { adsNoticeCopy } from '../lib/ads-notice';
import { PRIVACY_URL } from '../lib/legal';
import { C, F, R } from '../lib/theme';

/** The one-time notice before the first ad (lib/ads-notice.ts). Nothing about ads starts until it is closed. */
export function AdsNotice({ visible, onDone, createdAt }: { visible: boolean; onDone: () => void; createdAt?: string | null }) {
  const ADS_NOTICE = adsNoticeCopy(createdAt);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDone} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: 'rgba(22,22,29,0.45)', justifyContent: 'center', padding: 24 }}>
        <View accessibilityViewIsModal style={{ backgroundColor: '#fff', borderRadius: R.xl, padding: 22, gap: 12 }}>
          <T accessibilityRole="header" style={{ fontFamily: F.xb, fontSize: 20, lineHeight: 26 }}>{ADS_NOTICE.title}</T>
          <T style={{ fontSize: 15, lineHeight: 22, color: C.ink }}>{ADS_NOTICE.body}</T>
          <Muted style={{ fontSize: 13, lineHeight: 19 }}>{ADS_NOTICE.privacy}{' '}
            <T accessibilityRole="link" onPress={() => Linking.openURL(PRIVACY_URL)} style={{ fontSize: 13, color: C.primary, textDecorationLine: 'underline' }}>Privacy Policy</T>
          </Muted>
          <Button title="OK" onPress={onDone} style={{ marginTop: 6 }} />
          <Button title="No ads with Plus" kind="ghost" onPress={() => { onDone(); router.push('/paywall?reason=ads' as any); }} />
        </View>
      </View>
    </Modal>
  );
}

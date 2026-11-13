import React from 'react';
import { Pressable, View } from 'react-native';
import { Modal } from './Modal';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { C, R } from '../lib/theme';

/** A slide-up modal sheet, same look as the report sheet. */
export function ModalSheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: C.overlay }} onPress={onClose} />
      <View style={{ backgroundColor: C.bg, borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, padding: 20, paddingBottom: 20 + insets.bottom, gap: 4, maxHeight: '80%' }}>
        <View style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: C.line, marginBottom: 12 }} />
        {children}
      </View>
    </Modal>
  );
}

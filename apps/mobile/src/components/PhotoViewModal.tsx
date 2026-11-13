import React from 'react';
import { Dimensions, Pressable, View, StyleSheet } from 'react-native';
import { Modal } from './Modal';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T, Muted, Button } from './ui';
import { C, F, R } from '../lib/theme';

interface PhotoViewModalProps {
  visible: boolean;
  photoUrl?: string | null;
  title?: string;
  subtitle?: string;
  isMain?: boolean;
  onClose: () => void;
  onChangePhoto?: () => void;
  onSetMain?: () => void;
  onDeletePhoto?: () => void;
  busy?: boolean;
}

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export function PhotoViewModal({
  visible,
  photoUrl,
  title = 'Profile Photo',
  subtitle,
  isMain = false,
  onClose,
  onChangePhoto,
  onSetMain,
  onDeletePhoto,
  busy = false,
}: PhotoViewModalProps) {
  const insets = useSafeAreaInsets();
  if (!photoUrl) return null;

  const imageSize = Math.min(SCREEN_WIDTH - 48, 380);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        {/* Tap backdrop to close */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />

        {/* Top bar with close button */}
        <View style={[styles.topBar, { paddingTop: Math.max(insets.top + 12, 24) }]}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <T style={styles.titleText}>{title}</T>
            {subtitle ? <Muted style={styles.subtitleText}>{subtitle}</Muted> : null}
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={14}
            style={styles.closeBtn}
            accessibilityLabel="Close photo preview"
          >
            <Ionicons name="close" size={24} color="#fff" />
          </Pressable>
        </View>

        {/* Big Pop-Out Image Container */}
        <View style={styles.contentContainer}>
          <View style={[styles.imageWrapper, { width: imageSize, height: imageSize }]}>
            <Image
              source={{ uri: photoUrl }}
              style={styles.image}
              contentFit="cover"
              transition={200}
            />
            {isMain ? (
              <View style={styles.mainBadge}>
                <Ionicons name="star" size={13} color="#F59E0B" />
                <T style={styles.mainBadgeText}>MAIN PHOTO</T>
              </View>
            ) : null}
          </View>

          {/* Action buttons */}
          {(onChangePhoto || onSetMain || onDeletePhoto) ? (
            <View style={[styles.actionsCard, { width: imageSize }]}>
              {onChangePhoto ? (
                <Button
                  title="Change photo"
                  kind="primary"
                  loading={busy}
                  icon={<Ionicons name="camera" size={18} color="#fff" />}
                  onPress={onChangePhoto}
                />
              ) : null}

              {onSetMain ? (
                <Button
                  title="Set as main photo"
                  kind="primary"
                  loading={busy}
                  icon={<Ionicons name="star" size={18} color="#fff" />}
                  onPress={onSetMain}
                />
              ) : null}

              {onDeletePhoto ? (
                <Button
                  title="Delete photo"
                  kind="soft"
                  loading={busy}
                  icon={<Ionicons name="trash-outline" size={18} color={C.danger} />}
                  style={{ backgroundColor: '#FEE2E2', borderWidth: 1, borderColor: '#FCA5A5' }}
                  onPress={onDeletePhoto}
                />
              ) : null}

              <Button
                title="Close"
                kind="ghost"
                disabled={busy}
                style={{ backgroundColor: '#FFFFFF', borderWidth: 0 }}
                onPress={onClose}
              />
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(10, 10, 14, 0.94)',
    justifyContent: 'space-between',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingBottom: 12,
    zIndex: 10,
  },
  titleText: {
    fontFamily: F.b,
    fontSize: 18,
    color: '#fff',
  },
  subtitleText: {
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.7)',
    marginTop: 2,
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  contentContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingBottom: 24,
    gap: 18,
  },
  imageWrapper: {
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#1E1E24',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.5,
    shadowRadius: 24,
    elevation: 12,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  mainBadge: {
    position: 'absolute',
    top: 12,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: R.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  mainBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontFamily: F.b,
    letterSpacing: 0.5,
  },
  actionsCard: {
    gap: 10,
  },
});

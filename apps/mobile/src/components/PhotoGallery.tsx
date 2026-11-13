import React, { useState } from 'react';
import { View, Image, Dimensions, ScrollView, NativeSyntheticEvent, NativeScrollEvent, StyleSheet, Pressable } from 'react-native';
import { Avatar } from './ui';
import { PhotoViewer } from './PhotoViewer';
import { C, R } from '../lib/theme';

interface PhotoItem {
  id: string;
  url: string;
  position: number;
}

interface PhotoGalleryProps {
  photos?: PhotoItem[];
  fallbackPhotoUrl?: string | null;
  name: string;
  size?: number;
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export function PhotoGallery({ photos, fallbackPhotoUrl, name, size = 130 }: PhotoGalleryProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [viewing, setViewing] = useState<number | null>(null);

  // If no gallery or only 1 photo, render standard circular Avatar with tap-to-expand
  const list = photos && photos.length > 0
    ? photos
    : fallbackPhotoUrl
      ? [{ id: 'main', url: fallbackPhotoUrl, position: 0 }]
      : [];

  const singleUrl = list[0]?.url ?? fallbackPhotoUrl;
  // Already on this person's profile, so the viewer names them without linking back to it.
  const viewer = (
    <PhotoViewer photos={list.map(p => ({ id: p.id, url: p.url, authorName: name }))} index={viewing} onClose={() => setViewing(null)} />
  );

  if (list.length <= 1) {
    return (
      <View style={{ alignItems: 'center' }}>
        <Pressable accessibilityRole="imagebutton" accessibilityLabel={`Open ${name}'s photo`} onPress={() => singleUrl && setViewing(0)}>
          <Avatar uri={singleUrl} name={name} size={size} />
        </Pressable>
        {viewer}
      </View>
    );
  }

  const cardWidth = Math.min(SCREEN_WIDTH - 48, 360);
  const cardHeight = Math.round(cardWidth * 1.15);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / cardWidth);
    if (idx !== activeIndex && idx >= 0 && idx < list.length) {
      setActiveIndex(idx);
    }
  };

  return (
    <View style={[styles.container, { width: cardWidth }]}>
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        style={{ width: cardWidth, height: cardHeight, borderRadius: R.lg }}
      >
        {list.map((item, i) => (
          <Pressable
            key={item.id || String(i)}
            accessibilityRole="imagebutton"
            accessibilityLabel={`Open ${name}'s photo ${i + 1}`}
            onPress={() => setViewing(i)}
            style={{ width: cardWidth, height: cardHeight, borderRadius: R.lg, overflow: 'hidden', backgroundColor: C.bgSoft }}
          >
            <Image
              source={{ uri: item.url }}
              style={{ width: cardWidth, height: cardHeight }}
              resizeMode="cover"
            />
          </Pressable>
        ))}
      </ScrollView>

      {/* Pagination dots */}
      <View style={styles.pagination}>
        {list.map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              i === activeIndex ? styles.activeDot : styles.inactiveDot
            ]}
          />
        ))}
      </View>

      {viewer}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 4,
  },
  pagination: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
  },
  dot: {
    height: 6,
    borderRadius: 3,
  },
  activeDot: {
    width: 20,
    backgroundColor: C.primary,
  },
  inactiveDot: {
    width: 6,
    backgroundColor: C.line,
  },
});

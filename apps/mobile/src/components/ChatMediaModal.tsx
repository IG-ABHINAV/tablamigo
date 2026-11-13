import React from 'react';
import { Dimensions, FlatList, Pressable, View, ActivityIndicator } from 'react-native';
import { Modal } from './Modal';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { SafeAreaView } from 'react-native-safe-area-context';
import { T, Muted, Empty } from './ui';
import { api } from '../lib/api';
import { C, F, R } from '../lib/theme';

const { width } = Dimensions.get('window');
const ITEM_SIZE = (width - 48) / 3;

export function ChatMediaModal({
  chatId,
  visible,
  onClose,
  onSelectImage
}: {
  chatId: string;
  visible: boolean;
  onClose: () => void;
  onSelectImage?: (url: string) => void;
}) {
  const q = useQuery({
    queryKey: ['chat-media', chatId],
    queryFn: () => api<{ media: Array<{ id: string; url: string; createdAt: string; senderName?: string }> }>(`/chats/${chatId}/media`),
    enabled: visible
  });

  const media = q.data?.media ?? [];

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <View>
            <T style={{ fontFamily: F.b, fontSize: 18 }}>Media Gallery</T>
            <Muted style={{ fontSize: 13 }}>{media.length} photos shared</Muted>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={12} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center' }}>
            <Ionicons name="close" size={22} color={C.ink} />
          </Pressable>
        </View>

        {q.isLoading ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={C.primary} />
        ) : (
          <FlatList
            data={media}
            keyExtractor={item => item.id}
            numColumns={3}
            contentContainerStyle={{ padding: 16, gap: 8 }}
            columnWrapperStyle={{ gap: 8 }}
            ListEmptyComponent={
              <Empty emoji="📷" title="No photos yet" body="Photos shared in this chat will appear here." />
            }
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  onSelectImage?.(item.url);
                  onClose();
                }}
                style={{ width: ITEM_SIZE, height: ITEM_SIZE, borderRadius: R.md, overflow: 'hidden', backgroundColor: C.bgSoft }}
              >
                <Image source={{ uri: item.url }} style={{ width: '100%', height: '100%' }} contentFit="cover" />
              </Pressable>
            )}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

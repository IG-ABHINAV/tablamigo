import React, { useState } from 'react';
import { FlatList, Pressable, TextInput, View, ActivityIndicator } from 'react-native';
import { Modal } from './Modal';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSafeEdges } from '../lib/safe-edges';
import { T, Muted, Empty } from './ui';
import { api } from '../lib/api';
import { C, F, R } from '../lib/theme';

export function ChatSearchModal({
  chatId,
  visible,
  onClose,
  onSelectMessage
}: {
  chatId: string;
  visible: boolean;
  onClose: () => void;
  onSelectMessage: (messageId: string) => void;
}) {
  const safeEdges = useSafeEdges(['top', 'bottom']);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const search = async (text: string) => {
    setQ(text);
    if (text.trim().length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      const res = await api<{ results: any[] }>(`/chats/${chatId}/search?q=${encodeURIComponent(text.trim())}`);
      setResults(res.results ?? []);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={safeEdges}>
        {/* Search Bar Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 44, backgroundColor: C.bgSoft, borderRadius: R.pill, paddingHorizontal: 14 }}>
            <Ionicons name="search" size={18} color={C.ink3} />
            <TextInput
              value={q}
              onChangeText={search}
              placeholder="Search in conversation…"
              placeholderTextColor={C.ink3}
              autoFocus
              returnKeyType="search"
              style={{ flex: 1, fontFamily: F.m, fontSize: 15, color: C.ink }}
            />
            {q.length > 0 ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => search('')} hitSlop={10}>
                <Ionicons name="close-circle" size={18} color={C.ink3} />
              </Pressable>
            ) : null}
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={{ paddingHorizontal: 6 }}>
            <T style={{ fontFamily: F.b, color: C.primary, fontSize: 16 }}>Cancel</T>
          </Pressable>
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 30 }} color={C.primary} />
        ) : (
          <FlatList
            data={results}
            keyExtractor={item => item.id}
            contentContainerStyle={{ padding: 16, gap: 10 }}
            ListEmptyComponent={
              q.trim().length >= 2 ? (
                <Empty emoji="🔍" title="No messages found" body={`No matching messages for "${q}".`} />
              ) : (
                <Empty emoji="💬" title="Search conversation" body="Type at least 2 characters to search messages." />
              )
            }
            renderItem={({ item }) => (
              <Pressable
                onPress={() => {
                  onSelectMessage(item.id);
                  onClose();
                }}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? C.bgSoft : '#fff',
                  borderWidth: 1,
                  borderColor: C.line,
                  borderRadius: R.md,
                  padding: 14,
                  gap: 4
                })}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <T style={{ fontFamily: F.b, fontSize: 14, color: C.primaryDark }}>{item.senderName ?? 'Someone'}</T>
                  <Muted style={{ fontSize: 11 }}>
                    {new Date(item.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}{' '}
                    {new Date(item.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </Muted>
                </View>
                <T numberOfLines={2} style={{ fontSize: 14, color: C.ink, lineHeight: 19 }}>
                  {item.body}
                </T>
              </Pressable>
            )}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

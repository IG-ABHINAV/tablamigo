import React, { useState } from 'react';
import { FlatList, Pressable, View, TextInput, Alert, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { ModalSheet } from './ModalSheet';
import { T, H2, Muted, Empty, Button } from './ui';
import { ActivityCard, type Activity } from './ActivityCard';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';
import { FEATURES } from '../lib/config';
import { C, F, R } from '../lib/theme';

export function SavedPlansSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['saved-activities'],
    queryFn: () => api('/activities/saved'),
    enabled: visible,
  });

  const toggleSave = useMutation({
    mutationFn: (id: string) => api(`/activities/${id}/save`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['saved-activities'] });
      queryClient.invalidateQueries({ queryKey: ['activities'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    },
  });

  const updateNotes = useMutation({
    mutationFn: ({ id, notes }: { id: string; notes: string }) =>
      api(`/activities/${id}/save/notes`, { method: 'PUT', body: { notes } }),
    onSuccess: () => {
      setEditingId(null);
      setNoteText('');
      queryClient.invalidateQueries({ queryKey: ['saved-activities'] });
    },
    onError: () => {
      Alert.alert('Could not save note', 'Please try again.');
    },
  });

  const syncBundle = useMutation({
    mutationFn: () => api('/activities/saved/offline-bundle'),
    onSuccess: (data) => {
      setSyncStatus(`Synced ${data.totalSaved ?? 0} saved & ${data.totalJoined ?? 0} joined meetups`);
      setTimeout(() => setSyncStatus(null), 3500);
    },
    onError: () => {
      Alert.alert('Offline sync failed', 'Check your connection and try again.');
    },
  });

  const savedList: Activity[] = q.data?.saved ?? [];

  const handleStartEdit = (item: any) => {
    setEditingId(item.id);
    setNoteText(item.savedNotes ?? '');
  };

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T style={{ fontSize: 22 }}>🔖</T>
          <H2>Saved Plans</H2>
          {savedList.length > 0 ? (
            <View style={{ backgroundColor: C.primarySoft, borderRadius: R.pill, paddingHorizontal: 8, paddingVertical: 2 }}>
              <T style={{ fontFamily: F.b, fontSize: 12, color: C.primaryDark }}>{savedList.length}</T>
            </View>
          ) : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={8} style={{ padding: 4 }}>
          <Ionicons name="close" size={24} color={C.ink2} />
        </Pressable>
      </View>

      {/* Offline sync action bar: hidden (FEATURES.offlinePack). Sync Pack only fetched the list and showed a toast. */}
      {FEATURES.offlinePack ? <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#F0FDF4', borderWidth: 1, borderColor: '#DCFCE7', borderRadius: R.md, paddingHorizontal: 12, paddingVertical: 8, marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
          <Ionicons name="cloud-done-outline" size={16} color="#16A34A" />
          <T style={{ fontSize: 12, color: '#15803D', fontFamily: F.m }}>
            {syncStatus ?? 'Offline cache active · Notes & emergency helplines ready'}
          </T>
        </View>
        <Pressable
          onPress={() => syncBundle.mutate()}
          hitSlop={6}
          disabled={syncBundle.isPending}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#DCFCE7', paddingHorizontal: 8, paddingVertical: 4, borderRadius: R.pill }}
        >
          {syncBundle.isPending ? (
            <ActivityIndicator size="small" color="#15803D" />
          ) : (
            <>
              <Ionicons name="sync" size={12} color="#15803D" />
              <T style={{ fontSize: 11, fontFamily: F.b, color: '#15803D' }}>Sync Pack</T>
            </>
          )}
        </Pressable>
      </View> : null}

      {savedList.length === 0 ? (
        <Empty
          emoji="🔖"
          title="No saved plans yet"
          body="Tap the bookmark icon on any meetup to save it for later."
          action={
            <Button
              title="Explore plans"
              onPress={() => {
                onClose();
                router.push('/(tabs)');
              }}
              style={{ marginTop: 12, paddingHorizontal: 24 }}
            />
          }
        />
      ) : (
        <FlatList
          data={savedList}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ gap: 12, paddingBottom: 24 }}
          style={{ maxHeight: 460 }}
          renderItem={({ item }) => {
            const isEditing = editingId === item.id;
            return (
              <View style={{ backgroundColor: '#fff', borderRadius: R.lg, borderWidth: 1, borderColor: C.line, overflow: 'hidden' }}>
                <View style={{ position: 'relative' }}>
                  <Pressable
                    onPress={() => {
                      onClose();
                      router.push(`/activity/${item.id}`);
                    }}
                  >
                    <ActivityCard a={item} compact />
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel="Remove from saved"
                    onPress={() => toggleSave.mutate(item.id)}
                    hitSlop={8}
                    style={{
                      position: 'absolute',
                      top: 12,
                      right: 12,
                      padding: 6,
                      borderRadius: R.pill,
                      backgroundColor: C.bgSoft,
                    }}
                  >
                    <Ionicons name="bookmark" size={18} color={C.primary} />
                  </Pressable>
                </View>

                {/* Personal private note card */}
                {isEditing ? (
                  <View style={{ padding: 12, backgroundColor: '#FFFDF5', borderTopWidth: 1, borderTopColor: '#FEF3C7', gap: 8 }}>
                    <T style={{ fontSize: 12, fontFamily: F.b, color: '#B45309' }}>Your private note</T>
                    <TextInput
                      value={noteText}
                      onChangeText={setNoteText}
                      placeholder="e.g. Bring extra camera battery, meet by fountain"
                      placeholderTextColor={C.ink3}
                      maxLength={500}
                      multiline
                      style={{
                        backgroundColor: '#fff',
                        borderWidth: 1,
                        borderColor: '#FDE68A',
                        borderRadius: R.md,
                        padding: 8,
                        fontSize: 13,
                        color: C.ink,
                        minHeight: 54,
                      }}
                    />
                    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                      <Pressable
                        onPress={() => setEditingId(null)}
                        style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: R.md, backgroundColor: C.bgSoft }}
                      >
                        <T style={{ fontSize: 12, fontFamily: F.sb, color: C.ink2 }}>Cancel</T>
                      </Pressable>
                      <Pressable
                        onPress={() => updateNotes.mutate({ id: item.id, notes: noteText })}
                        disabled={updateNotes.isPending}
                        style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: R.md, backgroundColor: C.primary }}
                      >
                        <T style={{ fontSize: 12, fontFamily: F.b, color: '#fff' }}>
                          {updateNotes.isPending ? 'Saving…' : 'Save Note'}
                        </T>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <View style={{ paddingHorizontal: 14, paddingVertical: 8, backgroundColor: item.savedNotes ? '#FFFBEB' : '#F9FAFB', borderTopWidth: 1, borderTopColor: C.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, marginRight: 8 }}>
                      <Ionicons name="document-text-outline" size={14} color={item.savedNotes ? '#D97706' : C.ink3} />
                      <T numberOfLines={1} style={{ fontSize: 12, color: item.savedNotes ? '#92400E' : C.ink3, fontStyle: item.savedNotes ? 'normal' : 'italic' }}>
                        {item.savedNotes ? item.savedNotes : 'No personal note added yet'}
                      </T>
                    </View>
                    <Pressable onPress={() => handleStartEdit(item)} hitSlop={6}>
                      <T style={{ fontSize: 12, fontFamily: F.b, color: C.primaryDark }}>
                        {item.savedNotes ? 'Edit' : '+ Add Note'}
                      </T>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          }}
        />
      )}
    </ModalSheet>
  );
}

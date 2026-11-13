import React, { useState } from 'react';
import { View, Pressable, TextInput, Alert, StyleSheet } from 'react-native';
import { Modal } from './Modal';
import { Ionicons } from '@expo/vector-icons';
import { T, H2, Muted, Button } from './ui';
import { C, F, R } from '../lib/theme';
import { api } from '../lib/api';
import { queryClient } from '../lib/query';

export interface PromptItem {
  id: string;
  prompt: string;
  answer: string;
  position: number;
}

export const PROMPTS_LIST = [
  "Next trip I'm dreaming of…",
  "My ideal day on a trip…",
  "Best street food I've had…",
  "A travel rule I live by…",
  "I'm the friend who always…",
  "My craziest travel story…",
  "My favorite hidden gem…",
  "Ask me about…"
];

/** Read-only display of profile prompts on user profile */
export function ProfilePromptsView({ prompts }: { prompts?: PromptItem[] }) {
  if (!prompts || prompts.length === 0) return null;

  return (
    <View style={{ width: '100%', gap: 12, marginTop: 4 }}>
      {prompts.map(p => (
        <View key={p.id} style={styles.promptCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <Ionicons name="chatbubble-ellipses-outline" size={16} color={C.primary} />
            <T style={{ fontFamily: F.b, fontSize: 13, color: C.primaryDark }}>{p.prompt}</T>
          </View>
          <T style={{ fontSize: 16, lineHeight: 23, color: C.ink, fontFamily: F.m }}>{p.answer}</T>
        </View>
      ))}
    </View>
  );
}

/** Interactive editor for managing your 3 profile prompts */
export function ProfilePromptsEdit({ prompts }: { prompts?: PromptItem[] }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedPrompt, setSelectedPrompt] = useState<string>(PROMPTS_LIST[0]);
  const [answer, setAnswer] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const list = prompts ?? [];
  const answeredPrompts = new Set(list.map(p => p.prompt));
  const availablePrompts = PROMPTS_LIST.filter(p => !answeredPrompts.has(p) || p === selectedPrompt);

  const openNew = () => {
    const firstAvailable = PROMPTS_LIST.find(p => !answeredPrompts.has(p)) ?? PROMPTS_LIST[0];
    setSelectedPrompt(firstAvailable);
    setAnswer('');
    setEditingId(null);
    setModalOpen(true);
  };

  const openEdit = (item: PromptItem) => {
    setSelectedPrompt(item.prompt);
    setAnswer(item.answer);
    setEditingId(item.id);
    setModalOpen(true);
  };

  const save = async () => {
    if (!answer.trim()) return;
    setLoading(true);
    try {
      await api('/me/prompts', {
        method: 'POST',
        body: { prompt: selectedPrompt, answer: answer.trim() }
      });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      setModalOpen(false);
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Could not save prompt.');
    } finally {
      setLoading(false);
    }
  };

  const del = (item: PromptItem) => {
    Alert.alert('Remove prompt?', `Delete "${item.prompt}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await api(`/me/prompts/${item.id}`, { method: 'DELETE' });
          await queryClient.invalidateQueries({ queryKey: ['me'] });
        }
      }
    ]);
  };

  return (
    <View style={{ gap: 10 }}>
      {list.map(p => (
        <View key={p.id} style={[styles.promptCard, { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }]}>
          <Pressable onPress={() => openEdit(p)} style={{ flex: 1, paddingRight: 10 }}>
            <T style={{ fontFamily: F.b, fontSize: 13, color: C.primaryDark, marginBottom: 4 }}>{p.prompt}</T>
            <T style={{ fontSize: 15, lineHeight: 21, color: C.ink }}>{p.answer}</T>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Delete" onPress={() => del(p)} hitSlop={10} style={{ padding: 4 }}>
            <Ionicons name="trash-outline" size={18} color={C.ink3} />
          </Pressable>
        </View>
      ))}

      {list.length < 3 ? (
        <Pressable
          onPress={openNew}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            paddingVertical: 12,
            borderRadius: R.md,
            borderWidth: 1.5,
            borderColor: C.line,
            borderStyle: 'dashed',
            backgroundColor: C.bgSoft
          }}
        >
          <Ionicons name="add-circle-outline" size={20} color={C.primary} />
          <T style={{ fontFamily: F.b, color: C.primary, fontSize: 14 }}>
            Add conversation starter ({list.length}/3)
          </T>
        </Pressable>
      ) : null}

      {/* Modal Editor */}
      <Modal visible={modalOpen} transparent animationType="slide" onRequestClose={() => setModalOpen(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <H2>{editingId ? 'Edit Prompt' : 'Select Prompt'}</H2>
              <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={() => setModalOpen(false)} hitSlop={10}>
                <Ionicons name="close" size={24} color={C.ink} />
              </Pressable>
            </View>

            {/* Prompt Picker */}
            <Muted style={{ fontSize: 13, marginBottom: 6 }}>Pick a question:</Muted>
            <View style={{ maxHeight: 160, marginBottom: 14 }}>
              {availablePrompts.map(p => (
                <Pressable
                  key={p}
                  onPress={() => setSelectedPrompt(p)}
                  style={{
                    paddingVertical: 8,
                    paddingHorizontal: 12,
                    borderRadius: R.sm,
                    backgroundColor: selectedPrompt === p ? C.primarySoft : '#fff',
                    marginBottom: 4
                  }}
                >
                  <T style={{ fontFamily: selectedPrompt === p ? F.b : F.m, color: selectedPrompt === p ? C.primaryDark : C.ink, fontSize: 14 }}>
                    {p}
                  </T>
                </Pressable>
              ))}
            </View>

            <Muted style={{ fontSize: 13, marginBottom: 6 }}>Your answer (up to 250 characters):</Muted>
            <TextInput
              value={answer}
              onChangeText={setAnswer}
              multiline
              maxLength={250}
              placeholder="Write something memorable..."
              placeholderTextColor={C.ink3}
              style={styles.textInput}
            />
            <View style={{ alignItems: 'flex-end', marginTop: 4, marginBottom: 16 }}>
              <Muted style={{ fontSize: 11 }}>{answer.length}/250</Muted>
            </View>

            <Button
              title={editingId ? 'Save prompt' : 'Add to profile'}
              kind="dark"
              loading={loading}
              disabled={!answer.trim()}
              onPress={save}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  promptCard: {
    padding: 14,
    borderRadius: R.md,
    backgroundColor: C.bgSoft,
    borderLeftWidth: 3,
    borderLeftColor: C.primary,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderTopLeftRadius: R.xl,
    borderTopRightRadius: R.xl,
    padding: 22,
    paddingBottom: 40,
    maxHeight: '85%',
  },
  textInput: {
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: R.md,
    padding: 12,
    minHeight: 80,
    textAlignVertical: 'top',
    fontSize: 15,
    color: C.ink,
    fontFamily: F.m,
  },
});

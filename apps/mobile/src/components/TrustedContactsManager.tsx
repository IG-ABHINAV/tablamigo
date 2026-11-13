import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, TextInput, View, ActivityIndicator } from 'react-native';
import { Modal } from './Modal';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useMutation } from '@tanstack/react-query';
import { router } from 'expo-router';
import { T, H2, Muted, Button } from './ui';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query';
import { C, F, R, shadow } from '../lib/theme';

export type TrustedContact = {
  id: string;
  name: string;
  phone: string;
  relationship: 'parent' | 'partner' | 'friend' | 'sibling' | 'family' | 'other';
  notifyOnPlanJoin: boolean;
  createdAt: string;
};

const RELATIONSHIPS: Array<{ key: TrustedContact['relationship']; label: string; icon: string }> = [
  { key: 'parent', label: 'Parent', icon: '👨‍👩‍👧' },
  { key: 'partner', label: 'Partner', icon: '❤️' },
  { key: 'friend', label: 'Friend', icon: '🤝' },
  { key: 'sibling', label: 'Sibling', icon: '👫' },
  { key: 'family', label: 'Family', icon: '🏡' },
  { key: 'other', label: 'Other', icon: '🌟' }
];

export function TrustedContactsManager({
  visible,
  onClose
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState<TrustedContact['relationship']>('friend');

  const q = useQuery({
    queryKey: ['trusted-contacts'],
    queryFn: () => api<{ contacts: TrustedContact[]; limit: number; remaining: number }>('/safety/contacts'),
    enabled: visible
  });

  const addContact = useMutation({
    mutationFn: () => api('/safety/contacts', {
      method: 'POST',
      body: { name: name.trim(), phone: phone.trim(), relationship }
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trusted-contacts'] });
      setName('');
      setPhone('');
      setShowAddForm(false);
    },
    onError: (e: any) => {
      if (e instanceof ApiError && e.code === 'plus_required') {
        router.push('/paywall?reason=trusted_contacts_limit');
      } else {
        Alert.alert('Could not add contact', e instanceof ApiError ? e.message : 'Please check details.');
      }
    }
  });

  const deleteContact = useMutation({
    mutationFn: (id: string) => api(`/safety/contacts/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['trusted-contacts'] });
    },
    onError: (e: any) => {
      Alert.alert('Error', e instanceof ApiError ? e.message : 'Could not delete contact.');
    }
  });

  const contacts = q.data?.contacts ?? [];
  const limit = q.data?.limit ?? 2;
  const isAtLimit = contacts.length >= limit;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.bgSoft }}>
        {/* Header */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: '#fff' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: '#ECFDF5', alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name="shield-checkmark" size={20} color="#059669" />
            </View>
            <View>
              <T style={{ fontFamily: F.b, fontSize: 18 }}>Trusted Contacts</T>
              <Muted style={{ fontSize: 12 }}>Safety & Emergency Network</Muted>
            </View>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={12}>
            <Ionicons name="close" size={24} color={C.ink} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 60 }}>
          {/* Explanation Banner */}
          <View style={[{ backgroundColor: '#fff', borderRadius: R.lg, padding: 16, gap: 8 }, shadow]}>
            <T style={{ fontFamily: F.b, fontSize: 15 }}>🛡️ How Trusted Contacts Work</T>
            <T style={{ fontSize: 13, color: C.ink2, lineHeight: 19 }}>
              When you join or host meetups in unfamiliar cities, you can share a safety link for the plan with your trusted contacts in one tap. If you ever press SOS, a message with your location is ready for each contact, for you to send. Tablamigo does not message them for you.
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.line }}>
              <T style={{ fontSize: 12, fontFamily: F.sb, color: C.ink }}>
                {contacts.length} / {limit} contacts used
              </T>
              {limit <= 2 ? (
                <Pressable onPress={() => router.push('/paywall?reason=trusted_contacts_limit')}>
                  <T style={{ fontSize: 12, fontFamily: F.b, color: C.primaryDark }}>Add up to 5 with Plus →</T>
                </Pressable>
              ) : null}
            </View>
          </View>

          {/* List of Contacts */}
          {q.isLoading ? (
            <ActivityIndicator style={{ paddingVertical: 20 }} color={C.primary} />
          ) : contacts.length > 0 ? (
            <View style={{ gap: 10 }}>
              <T style={{ fontFamily: F.b, fontSize: 16 }}>Saved Contacts ({contacts.length})</T>
              {contacts.map(c => {
                const rel = RELATIONSHIPS.find(r => r.key === c.relationship) ?? { label: 'Contact', icon: '👤' };
                return (
                  <View
                    key={c.id}
                    style={[{ backgroundColor: '#fff', borderRadius: R.lg, padding: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: C.line }, shadow]}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
                      <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.bgSoft, alignItems: 'center', justifyContent: 'center' }}>
                        <T style={{ fontSize: 20 }}>{rel.icon}</T>
                      </View>
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <T style={{ fontFamily: F.b, fontSize: 15 }}>{c.name}</T>
                          <View style={{ backgroundColor: C.primarySoft, paddingHorizontal: 6, paddingVertical: 2, borderRadius: R.pill }}>
                            <T style={{ fontSize: 10, fontFamily: F.b, color: C.primaryDark }}>{rel.label}</T>
                          </View>
                        </View>
                        <Muted style={{ fontSize: 13, marginTop: 2 }}>{c.phone}</Muted>
                      </View>
                    </View>
                    <Pressable accessibilityRole="button" accessibilityLabel="Delete"
                      onPress={() => Alert.alert('Remove Contact?', `Remove ${c.name} from trusted safety contacts?`, [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Remove', style: 'destructive', onPress: () => deleteContact.mutate(c.id) }
                      ])}
                      hitSlop={12}
                      style={{ padding: 8 }}
                    >
                      <Ionicons name="trash-outline" size={20} color={C.danger} />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          ) : (
            <View style={{ padding: 24, backgroundColor: '#fff', borderRadius: R.lg, alignItems: 'center', gap: 10 }}>
              <T style={{ fontSize: 32 }}>👨‍👩‍👧</T>
              <T style={{ fontFamily: F.b, fontSize: 16 }}>No Trusted Contacts Added Yet</T>
              <Muted style={{ textAlign: 'center', fontSize: 13, lineHeight: 18 }}>
                Add a family member, partner, or close friend so you can alert them in one tap when you need help.
              </Muted>
            </View>
          )}

          {/* Add Contact Form */}
          {showAddForm ? (
            <View style={[{ backgroundColor: '#fff', borderRadius: R.lg, padding: 18, gap: 14, borderWidth: 1, borderColor: C.line }, shadow]}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <T style={{ fontFamily: F.b, fontSize: 16 }}>Add Trusted Contact</T>
                <Pressable onPress={() => setShowAddForm(false)}>
                  <T style={{ color: C.ink2, fontSize: 13, fontFamily: F.sb }}>Cancel</T>
                </Pressable>
              </View>

              <View style={{ gap: 6 }}>
                <T style={{ fontSize: 13, fontFamily: F.sb }}>Full Name</T>
                <TextInput
                  value={name}
                  onChangeText={setName}
                  placeholder="e.g. Mom, Alex Sharma"
                  placeholderTextColor={C.ink3}
                  style={{ backgroundColor: C.bgSoft, borderRadius: R.md, padding: 12, fontSize: 15, color: C.ink, fontFamily: F.r }}
                />
              </View>

              <View style={{ gap: 6 }}>
                <T style={{ fontSize: 13, fontFamily: F.sb }}>Phone / WhatsApp Number</T>
                <TextInput
                  value={phone}
                  onChangeText={setPhone}
                  placeholder="e.g. +91 98200 12345"
                  placeholderTextColor={C.ink3}
                  keyboardType="phone-pad"
                  style={{ backgroundColor: C.bgSoft, borderRadius: R.md, padding: 12, fontSize: 15, color: C.ink, fontFamily: F.r }}
                />
              </View>

              <View style={{ gap: 6 }}>
                <T style={{ fontSize: 13, fontFamily: F.sb }}>Relationship</T>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {RELATIONSHIPS.map(r => (
                    <Pressable
                      key={r.key}
                      onPress={() => setRelationship(r.key)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: R.pill,
                        backgroundColor: relationship === r.key ? C.ink : C.bgSoft,
                        borderWidth: 1,
                        borderColor: relationship === r.key ? C.ink : C.line
                      }}
                    >
                      <T style={{ fontSize: 14 }}>{r.icon}</T>
                      <T style={{ fontSize: 13, fontFamily: F.sb, color: relationship === r.key ? '#fff' : C.ink }}>{r.label}</T>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>

              <Button
                title="Save Contact"
                kind="primary"
                loading={addContact.isPending}
                disabled={!name.trim() || phone.trim().length < 5}
                onPress={() => addContact.mutate()}
                style={{ marginTop: 6 }}
              />
            </View>
          ) : (
            <Button
              title={isAtLimit ? "Trusted Contacts Limit Reached" : "+ Add Trusted Contact"}
              kind={isAtLimit ? "ghost" : "primary"}
              disabled={isAtLimit}
              onPress={() => setShowAddForm(true)}
              icon={<Ionicons name="person-add" size={18} color={isAtLimit ? C.ink2 : '#fff'} />}
            />
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

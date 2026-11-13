import React from 'react';
import { View, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { Modal } from './Modal';
import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { C, F, R } from '../lib/theme';
import { T, Muted, Button } from './ui';
import { api } from '../lib/api';

export function MyTicketsModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const ticketsQ = useQuery({
    queryKey: ['my-tickets'],
    queryFn: () => api('/me/tickets'),
    enabled: visible,
  });

  const tickets = ticketsQ.data?.tickets ?? [];

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.overlay, justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: '#fff', borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, maxHeight: '85%', paddingBottom: 28 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <View>
              <T style={{ fontFamily: F.b, fontSize: 17, color: C.ink }}>My Event Tickets 🎟️</T>
              <Muted style={{ fontSize: 12 }}>Digital passes for tours and workshops</Muted>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={24} color={C.ink} />
            </Pressable>
          </View>

          {ticketsQ.isLoading ? (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <ActivityIndicator color={C.primary} size="large" />
            </View>
          ) : tickets.length === 0 ? (
            <View style={{ padding: 40, alignItems: 'center', gap: 10 }}>
              <T style={{ fontSize: 40 }}>🎟️</T>
              <T style={{ fontFamily: F.b, fontSize: 16, color: C.ink }}>No event tickets yet</T>
              <Muted style={{ textAlign: 'center', fontSize: 13, lineHeight: 19 }}>
                When you book tickets for food walks, surf lessons, or curated tours on Tablamigo, your digital entry passes will appear here.
              </Muted>
            </View>
          ) : (
            <ScrollView contentContainerStyle={{ padding: 20, gap: 14 }}>
              {tickets.map((t: any) => {
                const isUsed = t.status === 'used';
                return (
                  <View
                    key={t.id}
                    style={{
                      borderRadius: R.lg,
                      borderWidth: 1.5,
                      borderColor: isUsed ? C.line : '#FDE68A',
                      backgroundColor: isUsed ? C.bgSoft : '#FFFBEB',
                      padding: 16,
                      gap: 12,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                        <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
                          <T style={{ fontSize: 24 }}>{t.emoji || '✨'}</T>
                        </View>
                        <View style={{ flex: 1 }}>
                          <T style={{ fontFamily: F.b, fontSize: 15, color: isUsed ? C.ink : '#92400E' }} numberOfLines={1}>
                            {t.activityTitle}
                          </T>
                          <Muted style={{ fontSize: 12, marginTop: 2 }}>
                            📍 {t.placeName}, {t.city}
                          </Muted>
                        </View>
                      </View>
                      <View style={{ backgroundColor: isUsed ? C.line : '#059669', paddingHorizontal: 8, paddingVertical: 4, borderRadius: R.sm }}>
                        <T style={{ fontFamily: F.b, fontSize: 10, color: '#fff', textTransform: 'uppercase' }}>
                          {isUsed ? 'Redeemed' : 'Valid Pass'}
                        </T>
                      </View>
                    </View>

                    {/* Ticket Pass Banner */}
                    <View style={{ backgroundColor: '#fff', borderRadius: R.md, padding: 12, borderWidth: 1, borderColor: isUsed ? C.line : '#FCD34D', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <View>
                        <Muted style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Ticket Code</Muted>
                        <T style={{ fontFamily: F.xb, fontSize: 16, color: isUsed ? C.ink2 : '#D97706', letterSpacing: 0.5, marginTop: 2 }}>
                          {t.ticketCode}
                        </T>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Muted style={{ fontSize: 10 }}>Paid Amount</Muted>
                        <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink, marginTop: 2 }}>
                          ₹{Math.round(t.pricePaise / 100)}
                        </T>
                      </View>
                    </View>

                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <T style={{ fontSize: 12, color: C.ink2 }}>
                        🗓 {new Date(t.startsAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </T>
                      <Pressable
                        onPress={() => {
                          onClose();
                          router.push(`/activity/${t.activityId}`);
                        }}
                        hitSlop={8}
                      >
                        <T style={{ fontFamily: F.b, color: C.primary, fontSize: 13 }}>View Meetup →</T>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

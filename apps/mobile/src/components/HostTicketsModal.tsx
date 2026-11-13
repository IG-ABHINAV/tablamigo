import React from 'react';
import { View, Pressable, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { Modal } from './Modal';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { C, F, R, flag } from '../lib/theme';
import { T, Muted, Button, Avatar } from './ui';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query';

export function HostTicketsModal({
  activityId,
  activityTitle,
  visible,
  onClose,
}: {
  activityId: string;
  activityTitle: string;
  visible: boolean;
  onClose: () => void;
}) {
  const ticketsQ = useQuery({
    queryKey: ['activity-tickets', activityId],
    queryFn: () => api(`/activities/${activityId}/tickets`),
    enabled: visible,
  });

  const checkIn = useMutation({
    mutationFn: (ticketId: string) =>
      api(`/activities/${activityId}/tickets/${ticketId}/check-in`, { method: 'POST' }),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['activity-tickets', activityId] });
      queryClient.invalidateQueries({ queryKey: ['activity', activityId] });
      Alert.alert('Ticket Checked In! ✅', `Code ${res.ticketCode} redeemed.`);
    },
    onError: (e: any) => {
      Alert.alert('Check-in failed', e instanceof ApiError ? e.message : 'Error');
    },
  });

  const data = ticketsQ.data;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.overlay, justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: '#fff', borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl, maxHeight: '85%', paddingBottom: 28 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 20, borderBottomWidth: 1, borderBottomColor: C.line }}>
            <View>
              <T style={{ fontFamily: F.b, fontSize: 17, color: C.ink }}>Host Ticket Dashboard</T>
              <Muted numberOfLines={1} style={{ fontSize: 12, maxWidth: 260 }}>{activityTitle}</Muted>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={12}>
              <Ionicons name="close" size={24} color={C.ink} />
            </Pressable>
          </View>

          {ticketsQ.isLoading ? (
            <View style={{ padding: 40, alignItems: 'center' }}>
              <ActivityIndicator color={C.primary} size="large" />
            </View>
          ) : data ? (
            <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
              {/* Financial & Ticket Summary Cards */}
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <View style={{ flex: 1, backgroundColor: '#FFFBEB', borderRadius: R.md, padding: 12, borderWidth: 1, borderColor: '#FDE68A' }}>
                  <Muted style={{ fontSize: 11, color: '#B45309' }}>Tickets Sold</Muted>
                  <T style={{ fontFamily: F.xb, fontSize: 20, color: '#92400E', marginTop: 2 }}>{data.totalSold}</T>
                </View>
                <View style={{ flex: 1, backgroundColor: '#F0FDF4', borderRadius: R.md, padding: 12, borderWidth: 1, borderColor: '#BBF7D0' }}>
                  <Muted style={{ fontSize: 11, color: '#15803D' }}>Host Net Payout</Muted>
                  <T style={{ fontFamily: F.xb, fontSize: 20, color: '#166534', marginTop: 2 }}>
                    ₹{Math.round((data.hostEarningsPaise || 0) / 100).toLocaleString()}
                  </T>
                </View>
              </View>

              <T style={{ fontFamily: F.b, fontSize: 15, color: C.ink, marginTop: 4 }}>
                Ticket Holders ({data.tickets?.length || 0})
              </T>

              {data.tickets?.length === 0 ? (
                <View style={{ padding: 24, alignItems: 'center', backgroundColor: C.bgSoft, borderRadius: R.md }}>
                  <T style={{ fontSize: 28 }}>🎟️</T>
                  <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink, marginTop: 6 }}>No tickets booked yet</T>
                  <Muted style={{ fontSize: 12, textAlign: 'center', marginTop: 2 }}>
                    When travelers purchase tickets, their details and check-in pass will appear here.
                  </Muted>
                </View>
              ) : (
                <View style={{ gap: 10 }}>
                  {data.tickets.map((t: any) => {
                    const isUsed = t.status === 'used';
                    return (
                      <View
                        key={t.id}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: 12,
                          borderRadius: R.md,
                          backgroundColor: isUsed ? C.bgSoft : '#fff',
                          borderWidth: 1,
                          borderColor: isUsed ? C.line : '#FDE68A',
                        }}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                          <Avatar uri={t.userPhotoUrl} name={t.userName} size={40} cc={t.userCountry} />
                          <View style={{ flex: 1 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                              <T style={{ fontFamily: F.b, fontSize: 14, color: C.ink }}>{t.userName}</T>
                              <T style={{ fontSize: 12 }}>{flag(t.userCountry)}</T>
                            </View>
                            <T style={{ fontFamily: F.m, fontSize: 11, color: isUsed ? C.ink3 : '#D97706', marginTop: 2 }}>
                              {t.ticketCode} · ₹{Math.round(t.pricePaise / 100)}
                            </T>
                          </View>
                        </View>

                        {isUsed ? (
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.goSoft, paddingHorizontal: 8, paddingVertical: 4, borderRadius: R.sm }}>
                            <Ionicons name="checkmark-circle" size={16} color={C.go} />
                            <T style={{ fontFamily: F.b, fontSize: 11, color: C.go }}>Checked In</T>
                          </View>
                        ) : (
                          <Button
                            title="Check In"
                            kind="primary"
                            loading={checkIn.isPending}
                            onPress={() => checkIn.mutate(t.id)}
                            style={{ paddingHorizontal: 12, height: 34, backgroundColor: '#D97706' }}
                          />
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

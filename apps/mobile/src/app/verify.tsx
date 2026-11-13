import React, { useEffect, useState, useRef } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { T, H1, H2, Muted, Button, BackButton } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { queryClient } from '../lib/query';
import { shootAndUpload } from '../lib/selfie';
import { pickAndUpload } from '../lib/upload';
import { C, F, R, shadow } from '../lib/theme';
import { COUNTRIES } from '../lib/countries';
import { FEATURES } from '../lib/config';

// Head poses, checked automatically from the selfie
const POSES: Record<string, [string, string, string]> = {
  turn_head: ['↪️', 'Turn your head to one side', 'About a third of the way, so both eyes still show'],
  look_up: ['⬆️', 'Tilt your chin up', 'Look up a little, keep your whole face in the frame'],
};

const DOC_TYPES = [
  { id: 'passport', label: 'Passport 🛂', desc: 'International travel document' },
  { id: 'national_id', label: 'National ID 🪪', desc: 'Government identity card' },
  { id: 'drivers_license', label: "Driver's License 🚗", desc: 'Official driving permit' },
  { id: 'aadhaar', label: 'Aadhaar Card 🇮🇳', desc: 'Indian national UID' },
] as const;

export default function Verify() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<any>('/me') });
  const q = useQuery({
    queryKey: ['verify'],
    queryFn: () => api<any>('/verify?v=2'),
    refetchInterval: query => (query.state.data as any)?.status === 'pending' ? 2000 : false,
  });

  // The pose to ask for. Until a check that was pending finishes, it is whatever the server first said; then the new one.
  const [pose, setPose] = useState<string | null>(null);
  const wasPending = useRef(false);
  useEffect(() => {
    if (q.data?.status === 'pending') wasPending.current = true;
    else if (wasPending.current && q.data) {
      wasPending.current = false;
      queryClient.invalidateQueries({ queryKey: ['me'] });
      setPose(q.data.pose);
    }
  }, [q.data?.status]);

  const [selfieBusy, setSelfieBusy] = useState(false);
  const [selfieErr, setSelfieErr] = useState('');

  // Tier 2: Government ID state
  const [docType, setDocType] = useState<'passport' | 'national_id' | 'drivers_license' | 'aadhaar'>('passport');
  const [docPhotoKey, setDocPhotoKey] = useState<string | null>(null);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [submittingDoc, setSubmittingDoc] = useState(false);

  const d = q.data;
  // Shown (and sent) until a finished check replaces it: the one the server gave when the screen opened.
  const poseNow: string | null = pose ?? d?.pose ?? null;

  const submitSelfie = async () => {
    setSelfieBusy(true);
    setSelfieErr('');
    try {
      const key = await shootAndUpload(label);
      if (key) {
        await api('/verify', { body: { key, pose: poseNow } });
        await queryClient.invalidateQueries({ queryKey: ['verify'] });
        queryClient.invalidateQueries({ queryKey: ['me'] });
      }
    } catch (e) {
      setSelfieErr(e instanceof ApiError ? e.message : "Couldn't upload the photo. Try again.");
    } finally {
      setSelfieBusy(false);
    }
  };

  const handlePickDocument = async () => {
    try {
      setUploadingDoc(true);
      const url = await pickAndUpload('id_doc' as any).catch(() => null);
      if (url) {
        // Extract key from publicUrl or construct relative key
        const keyMatch = url.match(/(id_doc\/[^\s?#]+)/);
        const key = keyMatch ? keyMatch[1] : `id_doc/${me.data?.id}/${Date.now()}.jpg`;
        setDocPhotoKey(key);
      }
    } catch (e: any) {
      Alert.alert('Upload Failed', e?.message || 'Could not upload document photo.');
    } finally {
      setUploadingDoc(false);
    }
  };

  const submitGovernmentId = async () => {
    if (!docPhotoKey) {
      Alert.alert('Document Required', 'Please attach a clear photo of your government ID.');
      return;
    }
    try {
      setSubmittingDoc(true);
      await api('/verify/id', {
        method: 'POST',
        body: {
          key: docPhotoKey,
          documentType: docType,
          documentCountry: (me.data?.homeCountry || 'IN').toUpperCase(),
        },
      });
      await queryClient.invalidateQueries({ queryKey: ['verify'] });
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      Alert.alert(
        'Government ID Submitted! 🛡️',
        'Our trust & safety team will review your document. You will be notified once verified.'
      );
    } catch (e: any) {
      Alert.alert('Submission Failed', e instanceof ApiError ? e.message : 'Could not submit document.');
    } finally {
      setSubmittingDoc(false);
    }
  };

  const [emoji, label, hint] = POSES[poseNow ?? ''] ?? ['🤳', '', ''];
  // Tier 2 (government ID) is switched off in the app and on the server (FEATURES.idVerification, `idAvailable`):
  // uploads would land on the public media CDN, and there is no review screen yet.
  const idTier = FEATURES.idVerification && !!d?.idAvailable;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }} edges={['top']}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10 }}>
        <BackButton />
        <T style={{ fontFamily: F.b, fontSize: 17 }}>Identity Verification</T>
        <View style={{ width: 28 }} />
      </View>

      {!d ? (
        <ActivityIndicator color={C.primary} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 60 }}>
          {/* Header Description */}
          <View style={{ gap: 6 }}>
            <H1 style={{ fontSize: 24 }}>{d.verified ? "You're verified" : d.status === 'pending' ? 'Checking your selfie…' : 'Get verified'}</H1>
            <Muted style={{ lineHeight: 21, fontSize: 14 }}>
              {d.verified
                ? `People see ✅ next to your name, so they know you're really you.${idTier ? ' You can also verify your Government ID below for the Gold Shield 🛡️.' : ''}`
                : "Take a selfie doing the pose below. It's checked automatically against your profile photo in a few seconds and never shown on your profile. Verified people get ✅ next to their name."}
            </Muted>
          </View>

          {/* Tier 1: Selfie Liveness Check */}
          <View
            style={[
              {
                backgroundColor: '#fff',
                borderRadius: R.lg,
                padding: 18,
                borderWidth: 1.5,
                borderColor: d.verified ? '#10B39F' : C.line,
                gap: 14,
              },
              shadow,
            ]}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T style={{ fontSize: 20 }}>🤳</T>
                <H2 style={{ fontSize: 17 }}>Tier 1: Selfie Liveness</H2>
              </View>
              {d.verified ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.goSoft, paddingHorizontal: 8, paddingVertical: 3, borderRadius: R.pill }}>
                  <Ionicons name="checkmark-circle" size={14} color={C.go} />
                  <T style={{ color: C.go, fontFamily: F.b, fontSize: 12 }}>VERIFIED</T>
                </View>
              ) : (
                <View style={{ backgroundColor: C.bgSoft, paddingHorizontal: 8, paddingVertical: 3, borderRadius: R.pill }}>
                  <T style={{ color: C.ink3, fontFamily: F.b, fontSize: 11 }}>BASIC TIER</T>
                </View>
              )}
            </View>

            {d.verified ? (
              <View style={{ backgroundColor: C.goSoft, borderRadius: R.md, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <T style={{ fontSize: 24 }}>✅</T>
                <View style={{ flex: 1 }}>
                  <T style={{ fontFamily: F.b, color: '#065F46', fontSize: 14 }}>Selfie Verified</T>
                  <Muted style={{ color: '#047857', fontSize: 12 }}>Your face matches your profile photo. Verified mark ✅ displayed on your profile.</Muted>
                </View>
              </View>
            ) : d.status === 'pending' ? (
              <View style={{ alignItems: 'center', paddingVertical: 18, gap: 10 }}>
                <ActivityIndicator color={C.primary} size="large" />
                <T style={{ fontFamily: F.b, fontSize: 15 }}>Comparing your selfie…</T>
                <Muted style={{ textAlign: 'center', fontSize: 13 }}>Face matching runs automatically. This takes just a few seconds.</Muted>
              </View>
            ) : (
              <View style={{ gap: 12 }}>
                <Muted style={{ fontSize: 13, lineHeight: 19 }}>
                  Take a quick selfie matching the pose below. Verified automatically against your profile photo.
                </Muted>
                {d.status === 'rejected' ? (
                  <View style={{ padding: 12, borderRadius: R.md, backgroundColor: '#FDECEC' }}>
                    <T style={{ color: C.danger, fontFamily: F.sb, fontSize: 13 }}>
                      {d.reasonText || "Your last selfie didn't match. Ensure good lighting and a clear face view."}
                    </T>
                  </View>
                ) : null}

                <View style={{ alignItems: 'center', gap: 6, paddingVertical: 18, borderRadius: R.md, backgroundColor: C.bgSoft }}>
                  <T style={{ fontSize: 48 }}>{emoji}</T>
                  <T style={{ fontFamily: F.b, fontSize: 17 }}>{label}</T>
                  <Muted style={{ textAlign: 'center', paddingHorizontal: 16, fontSize: 12.5 }}>{hint || 'Keep your face in frame'}</Muted>
                </View>

                {selfieErr ? <T style={{ color: C.danger, textAlign: 'center', fontSize: 13 }}>{selfieErr}</T> : null}
                <Button
                  title="Take selfie"
                  loading={selfieBusy}
                  disabled={!poseNow || d.triesLeft === 0}
                  onPress={submitSelfie}
                  icon={<Ionicons name="camera" size={18} color="#fff" />}
                />
                <Muted style={{ textAlign: 'center', fontSize: 11.5 }}>
                  {d.triesLeft === 0 ? "You've reached today's 5 tries. Try again tomorrow." : `${d.triesLeft ?? 5} of 5 tries left today`}
                </Muted>
              </View>
            )}
          </View>

          {/* Tier 2: Government ID Verification (hidden while switched off) */}
          {idTier ? (
          <View
            style={[
              {
                backgroundColor: '#fff',
                borderRadius: R.lg,
                padding: 18,
                borderWidth: 1.5,
                borderColor: d.idVerified ? '#F59E0B' : C.line,
                gap: 14,
              },
              shadow,
            ]}
          >
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <T style={{ fontSize: 20 }}>🛡️</T>
                <H2 style={{ fontSize: 17 }}>Tier 2: Government ID</H2>
              </View>
              {d.idVerified ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#FEF3C7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: R.pill }}>
                  <T style={{ fontSize: 12 }}>🛡️</T>
                  <T style={{ color: '#B45309', fontFamily: F.b, fontSize: 12 }}>ID VERIFIED</T>
                </View>
              ) : d.idStatus === 'pending' ? (
                <View style={{ backgroundColor: '#FEF3C7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: R.pill }}>
                  <T style={{ color: '#D97706', fontFamily: F.b, fontSize: 11 }}>IN REVIEW</T>
                </View>
              ) : (
                <View style={{ backgroundColor: '#EFF6FF', paddingHorizontal: 8, paddingVertical: 3, borderRadius: R.pill }}>
                  <T style={{ color: '#2563EB', fontFamily: F.b, fontSize: 11 }}>ELITE TRUST</T>
                </View>
              )}
            </View>

            {!d.verified ? (
              <View style={{ backgroundColor: C.bgSoft, borderRadius: R.md, padding: 14, alignItems: 'center', gap: 6 }}>
                <Ionicons name="lock-closed" size={24} color={C.ink3} />
                <T style={{ fontFamily: F.b, color: C.ink, fontSize: 14 }}>Complete Tier 1 Selfie Check First</T>
                <Muted style={{ textAlign: 'center', fontSize: 12.5 }}>
                  Government ID verification unlocks once your selfie matches your profile photo.
                </Muted>
              </View>
            ) : d.idVerified ? (
              <View style={{ backgroundColor: '#FFFBEB', borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: '#FDE68A', gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <T style={{ fontSize: 24 }}>🛡️</T>
                  <View style={{ flex: 1 }}>
                    <T style={{ fontFamily: F.xb, color: '#92400E', fontSize: 15 }}>Government ID Verified</T>
                    <Muted style={{ color: '#B45309', fontSize: 12 }}>
                      {d.idType ? `${d.idType.replace(/_/g, ' ').toUpperCase()} (${d.idCountry || 'IN'})` : 'Official Document'} · Confirmed
                    </Muted>
                  </View>
                </View>
                <T style={{ fontSize: 12.5, color: '#78350F', lineHeight: 18, marginTop: 4 }}>
                  You hold the highest trust tier on Tablamigo. The Gold Shield badge 🛡️ is displayed on your profile and event meetups.
                </T>
              </View>
            ) : d.idStatus === 'pending' ? (
              <View style={{ backgroundColor: '#FFFBEB', borderRadius: R.md, padding: 14, borderWidth: 1, borderColor: '#FDE68A', gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <T style={{ fontSize: 22 }}>🕒</T>
                  <View style={{ flex: 1 }}>
                    <T style={{ fontFamily: F.b, color: '#92400E', fontSize: 14.5 }}>Document Under Review</T>
                    <Muted style={{ color: '#B45309', fontSize: 12 }}>
                      Submitted {d.idSubmittedAt ? new Date(d.idSubmittedAt).toLocaleDateString() : 'today'}
                    </Muted>
                  </View>
                </View>
                <T style={{ fontSize: 12.5, color: '#78350F', lineHeight: 18 }}>
                  Our trust & safety team is reviewing your document. You will be notified when it is done.
                </T>
              </View>
            ) : (
              <View style={{ gap: 14 }}>
                <Muted style={{ fontSize: 13, lineHeight: 19 }}>
                  Submit an official government document (Passport, National ID, Driver's License, or Aadhaar) to unlock the exclusive Gold Shield 🛡️.
                </Muted>

                {d.idStatus === 'rejected' ? (
                  <View style={{ backgroundColor: '#FDECEC', borderRadius: R.md, padding: 12, gap: 4 }}>
                    <T style={{ color: C.danger, fontFamily: F.b, fontSize: 13 }}>Document Not Approved</T>
                    <Muted style={{ color: C.danger, fontSize: 12 }}>
                      {d.idRejectionReason || 'Document details were unreadable or blurry. Please upload a clear photo.'}
                    </Muted>
                  </View>
                ) : null}

                {/* Document Type Picker */}
                <View style={{ gap: 8 }}>
                  <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink }}>Select Document Type:</T>
                  <View style={{ gap: 6 }}>
                    {DOC_TYPES.map(doc => {
                      const sel = docType === doc.id;
                      return (
                        <Pressable
                          key={doc.id}
                          onPress={() => setDocType(doc.id)}
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: 12,
                            borderRadius: R.md,
                            borderWidth: 1.5,
                            borderColor: sel ? C.primary : C.line,
                            backgroundColor: sel ? C.primarySoft : '#fff',
                          }}
                        >
                          <View>
                            <T style={{ fontFamily: F.b, fontSize: 14, color: sel ? C.primaryDark : C.ink }}>
                              {doc.label}
                            </T>
                            <Muted style={{ fontSize: 11 }}>{doc.desc}</Muted>
                          </View>
                          <Ionicons
                            name={sel ? 'radio-button-on' : 'radio-button-off'}
                            size={18}
                            color={sel ? C.primary : C.ink3}
                          />
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {/* Document Photo Upload */}
                <View style={{ gap: 8 }}>
                  <T style={{ fontFamily: F.sb, fontSize: 13, color: C.ink }}>Attach Document Photo:</T>
                  {docPhotoKey ? (
                    <View style={{ backgroundColor: C.goSoft, borderRadius: R.md, padding: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Ionicons name="checkmark-circle" size={20} color={C.go} />
                        <T style={{ fontFamily: F.b, color: C.go, fontSize: 13 }}>Document Attached</T>
                      </View>
                      <Pressable onPress={() => setDocPhotoKey(null)} hitSlop={8}>
                        <T style={{ color: C.danger, fontFamily: F.sb, fontSize: 12 }}>Change</T>
                      </Pressable>
                    </View>
                  ) : (
                    <Button
                      title="Select Document Photo"
                      kind="ghost"
                      style={{ borderWidth: 1.5, borderColor: C.primary }}
                      loading={uploadingDoc}
                      onPress={handlePickDocument}
                      icon={<Ionicons name="document-attach-outline" size={18} color={C.primary} />}
                    />
                  )}
                </View>

                {/* Privacy and Security Guarantee */}
                <View style={{ backgroundColor: C.bgSoft, borderRadius: R.md, padding: 12, gap: 4 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Ionicons name="shield-checkmark" size={16} color={C.ink2} />
                    <T style={{ fontFamily: F.b, fontSize: 12, color: C.ink }}>Used only to verify you</T>
                  </View>
                  <Muted style={{ fontSize: 11, lineHeight: 16 }}>
                    Your document is used only to check your identity and is never shown on your profile.
                  </Muted>
                </View>

                <Button
                  title="Submit for ID Verification 🛡️"
                  loading={submittingDoc}
                  disabled={!docPhotoKey}
                  onPress={submitGovernmentId}
                  style={docPhotoKey ? { backgroundColor: '#D97706' } : undefined}
                />
              </View>
            )}
          </View>
          ) : null}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

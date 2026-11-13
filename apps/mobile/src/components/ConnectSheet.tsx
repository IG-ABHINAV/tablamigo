import React, { useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Modal } from './Modal';
import { T, Muted, Avatar, Button } from './ui';
import { C, F, R } from '../lib/theme';
import { firstName } from '../lib/connect';

export { firstName };

export const CONNECT_NOTE_MAX = 300;

export type ConnectPerson = { id: string; name: string; photoUrl?: string | null; homeCountry?: string | null };

/**
 * "Connect with <name>" with an optional note: the profile's Connect and a trip's suggested buddies both open it. A bottom sheet
 * that stays whole at 320pt with the keyboard open: the name takes its own line (two at most, then an ellipsis) beside a fixed
 * avatar, the close button keeps its 44pt, the buttons stack full width, and everything scrolls if the keyboard leaves too little
 * room. The keyboard lifts the sheet on iOS and Android (behavior="padding" on both: with edge to edge the Android window no
 * longer resizes); on the web the body follows the visible viewport (lib/viewport.web.ts).
 */
export function ConnectSheet({ person, onClose, onSend, sending, intro, initialNote = '', sendLabel = 'Send request', error }: {
  person: ConnectPerson | null;
  onClose: () => void;
  onSend: (note: string) => void;
  sending?: boolean;
  intro?: string;
  initialNote?: string;
  sendLabel?: string;
  error?: string | null;
}) {
  const insets = useSafeAreaInsets();
  // A small phone with the keyboard up (the web app's window is the visible area then): drop the explainer and shorten the
  // note so Send stays on screen.
  const short = useWindowDimensions().height < 480;
  // A new person is a new note (the trip card pre-fills one with their first name).
  const [draft, setDraft] = useState({ for: person?.id, note: initialNote });
  const note = draft.for === person?.id ? draft.note : initialNote;
  const setNote = (t: string) => setDraft({ for: person?.id, note: t });
  if (!person) return null;
  const left = CONNECT_NOTE_MAX - note.length;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable accessibilityLabel="Close" style={{ flex: 1, backgroundColor: C.overlay }} onPress={onClose} />
        <View testID="connect-sheet" style={{ width: '100%', maxWidth: 520, alignSelf: 'center', maxHeight: '92%', backgroundColor: C.bg, borderTopLeftRadius: R.xl, borderTopRightRadius: R.xl }}>
          <View style={{ alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: C.line, marginTop: 10 }} />
          <ScrollView keyboardShouldPersistTaps="handled" bounces={false}
            contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16 + insets.bottom, gap: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Avatar uri={person.photoUrl} name={person.name} size={48} cc={person.homeCountry} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Muted style={{ fontSize: 13 }}>Connect with</Muted>
                <T testID="connect-sheet-name" numberOfLines={2} ellipsizeMode="tail" style={{ fontFamily: F.b, fontSize: 18, lineHeight: 23 }}>{person.name}</T>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={6}
                style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginRight: -10 }}>
                <Ionicons name="close" size={24} color={C.ink} />
              </Pressable>
            </View>
            {short ? null : <Muted style={{ fontSize: 14, lineHeight: 20 }}>
              {intro ?? `${firstName(person.name)} gets your request and can accept or decline. Once they accept, you're connected.`}
            </Muted>}
            <View style={{ gap: 6 }}>
              <TextInput
                value={note}
                onChangeText={setNote}
                accessibilityLabel="Add a note (optional)"
                placeholder="Add a note (optional): say hi, or suggest a plan"
                placeholderTextColor={C.ink3}
                multiline
                maxLength={CONNECT_NOTE_MAX}
                style={{ minHeight: short ? 64 : 96, maxHeight: short ? 96 : 160, backgroundColor: C.bgSoft, borderRadius: R.md, borderWidth: 1, borderColor: C.line,
                  paddingHorizontal: 12, paddingTop: 12, paddingBottom: 12, fontFamily: F.r, fontSize: 16, lineHeight: 21, color: C.ink, textAlignVertical: 'top' }}
              />
              <Muted style={{ fontSize: 12, textAlign: 'right', color: left < 30 ? C.danger : C.ink3 }}>{left} left</Muted>
            </View>
            {error ? <T style={{ color: C.danger, fontSize: 14 }}>{error}</T> : null}
            <View style={{ gap: 10 }}>
              <Button title={sendLabel} loading={sending} onPress={() => onSend(note.trim())} icon={<Ionicons name="person-add" size={18} color="#fff" />} />
              <Button title="Cancel" kind="ghost" onPress={onClose} style={{ height: 46 }} />
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}


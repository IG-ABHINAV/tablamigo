import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, TextInput, View, ActivityIndicator } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { linkify, type Piece } from '../../lib/app-links';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSafeEdges } from '../../lib/safe-edges';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { T, Muted, Avatar, Empty, Button, BackButton, IconButton } from '../../components/ui';
import { ChatPollCard, type Poll } from '../../components/ChatPollCard';
import { ChatLocationCard, type LiveLocation } from '../../components/ChatLocationCard';
import { ChatVoiceCard, type VoiceNote } from '../../components/ChatVoiceCard';
import { dayLabel } from '../../components/format';
import { ChatAttachSheet, chatError } from '../../components/ChatAttachSheet';
import { ChatMessageMenu, ChatQuote, ChatReactions, ReplyBar, SwipeToReply, applyReaction, type Quote, type Reaction } from '../../components/ChatExtras';
import { ChatMediaModal } from '../../components/ChatMediaModal';
import { PhotoViewer } from '../../components/PhotoViewer';
import { chatPhotos, type ViewerPhoto } from '../../lib/photo-viewer';
import { ChatSearchModal } from '../../components/ChatSearchModal';
import { PaywallSheet } from '../../components/PaywallSheet';
import { momentFor, type Moment } from '../../lib/paywall-copy';
import { api, ApiError } from '../../lib/api';
import { runningLateOpen } from '../../lib/running-late';
import { useLocation } from '../../lib/location';
import { getSocket } from '../../lib/socket';
import { pickAndUpload } from '../../lib/upload';
import { reportSheet } from '../../lib/safety';
import { setOpenChat, askPushOnIntent } from '../../lib/push';
import { reviewAfterMessageSent } from '../../lib/review-prompt';
import { queryClient } from '../../lib/query';
import { C, F, R } from '../../lib/theme';

// A link in a message: in-app screens through the router; anything else in the system browser (on the web a real
// <a target=_blank rel="noopener noreferrer">, so the address shows on hover and the chat tab keeps no opener link).
function linkProps(p: Piece): object {
  if (p.route) return { onPress: () => router.push(p.route as any) };
  const url = p.url!;
  return Platform.OS === 'web' ? { href: url, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } : { onPress: () => { Linking.openURL(url).catch(() => {}); } };
}
// A long address breaks inside the bubble on the web instead of widening it.
const WEB_WRAP = Platform.OS === 'web' ? ({ wordBreak: 'break-word' } as object) : null;

type Msg = { id: string; chatId: string; kind: 'text' | 'system' | 'image' | 'poll' | 'location' | 'audio' | 'voice'; body: string; createdAt: string; editedAt?: string; deletedAt?: string; senderId?: string; senderName?: string; senderPhoto?: string; poll?: Poll | null; location?: LiveLocation | null; voiceNote?: VoiceNote | null; replyTo?: Quote | null; reactions?: Reaction[] | null; pending?: boolean };
// Free-tier state of a DM, from the API (lib/chat-gate.ts). open: why it's unlimited; remaining: messages before a reply.
type Gate = { canSend: boolean; open: 'plus' | 'shared_plan' | 'reply' | null; code: 'dm_limit' | 'dm_wait_reply' | null; remaining: number | null; contacts: boolean; otherName: string | null };
type MsgUpdate = { chatId: string; id: string; body?: string; editedAt?: string; deleted?: boolean; poll?: { counts: number[] }; voterId?: string; option?: number; location?: LiveLocation };
type ReactionEvent = { chatId: string; id: string; userId: string; userName: string | null; emoji: string | null };
type ReadEvent = { chatId: string; userId: string; lastReadId: string };

export default function ChatRoom() {
  const safeEdges = useSafeEdges(['top', 'bottom']);
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api('/me') });
  // The photo viewer over every image loaded in this chat.
  const [viewer, setViewer] = useState<{ photos: ViewerPhoto[]; index: number } | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]); const [chat, setChat] = useState<any>(null);
  const [text, setText] = useState(''); const [typing, setTyping] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [failed, setFailed] = useState(false); const [attempt, setAttempt] = useState(0);
  const [attach, setAttach] = useState(false);
  const [gate, setGate] = useState<Gate | null>(null); const [moment, setMoment] = useState<Moment | null>(null);
  // Read receipts: userId -> the newest message id they've read (only people who have read up to my last message, plus live updates).
  const [reads, setReads] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState<Quote | null>(null); const [menu, setMenu] = useState<Msg | null>(null); const [flash, setFlash] = useState<string | null>(null);
  const [editing, setEditing] = useState<Msg | null>(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [mediaVisible, setMediaVisible] = useState(false);
  const input = useRef<TextInput>(null);
  const list = useRef<FlatList>(null); const lastTyping = useRef(0); const myId = useRef<string | undefined>(undefined);
  myId.current = me.data?.id;

  useEffect(() => { setOpenChat(id); return () => setOpenChat(null); }, [id]);

  useEffect(() => {
    setFailed(false); setLoading(true);
    api(`/chats/${id}/messages`).then(r => { setMsgs(r.messages); setChat(r.chat); setGate(r.chat?.gate ?? null); setReads(r.reads ?? {}); setLoading(false); }).catch(() => { setFailed(true); setLoading(false); });
    api(`/chats/${id}/read`, { method: 'POST' }).then(() => queryClient.invalidateQueries({ queryKey: ['chats'] })).catch(() => {});
    const s = getSocket(); if (!s) return;
    s.emit('chat:join', id);
    const onMsg = (m: Msg) => {
      if (m.chatId !== id) return;
      // They replied: the DM is open for good.
      if (m.senderId && m.senderId !== myId.current) setGate(g => g && !g.open ? { ...g, open: 'reply', canSend: true, code: null, remaining: null } : g);
      setMsgs(v => v.some(x => x.id === String(m.id)) ? v : [...v, { ...m, id: String(m.id) }]); api(`/chats/${id}/read`, { method: 'POST' }).catch(() => {});
    };
    const onTyping = (e: { chatId: string; userId: string }) => { if (e.chatId === id) { setTyping(e.userId); setTimeout(() => setTyping(null), 2500); } };
    // Poll counts, edits, deletions and live positions.
    const onUpdate = (u: MsgUpdate) => {
      if (u.chatId !== id) return;
      setMsgs(v => v.map(m => m.id !== u.id ? m : {
        ...m,
        ...(u.location ? { location: u.location } : {}),
        ...(u.poll && m.poll ? { poll: { ...m.poll, counts: u.poll.counts, myVote: u.voterId === myId.current ? u.option ?? null : m.poll.myVote } } : {}),
        ...(u.body !== undefined ? { body: u.body, editedAt: u.editedAt } : {}),
        ...(u.deleted ? { body: '', deletedAt: new Date().toISOString() } : {}),
      }));
    };
    // Reactions and read receipts. The server already leaves out anyone on either side of a block.
    const onReaction = (e: ReactionEvent) => {
      if (e.chatId !== id) return;
      setMsgs(v => v.map(m => m.id === e.id ? { ...m, reactions: applyReaction(m.reactions, e, myId.current) } : m));
      setMenu(m => m && m.id === e.id ? { ...m, reactions: applyReaction(m.reactions, e, myId.current) } : m);
    };
    const onRead = (e: ReadEvent) => { if (e.chatId === id) setReads(r => Number(r[e.userId] ?? 0) >= Number(e.lastReadId) ? r : { ...r, [e.userId]: e.lastReadId }); };
    const onPin = (e: { chatId: string; pinnedMessage: any }) => { if (e.chatId === id) setChat((c: any) => c ? { ...c, pinnedMessage: e.pinnedMessage } : c); };
    s.on('message:new', onMsg); s.on('typing', onTyping); s.on('message:update', onUpdate); s.on('message:reaction', onReaction); s.on('chat:read', onRead); s.on('chat:pin', onPin);
    return () => { s.off('message:new', onMsg); s.off('typing', onTyping); s.off('message:update', onUpdate); s.off('message:reaction', onReaction); s.off('chat:read', onRead); s.off('chat:pin', onPin); };
  }, [id, attempt]);

  const add = (m: Msg) => setMsgs(v => v.some(x => x.id === m.id) ? v : [...v, m]);
  const patch = (mid: string, p: Partial<Msg>) => setMsgs(v => v.map(x => x.id === mid ? { ...x, ...p } : x));
  const send = async (body: string, kind: 'text' | 'image' | 'voice' | 'audio' = 'text', durationSeconds?: number) => {
    if (!body.trim()) return;
    askPushOnIntent();   // web app: ask for notifications when someone starts a conversation (replies arrive by push)
    if (editing) {
      const target = editing; setEditing(null); setText('');
      try {
        const res = await api(`/chats/${id}/messages/${target.id}`, { method: 'PATCH', body: { body } });
        patch(target.id, { body, editedAt: res.editedAt });
      } catch (e) {
        setText(body); setEditing(target);
        Alert.alert("Couldn't edit message", chatError(e));
      }
      return;
    }
    setText('');
    const quote = replying; setReplying(null);
    // A text shows at once as "Sending…" until the server has it, so a slow connection never looks like a lost message
    // (QA 1 Nov 2026: the box cleared and nothing appeared for 20+ s). It goes away again if the send fails.
    const tmp: Msg | null = kind === 'text' ? { id: `pending-${Date.now()}`, chatId: String(id), kind: 'text', body, createdAt: new Date().toISOString(), senderId: me.data?.id, senderName: me.data?.name, replyTo: quote ?? null, pending: true } : null;
    if (tmp) add(tmp);
    const drop = () => { if (tmp) setMsgs(v => v.filter(x => x.id !== tmp.id)); };
    try {
      const sent = await api(`/chats/${id}/messages`, { body: { body, kind, replyTo: quote?.id, durationSeconds } });
      drop(); add(sent);
      reviewAfterMessageSent();   // the 3rd message sent (any chat) may bring the store rating ask (lib/review-trigger.ts)
      setGate(g => g && g.remaining != null ? { ...g, remaining: g.remaining - 1, canSend: g.remaining > 1, code: g.remaining > 1 ? null : 'dm_wait_reply' } : g);
    } catch (e) {
      drop();
      if (kind === 'text') setText(t => t || body);   // keep anything typed while it was sending
      setReplying(quote);
      // Gave up waiting (lib/api.ts timeout): the server may still have it, and then it shows up here by itself.
      if (e instanceof ApiError && e.code === 'timeout') return Alert.alert('Not sure it was sent', 'The connection is very slow. If your message shows up in the chat, it went through. If not, send it again.');
      const m = e instanceof ApiError ? momentFor(e.code, e.message, e.data) : null;
      if (!m) return Alert.alert("Couldn't send", chatError(e));
      setMoment(m);
      if (e instanceof ApiError && (e.code === 'dm_limit' || e.code === 'dm_wait_reply')) setGate(g => g && { ...g, canSend: false, code: e.code as Gate['code'], remaining: 0 });
    }
  };

  const startEdit = (m: Msg) => {
    setMenu(null); setReplying(null); setEditing(m); setText(m.body);
    setTimeout(() => input.current?.focus(), 50);
  };

  const deleteMsg = (m: Msg) => {
    setMenu(null);
    Alert.alert('Delete message?', 'This message will be removed for everyone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          await api(`/chats/${id}/messages/${m.id}`, { method: 'DELETE' });
          patch(m.id, { body: '', deletedAt: new Date().toISOString() });
          if (chat?.pinnedMessage?.id === m.id) setChat((c: any) => c ? { ...c, pinnedMessage: null } : c);
        } catch (e) {
          Alert.alert("Couldn't delete message", chatError(e));
        }
      } }
    ]);
  };

  const togglePin = async (m: Msg) => {
    setMenu(null);
    try {
      if (chat?.pinnedMessage?.id === m.id) {
        await api(`/chats/${id}/pin`, { method: 'DELETE' });
        setChat((c: any) => c ? { ...c, pinnedMessage: null } : c);
      } else {
        const res = await api(`/chats/${id}/pin/${m.id}`, { method: 'POST' });
        setChat((c: any) => c ? { ...c, pinnedMessage: res.pinnedMessage } : c);
      }
    } catch (e) {
      Alert.alert("Couldn't update pin", chatError(e));
    }
  };

  const unpin = async () => {
    try {
      await api(`/chats/${id}/pin`, { method: 'DELETE' });
      setChat((c: any) => c ? { ...c, pinnedMessage: null } : c);
    } catch (e) {
      Alert.alert("Couldn't unpin", chatError(e));
    }
  };
  // Same emoji again removes it; the server's answer is the viewer's own view of the chips.
  const react = (m: Msg, emoji: string) => {
    setMenu(null);
    api(`/chats/${id}/messages/${m.id}/react`, { body: { emoji } }).then(r => patch(m.id, { reactions: r.reactions })).catch(e => Alert.alert("Couldn't react", chatError(e)));
  };
  const startReply = (m: Msg) => {
    setMenu(null);
    setReplying({ id: m.id, senderId: m.senderId ?? null, senderName: m.senderId === me.data?.id ? 'yourself' : m.senderName ?? null, kind: m.kind, body: m.body, unavailable: false });
    setTimeout(() => input.current?.focus(), 50);
  };
  // Tapping a quote: scroll to the original (loading older pages if it's further back) and flash it.
  const jumpTo = async (mid: string) => {
    let all = msgs;
    for (let page = 0; page < 10 && !all.some(m => m.id === mid) && all.length; page++) {
      const r = await api(`/chats/${id}/messages?before=${all[0].id}`).catch(() => null);
      if (!r?.messages?.length) break;
      all = [...r.messages, ...all.filter(m => !r.messages.some((x: Msg) => x.id === m.id))];
    }
    if (all !== msgs) setMsgs(all);
    const index = [...all].reverse().findIndex(m => m.id === mid);
    if (index < 0) return Alert.alert('Not found', "That message isn't available any more.");
    setTimeout(() => { list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true }); setFlash(mid); setTimeout(() => setFlash(f => f === mid ? null : f), 1400); }, all !== msgs ? 120 : 0);
  };
  const vote = (m: Msg, option: number) => api(`/chats/${id}/polls/${m.id}/vote`, { body: { option } }).then(r => patch(m.id, { poll: r.poll })).catch(e => Alert.alert("Couldn't vote", chatError(e)));
  const shareLocation = async (minutes: number) => {
    const pos = await useLocation.getState().locate();
    if (!pos || useLocation.getState().denied) throw new Error(useLocation.getState().denied ? 'Allow location access for Tablamigo in Settings to share where you are.' : "Couldn't find your location. Turn on GPS and try again.");
    add(await api(`/chats/${id}/locations`, { body: { ...pos, minutes } }));
  };
  const stopSharing = (m: Msg) => api(`/chats/${id}/locations/${m.id}/stop`, { method: 'POST' }).then(r => patch(m.id, { location: { ...r.location, ended: true } })).catch(e => Alert.alert("Couldn't stop sharing", chatError(e)));

  const handleRunningLate = () => {
    if (!chat?.activityId) return;
    Alert.alert(
      'Running late?',
      'Let everyone in the plan chat know when to expect you:',
      [
        { text: '5 min late', onPress: () => sendRunningLate(5) },
        { text: '15 min late', onPress: () => sendRunningLate(15) },
        { text: '30 min late', onPress: () => sendRunningLate(30) },
        { text: 'Cancel', style: 'cancel' }
      ]
    );
  };

  const sendRunningLate = async (minutes: number) => {
    try {
      await api(`/activities/${chat.activityId}/running-late`, {
        method: 'POST',
        body: { minutes }
      });
    } catch (e: any) {
      Alert.alert("Couldn't send update", e?.message || "Please make sure you are attending this plan.");
    }
  };

  const handleAcceptRequest = async () => {
    try {
      await api(`/chats/${id}/accept-request`, { method: 'POST' });
      setChat((c: any) => c ? { ...c, isRequest: false } : c);
      queryClient.invalidateQueries({ queryKey: ['chats'] });
    } catch (e: any) {
      Alert.alert("Couldn't accept request", e?.message || 'Error');
    }
  };

  const decline = async (block: boolean) => {
    try {
      await api(`/chats/${id}/decline-request`, { method: 'POST', body: { block } });
      queryClient.invalidateQueries({ queryKey: ['chats'] });
      router.back();
    } catch (e: any) {
      Alert.alert(block ? "Couldn't decline and block" : "Couldn't decline request", e?.message || 'Error');
    }
  };
  const handleDeclineRequest = () => {
    Alert.alert('Decline message request?', 'This conversation will be removed from your inbox.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Decline', style: 'destructive', onPress: () => decline(false) },
      // The web app's Alert is window.confirm (lib/pwa.web.ts): OK runs the last button, so a third choice there would turn
      // "Decline" into "Decline & Block". Blocking stays available from the person's profile.
      ...(Platform.OS === 'web' ? [] : [{ text: 'Decline & Block', style: 'destructive' as const, onPress: () => decline(true) }]),
    ]);
  };

  // While this screen is focused, push a fresh fix every 30 s for each of my shares that is still live.
  // A share ends at its expiry: the phone stops sending then (not when the server next refuses), and a timer re-renders once at the
  // earliest end so this list, and with it the loop below, is recomputed even if no message arrives.
  const [, tick] = useState(0);
  const liveShares = msgs.filter(m => m.kind === 'location' && m.senderId === me.data?.id && m.location && new Date(m.location.expiresAt).getTime() > Date.now())
    .map(m => ({ id: m.id, end: new Date(m.location!.expiresAt).getTime() }));
  const live = liveShares.map(x => x.id).join(',');
  const liveEnd = Math.min(...liveShares.map(x => x.end));
  useFocusEffect(useCallback(() => {
    if (!live) return;
    const stop = setTimeout(() => tick(n => n + 1), Math.min(Math.max(0, liveEnd - Date.now()) + 300, 2 ** 31 - 1));
    const push = async () => {
      if (AppState.currentState !== 'active') return;
      const pos = await useLocation.getState().locate();
      if (!pos || useLocation.getState().denied) return;
      for (const mid of live.split(',')) {
        if ((liveShares.find(x => x.id === mid)?.end ?? 0) <= Date.now()) continue;   // its time is up: send nothing more
        api(`/chats/${id}/locations/${mid}`, { method: 'PATCH', body: pos }).then(r => patch(mid, { location: r.location }))
          .catch(e => { if (e instanceof ApiError && e.code === 'location_ended') setMsgs(v => v.map(x => x.id === mid && x.location ? { ...x, location: { ...x.location, expiresAt: new Date().toISOString() } } : x)); });
      }
    };
    push(); const t = setInterval(push, 30_000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, [id, live, liveEnd]));

  const data = [...msgs].reverse();
  // "Seen" (DM) / "Seen by N" (group) sits under my last message.
  const lastMine = [...msgs].reverse().find(m => m.senderId && m.senderId === me.data?.id && m.kind !== 'system');
  const seenBy = lastMine ? Object.entries(reads).filter(([u, v]) => u !== me.data?.id && Number(v) >= Number(lastMine.id)).length : 0;
  const seenLabel = !seenBy ? null : chat?.kind === 'dm' ? 'Seen' : `Seen by ${seenBy}`;
  const render = (m: Msg, older?: Msg) => {
    if (m.kind === 'system') return <View style={{ alignSelf: 'center', backgroundColor: '#fff', borderRadius: R.pill, paddingHorizontal: 12, paddingVertical: 5, marginVertical: 6 }}><Muted style={{ fontSize: 12 }}>{m.body}</Muted></View>;
    const mine = m.senderId === me.data?.id;
    const card = (m.kind === 'poll' && !!m.poll) || (m.kind === 'location' && !!m.location) || m.kind === 'audio' || m.kind === 'voice';
    const firstOfRun = !older || older.senderId !== m.senderId || older.kind === 'system';
    return (
      <SwipeToReply enabled={!m.pending} onReply={() => startReply(m)}>
      <View style={{ flexDirection: 'row', justifyContent: mine ? 'flex-end' : 'flex-start', gap: 8, marginTop: firstOfRun ? 8 : 0, borderRadius: 16, backgroundColor: flash === m.id ? C.primarySoft : 'transparent' }}>
        {!mine ? <View style={{ width: 30 }}>{firstOfRun ? <Pressable onPress={() => m.senderId && router.push(`/user/${m.senderId}`)}><Avatar uri={m.senderPhoto} name={m.senderName} size={30} /></Pressable> : null}</View> : null}
        <Pressable onLongPress={() => { if (!m.pending) setMenu(m); }} delayLongPress={350}
          onPress={m.kind === 'image' ? () => setViewer(chatPhotos(msgs, m.id)) : undefined} accessibilityLabel={m.kind === 'image' ? `Photo from ${m.senderName ?? 'someone'}` : undefined}
          style={{ maxWidth: card ? '86%' : '76%', backgroundColor: mine && !card ? C.primary : '#fff', borderWidth: card && mine ? 1.5 : 0, borderColor: C.primarySoft, borderRadius: 20, borderBottomRightRadius: mine ? 6 : 20, borderBottomLeftRadius: mine ? 20 : 6, paddingHorizontal: m.kind === 'image' ? 4 : card ? 12 : 14, paddingVertical: m.kind === 'image' ? 4 : card ? 12 : 10 }}>
          {!mine && firstOfRun ? <T style={{ fontFamily: F.b, fontSize: 12, color: C.primaryDark, marginBottom: 2, marginLeft: m.kind === 'image' ? 8 : 0 }}>{m.senderName}</T> : null}
          {m.replyTo ? <ChatQuote q={m.replyTo} mine={mine && !card} onPress={() => m.replyTo && jumpTo(m.replyTo.id)} /> : null}
          {m.kind === 'image' ? <Image source={{ uri: m.body }} style={{ width: 220, height: 220, borderRadius: 16 }} contentFit="cover" />
            : m.kind === 'poll' && m.poll ? <ChatPollCard poll={m.poll} onVote={o => vote(m, o)} />
            : m.kind === 'location' && m.location ? <ChatLocationCard loc={m.location} name={m.senderName} photo={m.senderPhoto} mine={mine} onStop={() => stopSharing(m)} />
            : (m.kind === 'audio' || m.kind === 'voice') ? (
              <ChatVoiceCard
                audioUrl={m.voiceNote?.audioUrl ?? m.body}
                durationSeconds={m.voiceNote?.durationSeconds ?? 0}
                mine={mine}
              />
            )
            : <T style={{ color: mine ? '#fff' : C.ink, fontSize: 15.5, lineHeight: 21 }}>
                {/* This site's /app/ links (the team's trip matches and nudges) open the screen in the app; other links the browser. */}
                {linkify(m.body).map((piece, i) => piece.route || piece.url
                  ? <T key={i} accessibilityRole="link" {...linkProps(piece)} style={[{ color: mine ? '#fff' : C.primaryDark, textDecorationLine: 'underline' }, WEB_WRAP]}>{piece.text}</T>
                  : piece.text)}
                {m.editedAt ? <T style={{ fontSize: 11, color: mine ? 'rgba(255,255,255,0.7)' : C.ink3, fontStyle: 'italic' }}> (edited)</T> : null}
              </T>}
          <T style={{ fontSize: 10.5, color: mine && !card ? 'rgba(255,255,255,0.75)' : C.ink3, alignSelf: 'flex-end', marginTop: 2, marginRight: m.kind === 'image' ? 8 : 0 }}>{m.pending ? 'Sending…' : new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</T>
        </Pressable>
      </View>
      <View style={{ paddingLeft: mine ? 0 : 38 }}>
        <ChatReactions list={m.reactions ?? []} mine={mine} onToggle={e => react(m, e)} onWho={() => setMenu(m)} />
        {m.id === lastMine?.id && seenLabel ? <T style={{ alignSelf: 'flex-end', fontSize: 11, color: C.ink3, fontFamily: F.sb, marginTop: 2, marginRight: 4 }}>{seenLabel}</T> : null}
      </View>
      </SwipeToReply>
    );
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: C.bgSoft }} edges={safeEdges}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#fff', borderBottomWidth: 1, borderBottomColor: C.line }}>
        <BackButton />
        {chat?.kind === 'dm' ? <Pressable onPress={() => chat.otherUserId && router.push(`/user/${chat.otherUserId}`)}><Avatar uri={chat.photoUrl} name={chat.title} size={42} /></Pressable> :
        <View style={{ width: 42, height: 42, borderRadius: 14, backgroundColor: C.primarySoft, alignItems: 'center', justifyContent: 'center' }}><T style={{ fontSize: 22 }}>{chat?.emoji ?? (chat?.kind === 'city' ? '🏙️' : '💬')}</T></View>}
        <Pressable style={{ flex: 1 }} onPress={() => chat?.activityId && router.push(`/activity/${chat.activityId}`)}>
          <T numberOfLines={1} style={{ fontFamily: F.b, fontSize: 16 }}>{chat?.title ?? 'Chat'}</T>
          <Muted style={{ fontSize: 12 }}>{typing ? `${chat?.kind === 'dm' ? '' : `${msgs.find(m => m.senderId === typing)?.senderName ?? 'Someone'} is `}typing…` : chat?.kind === 'dm' ? 'Direct message' : `${chat?.memberCount ? `${chat.memberCount} ${chat.memberCount === 1 ? 'member' : 'members'}` : ''}${chat?.placeName ? ` · ${chat.placeName}` : ''}`}</Muted>
        </Pressable>
        {chat?.activityId && runningLateOpen(chat.startsAt) ? (
          <Pressable onPress={handleRunningLate} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: C.primarySoft, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 14 }}>
            <Ionicons name="time-outline" size={16} color={C.primaryDark} />
            <T style={{ fontFamily: F.b, fontSize: 12, color: C.primaryDark }}>Late?</T>
          </Pressable>
        ) : null}
        <IconButton name="search-outline" label="Search this chat" size={22} pad={4} edge="none" onPress={() => setSearchVisible(true)} />
        <IconButton name="images-outline" label="Photos and links" size={22} pad={4} edge="right" onPress={() => setMediaVisible(true)} />
      </View>
      {/* A message request is answered in the bottom panel, where the composer would be (one Accept/Decline, not two). */}
      {chat?.pinnedMessage ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: C.primarySoft, borderBottomWidth: 1, borderBottomColor: C.line }}>
          <Ionicons name="pin" size={16} color={C.primaryDark} />
          <Pressable style={{ flex: 1 }} onPress={() => jumpTo(chat.pinnedMessage.id)}>
            <T numberOfLines={1} style={{ fontFamily: F.b, fontSize: 12.5, color: C.primaryDark }}>
              Pinned: {chat.pinnedMessage.senderName ? `${chat.pinnedMessage.senderName}: ` : ''}{chat.pinnedMessage.body}
            </T>
          </Pressable>
          {chat.isHost ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={unpin} hitSlop={8}>
              <Ionicons name="close" size={18} color={C.primaryDark} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        {loading ? <ActivityIndicator style={{ marginTop: 40 }} color={C.primary} /> :
        failed ? <Empty emoji="📡" title="Can't load this chat" body="Check your connection and try again." action={<Button title="Try again" onPress={() => setAttempt(a => a + 1)} />} /> :
        msgs.length === 0 ? <View style={{ flex: 1, justifyContent: 'center' }}><Empty emoji="👋" title={chat?.kind === 'dm' ? `Say hi to ${chat.title}` : 'Say hi'} body={chat?.kind === 'dm' ? 'Suggest a plan, a place or a time. Keep it in the app until you feel comfortable.' : 'Agree a meeting point and time here.'} /></View> :
        <FlatList ref={list} inverted data={data} keyExtractor={m => m.id} contentContainerStyle={{ padding: 14, gap: 6 }}
          onScrollToIndexFailed={e => { list.current?.scrollToOffset({ offset: e.averageItemLength * e.index, animated: false }); setTimeout(() => list.current?.scrollToIndex({ index: e.index, viewPosition: 0.5 }), 200); }}
          renderItem={({ item: m, index }) => {
            // Inverted list: the older message sits at index + 1, so a new day starts above this one.
            const older = data[index + 1];
            const day = !older || new Date(older.createdAt).toDateString() !== new Date(m.createdAt).toDateString()
              ? <View style={{ alignSelf: 'center', paddingHorizontal: 12, paddingVertical: 4, marginVertical: 8, borderRadius: R.pill, backgroundColor: C.line }}><T style={{ fontFamily: F.b, fontSize: 11.5, color: C.ink2 }}>{dayLabel(m.createdAt)}</T></View> : null;
            const row = render(m, older);
            return day ? <View>{day}{row}</View> : row;
          }} />}
        {gate && !gate.open ? <Pressable onPress={() => gate.code && setMoment(momentFor(gate.code, undefined, { name: gate.otherName }))}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 8, backgroundColor: gate.code ? C.primarySoft : C.bgSoft, borderTopWidth: 1, borderTopColor: C.line }}>
          <Ionicons name={gate.code ? 'hourglass-outline' : 'chatbubble-ellipses-outline'} size={16} color={gate.code ? C.primaryDark : C.ink2} />
          <T style={{ flex: 1, fontSize: 12.5, color: gate.code ? C.primaryDark : C.ink2, fontFamily: F.sb }}>
            {gate.code === 'dm_wait_reply' ? `Waiting for ${gate.otherName ?? 'them'} to reply` : gate.code === 'dm_limit' ? "You've used today's free new chat" : `${gate.remaining} message${gate.remaining === 1 ? '' : 's'} until ${gate.otherName ?? 'they'} ${gate.otherName ? 'replies' : 'reply'}`}
          </T>
          {gate.code ? <T style={{ fontSize: 12.5, color: C.primaryDark, fontFamily: F.b }}>Get Plus</T> : null}
        </Pressable> : null}
        {editing ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 8, backgroundColor: C.primarySoft, borderTopWidth: 1, borderTopColor: C.line }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Ionicons name="pencil" size={16} color={C.primaryDark} />
              <T style={{ fontFamily: F.b, fontSize: 12.5, color: C.primaryDark }}>Editing message</T>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Cancel editing" onPress={() => { setEditing(null); setText(''); }} hitSlop={10}>
              <Ionicons name="close-circle" size={18} color={C.primaryDark} />
            </Pressable>
          </View>
        ) : replying ? <ReplyBar q={replying} onCancel={() => setReplying(null)} /> : null}
        {chat?.isRequest ? (
          <View style={{ backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: C.line, padding: 16, gap: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: C.primarySoft, alignItems: 'center', justifyContent: 'center' }}>
                <T style={{ fontSize: 18 }}>🛡️</T>
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T style={{ fontFamily: F.b, fontSize: 14 }}>Message Request</T>
                <Muted style={{ fontSize: 12 }}>
                  {chat?.title ? `${chat.title} sent you a message request.` : 'This traveler sent you a message request.'} They won't know you've seen it until you accept.
                </Muted>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button title="Decline" kind="ghost" onPress={handleDeclineRequest} style={{ flex: 1, height: 44 }} />
              <Button title="Accept" onPress={handleAcceptRequest} style={{ flex: 1, height: 44 }} />
            </View>
          </View>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, backgroundColor: '#fff', borderTopWidth: replying || editing ? 0 : 1, borderTopColor: C.line }}>
            <Pressable accessibilityLabel="Attach" onPress={() => setAttach(true)} style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bgSoft }}>
              <Ionicons name="add" size={24} color={C.ink2} />
            </Pressable>
            <TextInput ref={input} value={text} placeholder={editing ? 'Edit message' : replying ? 'Reply' : 'Message'} placeholderTextColor={C.ink3} multiline maxLength={2000}
              onChangeText={t => { setText(t); if (Date.now() - lastTyping.current > 2000) { getSocket()?.emit('typing', id); lastTyping.current = Date.now(); } }}
              style={{ flex: 1, minHeight: 44, maxHeight: 120, borderRadius: 22, backgroundColor: C.bgSoft, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, fontFamily: F.m, fontSize: 16, color: C.ink }} />
            <Pressable accessibilityLabel="Send message" onPress={() => send(text)} disabled={!text.trim()} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: text.trim() ? C.primary : C.line, alignItems: 'center', justifyContent: 'center' }}>
              <Ionicons name={editing ? 'checkmark' : 'arrow-up'} size={22} color="#fff" />
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
      {/* No live location in city chats or trip circles: both are open to strangers (the server refuses it too).
          No voice-note button until real recording exists (FEATURES.voiceNotes): it used to send a hard-coded demo URL
          that 404s, and the server now only accepts the sender's own audio upload. */}
      <ChatAttachSheet visible={attach} group={!!chat && chat.kind !== 'dm'} city={chat?.kind === 'city' || chat?.kind === 'trip'} onClose={() => setAttach(false)}
        onPhoto={async () => { const u = await pickAndUpload('chat').catch(() => null); if (u) send(u, 'image'); }}
        onVoice={undefined}
        onPoll={async (question, options) => add(await api(`/chats/${id}/polls`, { body: { question, options } }))}
        onLocation={shareLocation} />
      <PaywallSheet moment={moment} onClose={() => setMoment(null)} />
      <ChatMessageMenu
        msg={menu}
        mine={menu?.senderId === me.data?.id}
        myId={me.data?.id}
        canEdit={!!(menu && menu.senderId === me.data?.id && menu.kind === 'text' && (Date.now() - new Date(menu.createdAt).getTime()) < 300_000)}
        canDelete={!!(menu && ((menu.senderId === me.data?.id && (Date.now() - new Date(menu.createdAt).getTime()) < 300_000) || chat?.isHost))}
        canPin={!!(menu && menu.kind !== 'system' && (chat?.isHost || chat?.kind === 'city'))}
        isPinned={chat?.pinnedMessage?.id === menu?.id}
        onClose={() => setMenu(null)}
        onReact={e => menu && react(menu, e)}
        onReply={() => menu && startReply(menu)}
        onEdit={() => menu && startEdit(menu)}
        onDelete={() => menu && deleteMsg(menu)}
        onPin={() => menu && togglePin(menu)}
        onReport={menu && menu.senderId !== me.data?.id ? () => { const m = menu; setMenu(null); reportSheet({ type: 'message', id: m.id, userId: m.senderId, userName: m.senderName }); } : undefined}
      />
      <PhotoViewer photos={viewer?.photos ?? []} index={viewer ? viewer.index : null} onClose={() => setViewer(null)} />
      <ChatSearchModal chatId={id} visible={searchVisible} onClose={() => setSearchVisible(false)} onSelectMessage={jumpTo} />
      <ChatMediaModal chatId={id} visible={mediaVisible} onClose={() => setMediaVisible(false)} onSelectImage={url => {
        const found = msgs.find(m => m.body === url);
        if (found) jumpTo(found.id);
      }} />
    </SafeAreaView>
  );
}

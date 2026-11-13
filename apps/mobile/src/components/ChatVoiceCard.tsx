import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { T } from './ui';
import { C, F } from '../lib/theme';

export type VoiceNote = { audioUrl: string; durationSeconds: number };

function formatTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export function ChatVoiceCard({
  audioUrl,
  durationSeconds,
  mine,
}: {
  audioUrl: string;
  durationSeconds: number;
  mine: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0 to 1
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (Platform.OS === 'web' && typeof Audio !== 'undefined') {
      const a = new Audio(audioUrl);
      audioRef.current = a;
      a.ontimeupdate = () => {
        if (a.duration && !isNaN(a.duration)) {
          setProgress(a.currentTime / a.duration);
        }
      };
      a.onended = () => {
        setPlaying(false);
        setProgress(0);
      };
      return () => {
        a.pause();
        audioRef.current = null;
      };
    }
  }, [audioUrl]);

  const toggle = () => {
    if (Platform.OS === 'web' && audioRef.current) {
      if (playing) {
        audioRef.current.pause();
        setPlaying(false);
      } else {
        audioRef.current.play().catch(() => {});
        setPlaying(true);
      }
    } else {
      setPlaying(p => !p);
    }
  };

  const dur = durationSeconds > 0 ? durationSeconds : 15;
  const currentTime = Math.round(progress * dur);
  const bars = [4, 7, 12, 16, 10, 14, 18, 11, 8, 15, 12, 9, 14, 6];

  return (
    <View style={{ minWidth: 190, maxWidth: 240, paddingVertical: 4, paddingHorizontal: 2, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Pressable
          onPress={toggle}
          hitSlop={8}
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor: mine ? 'rgba(255,255,255,0.28)' : C.primarySoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons
            name={playing ? 'pause' : 'play'}
            size={18}
            color={mine ? '#fff' : C.primaryDark}
            style={{ marginLeft: playing ? 0 : 2 }}
          />
        </Pressable>

        <View style={{ flex: 1, gap: 4 }}>
          {/* Waveform bars */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, height: 20 }}>
            {bars.map((h, i) => {
              const active = i / bars.length <= progress;
              return (
                <View
                  key={i}
                  style={{
                    flex: 1,
                    height: h,
                    borderRadius: 2,
                    backgroundColor: active
                      ? (mine ? '#fff' : C.primary)
                      : (mine ? 'rgba(255,255,255,0.4)' : C.ink3 + '40'),
                  }}
                />
              );
            })}
          </View>

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <T style={{ fontSize: 11, color: mine ? 'rgba(255,255,255,0.85)' : C.ink3, fontFamily: F.sb }}>
              {playing ? formatTime(currentTime) : formatTime(dur)}
            </T>
            <T style={{ fontSize: 10.5, color: mine ? 'rgba(255,255,255,0.75)' : C.ink3 }}>
              Voice note 🎤
            </T>
          </View>
        </View>
      </View>
    </View>
  );
}

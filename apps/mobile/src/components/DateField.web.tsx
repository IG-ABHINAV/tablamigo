import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { webInputValue, fromWebInput, clampDate } from '../lib/date-pick';

type Props = {
  value: Date; mode: 'date' | 'time' | 'datetime'; min?: Date; max?: Date;
  onChange: (d: Date) => void; children: React.ReactNode; accessibilityLabel: string; style?: StyleProp<ViewStyle>;
};

const TYPE = { date: 'date', time: 'time', datetime: 'datetime-local' } as const;

/**
 * The web app's DateField: the same children with an invisible browser date/time input laid over them, so a tap opens
 * the browser's own picker (iOS Safari's wheel, Chrome's calendar). Font size 16px so iOS Safari does not zoom on focus.
 */
export function DateField({ value, mode, min, max, onChange, children, accessibilityLabel, style }: Props) {
  return (
    <View style={[{ position: 'relative' }, style]}>
      {children}
      <input type={TYPE[mode]} aria-label={accessibilityLabel} value={webInputValue(mode, value)}
        min={min ? webInputValue(mode, min) : undefined} max={max ? webInputValue(mode, max) : undefined}
        onChange={e => { const d = fromWebInput(mode, e.currentTarget.value, value); if (d) onChange(clampDate(d, min, max)); }}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0, cursor: 'pointer', fontSize: 16, border: 0 }} />
    </View>
  );
}

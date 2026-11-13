import React, { useState } from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import DateTimePicker from '@expo/ui/community/datetime-picker';
import { C } from '../lib/theme';
import { toPickerDay, fromPickerDay, withTime, clampDate } from '../lib/date-pick';

/** The time dialog follows the phone's language: 12-hour (2:00 PM) where the app's own labels are 12-hour. */
const USES_24H = (() => { try { return new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions().hour12 === false; } catch { return false; } })();

type Props = {
  value: Date; mode: 'date' | 'time' | 'datetime'; min?: Date; max?: Date;
  onChange: (d: Date) => void; children: React.ReactNode; accessibilityLabel: string; style?: StyleProp<ViewStyle>;
};

/**
 * Whatever `children` shows (a date, a time), tappable: it opens the phone's own date or time dialog (Material 3 on
 * Android, via expo-ui). 'datetime' asks for the day, then the time. The web version (DateField.web.tsx) lays a browser
 * date/time input over the same children. Dates cross the dialog as UTC days (lib/date-pick.ts).
 */
export function DateField({ value, mode, min, max, onChange, children, accessibilityLabel, style }: Props) {
  const [step, setStep] = useState<null | 'date' | 'time'>(null);
  const [day, setDay] = useState<Date | null>(null);
  const close = () => { setStep(null); setDay(null); };
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={() => setStep(mode === 'time' ? 'time' : 'date')} style={style}>
        {children}
      </Pressable>
      {step === 'date' ? (
        <DateTimePicker mode="date" presentation="dialog" accentColor={C.primary}
          value={toPickerDay(value)} minimumDate={min ? toPickerDay(min) : undefined} maximumDate={max ? toPickerDay(max) : undefined}
          onDismiss={close}
          onValueChange={(_, picked) => {
            const d = fromPickerDay(picked);
            if (mode === 'date') { close(); onChange(clampDate(d, min, max)); return; }
            setDay(d); setStep('time');
          }} />
      ) : null}
      {step === 'time' ? (
        <DateTimePicker mode="time" presentation="dialog" accentColor={C.primary} is24Hour={USES_24H} value={day ? withTime(day, value) : value}
          onDismiss={close}
          onValueChange={(_, picked) => { const d = withTime(day ?? value, picked); close(); onChange(clampDate(d, min, max)); }} />
      ) : null}
    </>
  );
}

import React from 'react';
import { reportSheet, type ReportTarget } from '../lib/safety';
import { C } from '../lib/theme';
import { IconButton } from './ui';

/** A small flag that opens the report / block sheet (components/ReportHost.tsx) for one piece of someone else's content.
 *  On IconButton, so on the web it is a 44pt target around the same small flag (the web ignores hitSlop). */
export function ReportButton({ target, size = 16, color = C.ink3, before }: { target: ReportTarget; size?: number; color?: string; before?: () => void }) {
  return <IconButton name="flag-outline" label="Report" size={size} color={color} edge="none" onPress={() => { before?.(); reportSheet(target); }} />;
}

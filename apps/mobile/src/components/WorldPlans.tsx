import React, { useState } from 'react';
import { View } from 'react-native';
import { T, Muted, Button } from './ui';
import { ActivityCard, type Activity } from './ActivityCard';
import { api, ApiError } from '../lib/api';
import { C, F } from '../lib/theme';
import { km } from './format';
import { appendPage } from '../lib/connect';

export type WorldPage = { activities: Activity[]; nextCursor: string | null };

/**
 * GET /activities `world`: with few or no plans nearby, the rest of the world, nearest first, after the nearby ones. The first
 * page comes with the list; "Show more plans" pages on with GET /activities/world from its cursor (`query` is the list's own
 * point and filters, so every page follows the same rules). A new list (place or filter) starts again from its first page.
 */
export function WorldPlans({ first, query, nearbyCount }: { first: WorldPage | null | undefined; query: string; nearbyCount: number }) {
  // Keyed on the list's point, filters and first page's plans, not on the object: the list refetches every 45 s, and that must
  // not fold the pages already shown. Another key (a new place or filter) starts again from the first page.
  const key = `${query}|${(first?.activities ?? []).map(a => a.id).join(',')}`;
  const [paged, setPaged] = useState<{ key: string; more: Activity[]; cursor: string | null }>({ key, more: [], cursor: first?.nextCursor ?? null });
  const cur = paged.key === key ? paged : { key, more: [] as Activity[], cursor: first?.nextCursor ?? null };
  const cursor = cur.cursor;
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const list = [...(first?.activities ?? []), ...cur.more];
  if (!list.length) return null;
  const loadMore = async () => {
    if (!cursor || loading) return;
    setLoading(true); setErr('');
    try {
      const p = await api<WorldPage>(`/activities/world?${query}&cursor=${encodeURIComponent(cursor)}`);
      // Keyset pages never repeat a plan; the guard only covers a plan edited between two pages.
      setPaged({ key, more: appendPage(list, p.activities).slice(first?.activities.length ?? 0), cursor: p.nextCursor });
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'No connection. Try again.'); }
    finally { setLoading(false); }
  };
  return (
    <View testID="world-plans" style={{ gap: 12, marginTop: nearbyCount ? 14 : 0 }}>
      <View style={{ gap: 2 }}>
        <T style={{ fontFamily: F.b, fontSize: 13, letterSpacing: 0.6, color: C.ink2, textTransform: 'uppercase' }}>
          {nearbyCount ? 'More plans around the world' : 'Plans around the world'}
        </T>
        <Muted style={{ fontSize: 13 }}>Nearest first{list[0].distanceM != null ? `, from ${km(list[0].distanceM)} away` : ''}</Muted>
      </View>
      {list.map(a => <ActivityCard key={a.id} a={a} compact />)}
      {err ? <T style={{ color: C.danger, textAlign: 'center' }}>{err}</T> : null}
      {cursor ? <Button title="Show more plans" kind="ghost" loading={loading} onPress={loadMore} style={{ height: 46 }} /> : null}
    </View>
  );
}

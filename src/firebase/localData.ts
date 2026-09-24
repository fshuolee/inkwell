interface OwnedRecord {
  userId: string;
}

export interface LocalAppData<P extends OwnedRecord, S extends OwnedRecord> {
  presets: P[];
  stories: S[];
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const LEGACY_KEY = 'inkwell_local_data';
const localKey = (uid: string) => `${LEGACY_KEY}:${uid}`;

export function filterOwnedData<P extends OwnedRecord, S extends OwnedRecord>(
  data: { presets?: unknown; stories?: unknown },
  uid: string
): LocalAppData<P, S> {
  const owned = <T extends OwnedRecord>(items: unknown): T[] =>
    Array.isArray(items) ? items.filter((item): item is T => item?.userId === uid) : [];
  return { presets: owned<P>(data.presets), stories: owned<S>(data.stories) };
}

/** Old releases used one shared key. Import only records owned by this account. */
export function readLocalData<P extends OwnedRecord, S extends OwnedRecord>(
  storage: StorageLike,
  uid: string | null
): LocalAppData<P, S> {
  const empty: LocalAppData<P, S> = { presets: [], stories: [] };
  if (!uid) return empty;

  try {
    const scoped = storage.getItem(localKey(uid));
    const raw = scoped ?? storage.getItem(LEGACY_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw);
    const data = filterOwnedData<P, S>(parsed, uid);
    if (scoped === null) storage.setItem(localKey(uid), JSON.stringify(data));
    return data;
  } catch (error) {
    console.error('Failed to read local data:', error);
    return empty;
  }
}

export function writeLocalData<P extends OwnedRecord, S extends OwnedRecord>(
  storage: StorageLike,
  uid: string | null,
  data: LocalAppData<P, S>
): void {
  if (!uid) return;
  storage.setItem(localKey(uid), JSON.stringify(filterOwnedData<P, S>(data, uid)));
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterOwnedData, readLocalData, writeLocalData } from '../src/firebase/localData';

interface Entry { userId: string; title: string }

function createStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

test('legacy backup only imports records owned by the signed-in user', () => {
  const storage = createStorage({
    inkwell_local_data: JSON.stringify({
      presets: [{ userId: 'alice', title: 'Alice preset' }, { userId: 'bob', title: 'Bob preset' }],
      stories: [{ userId: 'bob', title: 'Bob story' }],
    }),
  });

  assert.deepEqual(readLocalData<Entry, Entry>(storage, 'alice'), {
    presets: [{ userId: 'alice', title: 'Alice preset' }], stories: [],
  });
  assert.deepEqual(readLocalData<Entry, Entry>(storage, 'bob'), {
    presets: [{ userId: 'bob', title: 'Bob preset' }],
    stories: [{ userId: 'bob', title: 'Bob story' }],
  });
  assert.deepEqual(readLocalData<Entry, Entry>(storage, null), { presets: [], stories: [] });
});

test('each account writes and reads its own backup', () => {
  const storage = createStorage();
  const alice = { presets: [], stories: [{ userId: 'alice', title: 'Private draft' }] };
  writeLocalData(storage, 'alice', alice);

  assert.deepEqual(readLocalData<Entry, Entry>(storage, 'alice'), alice);
  assert.deepEqual(readLocalData<Entry, Entry>(storage, 'bob'), { presets: [], stories: [] });
});

test('records from another account are excluded before display or backup', () => {
  const mixed = {
    presets: [{ userId: 'alice', title: 'Own preset' }, { userId: 'bob', title: 'Other preset' }],
    stories: [{ userId: 'bob', title: 'Other story' }],
  };
  const storage = createStorage();
  writeLocalData(storage, 'alice', mixed);

  assert.deepEqual(filterOwnedData<Entry, Entry>(mixed, 'alice'), {
    presets: [{ userId: 'alice', title: 'Own preset' }], stories: [],
  });
  assert.deepEqual(readLocalData<Entry, Entry>(storage, 'alice'), {
    presets: [{ userId: 'alice', title: 'Own preset' }], stories: [],
  });
});

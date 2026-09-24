import { auth, logout, safeStorage } from './auth';
import { filterOwnedData, readLocalData, writeLocalData } from './localData';

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'error' | 'unauthorized';
export type SyncListener = (status: SyncStatus, lastSynced?: Date, errorMsg?: string) => void;

let syncStatus: SyncStatus = 'idle';
let lastSynced: Date | undefined = undefined;
let syncErrorMsg: string | undefined = undefined;
const listeners = new Set<SyncListener>();

export function getSyncStatus(): { status: SyncStatus; lastSynced?: Date; errorMsg?: string } {
  return { status: syncStatus, lastSynced, errorMsg: syncErrorMsg };
}

export function addSyncListener(listener: SyncListener) {
  listeners.add(listener);
  listener(syncStatus, lastSynced, syncErrorMsg);
  return () => {
    listeners.delete(listener);
  };
}

export function updateSyncStatus(status: SyncStatus, errorMsg?: string) {
  syncStatus = status;
  if (status === 'synced') {
    lastSynced = new Date();
    syncErrorMsg = undefined;
  } else if (status === 'error' || status === 'unauthorized') {
    syncErrorMsg = errorMsg;
  }
  listeners.forEach(l => l(syncStatus, lastSynced, syncErrorMsg));
}

export function forceResetCache() {
  cachedData = null;
  driveFileId = null;
  driveFolderId = null;
  loadPromise = null;
  updateSyncStatus('idle');
}

export function generateSafeUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch (_) {}
  }
  // Robust RFC4122 version 4 compliant fallback UUID generator for sandboxed iframe compatibility
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// Data Types
export interface Preset {
  id?: string;
  userId: string;
  title: string;
  prompt: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Story {
  id?: string;
  userId: string;
  title: string;
  model: string;
  history: any[]; // { role, text }
  presetId?: string;
  systemInstruction?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface AppData {
  presets: Preset[];
  stories: Story[];
}

const DRIVE_FOLDER_NAME = 'inkwell';
const DRIVE_DATA_FILE_NAME = 'inkwell_ai_data_v3.json';

let cachedData: AppData | null = null;
let cachedUserId: string | null = null;
let driveFileId: string | null = null;
let driveFolderId: string | null = null;
let loadPromise: Promise<AppData> | null = null;

// Auth wrapper to fetch Google Drive resources
async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
  const token = safeStorage.getItem('google_drive_access_token');
  if (!token) {
    throw new Error("AUTH_REQUIRED: Please sign in with Google to access your Google Drive.");
  }
  
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  
  const response = await fetch(url, { ...options, headers });
  
  if (response.status === 401) {
    // Clear expired token and trigger unauthorized state so user can re-authenticate
    safeStorage.removeItem('google_drive_access_token');
    cachedData = null;
    driveFileId = null;
    driveFolderId = null;
    loadPromise = null;
    updateSyncStatus('unauthorized', 'Your Google session has expired. Please reconnect to enable cloud sync.');
    throw new Error("GOOGLE_DRIVE_UNAUTHORIZED: Your Google session has expired. Please reconnect to enable cloud sync.");
  }
  
  return response;
}

// Locate or create the inkwell folder
async function getOrCreateDriveFolderId(): Promise<string> {
  if (driveFolderId) return driveFolderId;
  
  const q = `name = '${DRIVE_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`;
  
  try {
    const res = await fetchWithAuth(url);
    if (!res.ok) throw new Error(`Failed to list space files: ${res.statusText}`);
    const data = await res.json();
    if (data.files && data.files.length > 0) {
      driveFolderId = data.files[0].id;
      return driveFolderId;
    }
  } catch (err: any) {
    if (err && err.message && (err.message.includes("AUTH_REQUIRED") || err.message.includes("GOOGLE_DRIVE_UNAUTHORIZED"))) {
      console.warn("Folder search skipped or unauthorized:", err.message);
    } else {
      console.error("Error searching Google Drive for folder:", err);
    }
    throw err;
  }
  
  // Create folder
  try {
    const res = await fetchWithAuth('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: DRIVE_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder'
      })
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to create folder on Google Drive: ${text}`);
    }
    const data = await res.json();
    driveFolderId = data.id;
    return data.id;
  } catch (err: any) {
    if (err && err.message && (err.message.includes("AUTH_REQUIRED") || err.message.includes("GOOGLE_DRIVE_UNAUTHORIZED"))) {
      console.warn("Folder creation skipped or unauthorized:", err.message);
    } else {
      console.error("Error creating Google Drive folder:", err);
    }
    throw err;
  }
}

// Locate or create the app data file on Google Drive
async function getDriveFileId(): Promise<string | null> {
  if (driveFileId) return driveFileId;
  
  const folderId = await getOrCreateDriveFolderId();
  
  const q = `name = '${DRIVE_DATA_FILE_NAME}' and '${folderId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`;
  
  try {
    const res = await fetchWithAuth(url);
    if (!res.ok) {
      throw new Error(`Failed to list space files: ${res.statusText}`);
    }
    const data = await res.json();
    if (data.files && data.files.length > 0) {
      driveFileId = data.files[0].id;
      return driveFileId;
    }
  } catch (err: any) {
    if (err && err.message && (err.message.includes("AUTH_REQUIRED") || err.message.includes("GOOGLE_DRIVE_UNAUTHORIZED"))) {
      console.warn("File search skipped or unauthorized:", err.message);
    } else {
      console.error("Error searching Google Drive for file:", err);
    }
    throw err;
  }
  return null;
}

async function createDriveFile(initialContent: AppData): Promise<string> {
  const folderId = await getOrCreateDriveFolderId();
  const boundary = '314159265358979323846';
  const delimiter = "\r\n--" + boundary + "\r\n";
  const close_delim = "\r\n--" + boundary + "--";

  const metadata = {
    name: DRIVE_DATA_FILE_NAME,
    mimeType: 'application/json',
    description: 'Inkwell AI Story and Preset App Data',
    parents: [folderId]
  };

  const multipartRequestBody =
    delimiter +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) +
    delimiter +
    'Content-Type: application/json\r\n\r\n' +
    JSON.stringify(initialContent) +
    close_delim;

  try {
    const res = await fetchWithAuth('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body: multipartRequestBody
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to create data file on Google Drive: ${text}`);
    }

    const fileInfo = await res.json();
    if (!fileInfo.id) {
      throw new Error("Failed to parse file creation metadata from Google Drive.");
    }
    
    driveFileId = fileInfo.id;
    return fileInfo.id;
  } catch (err: any) {
    if (err && err.message && (err.message.includes("AUTH_REQUIRED") || err.message.includes("GOOGLE_DRIVE_UNAUTHORIZED"))) {
      console.warn("File creation skipped or unauthorized:", err.message);
    } else {
      console.error("Error creating Google Drive file:", err);
    }
    throw err;
  }
}

async function downloadDriveFile(fileId: string): Promise<AppData> {
  try {
    const res = await fetchWithAuth(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) {
      throw new Error(`Failed to download file from Google Drive: ${res.statusText}`);
    }
    const content = await res.json();
    return content;
  } catch (err: any) {
    if (err && err.message && (err.message.includes("AUTH_REQUIRED") || err.message.includes("GOOGLE_DRIVE_UNAUTHORIZED"))) {
      console.warn("File download skipped or unauthorized:", err.message);
    } else {
      console.error("Error downloading file contents:", err);
    }
    throw err;
  }
}

function getLocalData(): AppData {
  return readLocalData<Preset, Story>(safeStorage, auth.currentUser?.uid || null);
}

function saveLocalData(data: AppData): void {
  try {
    writeLocalData(safeStorage, auth.currentUser?.uid || null, data);
  } catch (e) {
    console.error("Failed to save local data:", e);
  }
}

// Public API for updating the Google Drive file
export async function saveData(data: AppData): Promise<void> {
  cachedData = data; // update local cache instantly for ultimate responsive UI
  saveLocalData(data); // keep local backup synchronized

  const token = safeStorage.getItem('google_drive_access_token');
  if (!token) {
    updateSyncStatus('unauthorized', 'Please sign in with Google to enable cloud backup.');
    return; // saved locally, return gracefully
  }

  updateSyncStatus('syncing');

  try {
    let fileId = await getDriveFileId();
    if (!fileId) {
      await createDriveFile(data);
      updateSyncStatus('synced');
      return;
    }

    const res = await fetchWithAuth(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed to synchronize with Google Drive: ${errText}`);
    }
    updateSyncStatus('synced');
  } catch (err: any) {
    const isAuthErr = err && err.message && (err.message.includes("AUTH_REQUIRED") || err.message.includes("GOOGLE_DRIVE_UNAUTHORIZED"));
    if (isAuthErr) {
      console.warn("Data save skipped or unauthorized:", err.message);
      updateSyncStatus('unauthorized', 'Session expired. Please reconnect to enable cloud sync.');
    } else {
      console.error("Error saving data to Google Drive:", err);
      updateSyncStatus('error', err.message || String(err));
    }
    // Do NOT rethrow. Since it has been successfully saved locally, we return gracefully to the caller.
  }
}

export async function loadData(): Promise<AppData> {
  const currentUid = auth.currentUser?.uid || null;
  if (cachedUserId !== currentUid) {
    // Invalidate caches if user signed out or toggled
    cachedData = null;
    driveFileId = null;
    driveFolderId = null;
    loadPromise = null;
    cachedUserId = currentUid;
  }

  if (cachedData) return cachedData;
  if (loadPromise) return loadPromise;

  const token = safeStorage.getItem('google_drive_access_token');
  if (!token) {
    // Gracefully load from local storage fallback
    const local = getLocalData();
    cachedData = local;
    updateSyncStatus('unauthorized', 'Please sign in with Google to enable cloud backup.');
    return local;
  }

  updateSyncStatus('syncing');

  loadPromise = (async () => {
    try {
      let fileId = await getDriveFileId();
      let content: AppData;
      if (!fileId) {
        let defaultData = getLocalData();
        if (defaultData.presets.length === 0 && defaultData.stories.length === 0) {
          defaultData = {
            presets: [],
            stories: []
          };
          
          // Try migrating from v2 file
          try {
            const q = `name = 'inkwell_ai_data_v2.json' and trashed = false`;
            const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`;
            const res = await fetchWithAuth(url);
            if (res.ok) {
              const data = await res.json();
              if (data.files && data.files.length > 0) {
                const v2Content = await downloadDriveFile(data.files[0].id);
                defaultData = {
                  presets: v2Content.presets || [],
                  stories: v2Content.stories || []
                };
                console.log("Migrated data from v2 Google Drive file.");
              }
            }
          } catch (migrationErr) {
            console.warn("Failed to check for v2 data migration:", migrationErr);
          }
        }

        await createDriveFile(defaultData);
        content = defaultData;
      } else {
        content = await downloadDriveFile(fileId);
      }
      
      cachedData = currentUid
        ? filterOwnedData<Preset, Story>(content, currentUid)
        : { presets: [], stories: [] };
      
      saveLocalData(cachedData);
      updateSyncStatus('synced');
      return cachedData;
    } catch (err: any) {
      loadPromise = null; // reset so we can retry on error
      console.warn("Retrying Google Drive file loading due to error:", err);
      
      // Fallback to local storage copy so the user is never blocked
      const local = getLocalData();
      cachedData = local;

      if (err.message && err.message.includes("GOOGLE_DRIVE_UNAUTHORIZED")) {
        updateSyncStatus('unauthorized', 'Session expired. Please reconnect to enable cloud sync.');
      } else {
        updateSyncStatus('error', err.message || String(err));
      }
      // Return local data gracefully
      return local;
    }
  })();

  return loadPromise;
}

// Preset APIs
export async function getPresets(): Promise<Preset[]> {
  try {
    const data = await loadData();
    return data.presets;
  } catch (err: any) {
    if (err && err.message && (err.message.includes("AUTH_REQUIRED") || err.message.includes("GOOGLE_DRIVE_UNAUTHORIZED"))) {
      console.warn("Failed to load presets due to auth status:", err.message);
    } else {
      console.error("Failed to load presets:", err);
    }
    return [];
  }
}

// Serialized operation queue to prevent race conditions during concurrent updates
let dbOperationQueue: Promise<any> = Promise.resolve();

function enqueueDbOperation<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    dbOperationQueue = dbOperationQueue
      .then(() => operation())
      .then(resolve)
      .catch(reject);
  });
}

export async function createPreset(id: string, presetData: Partial<Preset>): Promise<void> {
  return enqueueDbOperation(async () => {
    const current = await loadData();
    const newPreset: Preset = {
      id,
      userId: auth.currentUser?.uid || 'user',
      title: presetData.title || '',
      prompt: presetData.prompt || '',
      model: presetData.model || 'gemini-3.8-flash',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const updated: AppData = {
      ...current,
      presets: [...current.presets.filter(p => p.id !== id), newPreset]
    };

    await saveData(updated);
  });
}

export async function updatePreset(id: string, presetData: Partial<Preset>): Promise<void> {
  return enqueueDbOperation(async () => {
    const current = await loadData();
    const presets = current.presets.map(p => {
      if (p.id === id) {
        return {
          ...p,
          ...presetData,
          updatedAt: new Date().toISOString()
        };
      }
      return p;
    });

    const updated: AppData = {
      ...current,
      presets
    };

    await saveData(updated);
  });
}

export async function deletePreset(id: string): Promise<void> {
  return enqueueDbOperation(async () => {
    const current = await loadData();
    const updated: AppData = {
      ...current,
      presets: current.presets.filter(p => p.id !== id)
    };

    await saveData(updated);
  });
}

// Story APIs
export async function getStories(): Promise<Story[]> {
  try {
    const data = await loadData();
    return data.stories;
  } catch (err: any) {
    if (err && err.message && (err.message.includes("AUTH_REQUIRED") || err.message.includes("GOOGLE_DRIVE_UNAUTHORIZED"))) {
      console.warn("Failed to load stories due to auth status:", err.message);
    } else {
      console.error("Failed to load stories:", err);
    }
    return [];
  }
}

export async function getStory(id: string): Promise<Story | null> {
  const data = await loadData();
  const story = data.stories.find(s => s.id === id);
  return story || null;
}

export async function createStory(id: string, storyData: Partial<Story>): Promise<void> {
  return enqueueDbOperation(async () => {
    const current = await loadData();
    const newStory: Story = {
      id,
      userId: auth.currentUser?.uid || 'user',
      title: storyData.title || 'Untitled Story',
      model: storyData.model || 'gemini-3.8-flash',
      history: storyData.history || [],
      presetId: storyData.presetId || undefined,
      systemInstruction: storyData.systemInstruction || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const updated: AppData = {
      ...current,
      stories: [...current.stories.filter(s => s.id !== id), newStory]
    };

    await saveData(updated);
  });
}

export async function updateStory(id: string, storyData: Partial<Story>): Promise<void> {
  return enqueueDbOperation(async () => {
    const current = await loadData();
    const stories = current.stories.map(s => {
      if (s.id === id) {
        return {
          ...s,
          ...storyData,
          updatedAt: new Date().toISOString()
        };
      }
      return s;
    });

    const updated: AppData = {
      ...current,
      stories
    };

    await saveData(updated);
  });
}

export async function deleteStory(id: string): Promise<void> {
  return enqueueDbOperation(async () => {
    const current = await loadData();
    const updated: AppData = {
      ...current,
      stories: current.stories.filter(s => s.id !== id)
    };

    await saveData(updated);
  });
}

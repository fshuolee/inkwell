import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User, signOut, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = (firebaseConfig as any).firestoreDatabaseId
  ? getFirestore(app, (firebaseConfig as any).firestoreDatabaseId)
  : getFirestore(app);

const memoryStorage: Record<string, string> = {};

export const safeStorage = {
  getItem(key: string): string | null {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return localStorage.getItem(key);
      }
    } catch (e) {
      console.warn("Storage access failed, falling back to memory:", e);
    }
    return memoryStorage[key] || null;
  },
  setItem(key: string, value: string): void {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.setItem(key, value);
        return;
      }
    } catch (e) {
      console.warn("Storage set failed, falling back to memory:", e);
    }
    memoryStorage[key] = value;
  },
  removeItem(key: string): void {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        localStorage.removeItem(key);
        return;
      }
    } catch (e) {
      console.warn("Storage remove failed, falling back to memory:", e);
    }
    delete memoryStorage[key];
  }
};

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive.file');

let isSigningIn = false;
let cachedAccessToken: string | null = safeStorage.getItem('google_drive_access_token');

export const initAuth = (
  onAuthSuccess?: (user: User, token: string | null) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
    } else {
      cachedAccessToken = null;
      safeStorage.removeItem('google_drive_access_token');
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const googleSignIn = async (onAuthSuccess?: (user: User, token: string | null) => void): Promise<{ user: User; accessToken: string } | null> => {
  try {
    try {
      await setPersistence(auth, browserLocalPersistence);
    } catch (persistenceError) {
      console.warn('Could not set persistence, proceeding with sign in:', persistenceError);
    }
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      console.warn('Failed to get access token from Firebase Auth, Google Drive export may not work.');
    } else {
        cachedAccessToken = credential.accessToken;
        safeStorage.setItem('google_drive_access_token', credential.accessToken);
    }
    if (onAuthSuccess) onAuthSuccess(result.user, cachedAccessToken);
    return { user: result.user, accessToken: cachedAccessToken || '' };
  } catch (error: any) {
    const errorStr = String(error?.code || error?.message || error);
    if (errorStr.includes('popup-closed-by-user') || errorStr.includes('cancelled-popup-request')) {
      console.warn('Sign in was closed or cancelled by user:', error);
    } else {
      console.error('Sign in error:', error);
    }
    throw error;
  }
};

export const getAccessToken = (): string | null => {
  return cachedAccessToken || safeStorage.getItem('google_drive_access_token');
};

export const logout = async () => {
  await signOut(auth);
  cachedAccessToken = null;
  safeStorage.removeItem('google_drive_access_token');
};

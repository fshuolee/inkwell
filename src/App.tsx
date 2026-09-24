/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { User } from 'firebase/auth';
import { initAuth, googleSignIn, logout } from './firebase/auth';
import { getStories, Story, addSyncListener, SyncStatus, forceResetCache, deleteStory } from './firebase/db';
import { LogOut, BookOpen, Settings, PlusCircle, FileText, Cloud, CloudOff, RefreshCw, Check, AlertCircle, Trash2, Loader2, Sliders, Sparkles } from 'lucide-react';
import StoryEditor from './components/StoryEditor';
import PresetManager from './components/PresetManager';
import SettingsPage from './components/SettingsPage';
import { StoryGenerationProvider, useStoryGeneration } from './context/StoryGenerationContext';
import { SettingsProvider } from './context/SettingsContext';

function AppContent() {
  const { isStoryGenerating, stopGeneration } = useStoryGeneration();

  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isAuthPending, setIsAuthPending] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSigningIn, setIsSigningIn] = useState(false);
  
  const [activeTab, setActiveTab] = useState<'editor' | 'presets' | 'settings'>('editor');
  const [activeStoryId, setActiveStoryId] = useState<string | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [storyToDelete, setStoryToDelete] = useState<string | null>(null);

  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [lastSynced, setLastSynced] = useState<Date | undefined>(undefined);
  const [syncError, setSyncError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const unsubAuth = initAuth(
      (u, t) => {
        setUser(u);
        setToken(t);
        setIsAuthPending(false);
        if (t) {
          loadUserStories();
        }
      },
      () => {
        setUser(null);
        setToken(null);
        setIsAuthPending(false);
      }
    );
    return () => unsubAuth();
  }, []);

  useEffect(() => {
    if (!user) return;
    const unsubSync = addSyncListener((status, lastSyn, err) => {
      setSyncStatus(status);
      setLastSynced(lastSyn);
      setSyncError(err);
    });
    return () => unsubSync();
  }, [user]);

  // Automatically reconnect & sync user stories when network connection returns online
  useEffect(() => {
    const handleOnline = () => {
      if (user && token) {
        forceResetCache();
        loadUserStories();
      }
    };
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [user, token]);

  // Automatically refresh stories list when any background story generation completes and saves
  useEffect(() => {
    const handleStorySaved = () => {
      loadUserStories();
    };
    window.addEventListener('inkwell:story-saved', handleStorySaved);
    return () => window.removeEventListener('inkwell:story-saved', handleStorySaved);
  }, []);

  const loadUserStories = async () => {
    try {
      const data = await getStories();
      setStories(data);
    } catch (err: any) {
      console.error("Failed to load stories:", err.message);
      if (err.message && err.message.includes('GOOGLE_DRIVE_UNAUTHORIZED')) {
        setAuthError("Google Drive session expired. Please connect again to preserve sync.");
      } else if (err.message && (err.message.includes('AUTH_REQUIRED') || err.message.includes('SESSION_EXPIRED'))) {
        setAuthError("Session expired or missing Google Drive permissions. Please sign in again.");
        await logout();
      }
    }
  };

  const handleDeleteStoryConfirm = async () => {
    if (!storyToDelete) return;
    try {
      await stopGeneration(storyToDelete);
      await deleteStory(storyToDelete);
      if (activeStoryId === storyToDelete) {
        setActiveStoryId(null);
      }
      setStoryToDelete(null);
      await loadUserStories();
    } catch (err: any) {
      console.error("Failed to delete story:", err);
    }
  };

  const handleSelectTab = (tab: 'editor' | 'presets' | 'settings', storyId: string | null = null) => {
    setActiveTab(tab);
    setActiveStoryId(storyId);
    setIsSidebarOpen(false);
  };

  const handleSignIn = async () => {
    setAuthError(null);
    setIsSigningIn(true);
    try {
      const result = await googleSignIn((u, t) => {
        setUser(u);
        setToken(t);
        // Force database reset and restore fresh synced data
        forceResetCache();
        loadUserStories();
      });
      if (!result) {
        throw new Error("Could not authenticate user.");
      }
    } catch (err: any) {
      const errorMsgStr = String(err?.message || err);
      if (errorMsgStr.includes("popup-closed-by-user") || errorMsgStr.includes("cancelled-popup-request")) {
        console.warn("User cancelled sign in popup:", err);
      } else {
        console.error(err);
      }
      let errorMsg = err?.message || String(err);
      if (errorMsg.includes("popup-closed-by-user") || errorMsg.includes("popup_closed_by_user")) {
        errorMsg = "Login popup was closed. Please try again and complete the sign-in flow.";
      } else if (errorMsg.includes("popup-blocked") || errorMsg.includes("popup_blocked")) {
        errorMsg = "Browser popup was blocked. Please permit popups or open the app in a new tab using the icon in the top right of the preview.";
      } else if (errorMsg.includes("cancelled-popup") || errorMsg.includes("cancelled_popup_request")) {
        errorMsg = "Popup request cancelled. If you see a permission error, please sign out completely and try again.";
      }
      setAuthError(errorMsg);
    } finally {
      setIsSigningIn(false);
    }
  };

  if (isAuthPending) {
    return <div className="flex h-screen items-center justify-center bg-zinc-950 text-zinc-400">Loading...</div>;
  }

  if (!user || !token) {
    return (
      <div className="flex flex-col h-screen items-center justify-center bg-zinc-900 text-zinc-100 font-sans p-4">
        <div className="max-w-md w-full p-8 bg-zinc-800 rounded-xl shadow-2xl space-y-8 text-center border border-zinc-700">
          <BookOpen className="w-16 h-16 mx-auto text-blue-400" />
          <div>
            <h1 className="text-3xl font-bold tracking-tight mb-2">Inkwell AI</h1>
            <p className="text-zinc-400">{user ? 'Google Drive Link Required' : 'Your intelligent story generator'}</p>
          </div>

          <button
            onClick={handleSignIn}
            disabled={isSigningIn}
            className="flex items-center justify-center w-full gap-3 py-3 px-4 bg-white text-zinc-900 font-medium rounded-lg hover:bg-gray-100 disabled:opacity-50 transition-colors cursor-pointer"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
              />
            </svg>
            {isSigningIn ? 'Connecting to Google...' : (user ? 'Reconnect with Google Drive' : 'Sign in with Google')}
          </button>

          {authError && (
            <div className="p-3 bg-red-900/30 border border-red-800 rounded-lg text-sm text-red-400">
              {authError}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 font-sans overflow-hidden">
      {/* Sidebar Overlay for Mobile */}
      {isSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/60 z-20 md:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className={`
        fixed md:static inset-y-0 left-0 z-30
        w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col
        transform transition-transform duration-200 ease-in-out
        ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="w-5 h-5 text-blue-400" />
            <span className="font-semibold text-base tracking-wide">Inkwell AI</span>
          </div>
          <button 
            onClick={() => setIsSidebarOpen(false)}
            className="md:hidden text-zinc-400 hover:text-white"
          >
            &times;
          </button>
        </div>

        <div className="p-4 space-y-4 flex-1 overflow-y-auto">
          <button
             onClick={() => handleSelectTab('editor', null)}
             className="w-full flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-3 py-2 rounded-md text-sm font-medium transition-colors shadow-sm cursor-pointer"
          >
            <PlusCircle className="w-4 h-4" />
            New Story
          </button>

          <div className="space-y-1">
            <button
              onClick={() => handleSelectTab('editor', activeStoryId)}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${activeTab === 'editor' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'}`}
            >
              <FileText className="w-4 h-4" />
              Editor
            </button>
            <button
              onClick={() => handleSelectTab('presets')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${activeTab === 'presets' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'}`}
            >
              <Sparkles className="w-4 h-4" />
              System Prompts
            </button>
            <button
              onClick={() => handleSelectTab('settings')}
              className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors cursor-pointer ${activeTab === 'settings' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'}`}
            >
              <Sliders className="w-4 h-4" />
              Settings
            </button>
          </div>

          <div>
             <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">My Stories</div>
             <div className="space-y-1">
               {stories.map(story => {
                 const isGenerating = story.id ? isStoryGenerating(story.id) : false;
                 const isActive = activeTab === 'editor' && activeStoryId === story.id;
                 return (
                   <div
                     key={story.id}
                     className={`group flex items-center justify-between w-full rounded-md text-sm transition-colors ${isActive ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'}`}
                   >
                     <button 
                       onClick={() => handleSelectTab('editor', story.id!)}
                       className="flex items-center gap-2.5 px-3 py-2 text-left truncate flex-1 min-w-0 cursor-pointer"
                     >
                       <FileText className="w-4 h-4 shrink-0" />
                       <span className="truncate flex-1">{story.title || 'Untitled'}</span>
                       {isGenerating && (
                         <span className="flex items-center gap-1 text-[11px] text-blue-400 font-medium shrink-0 ml-1">
                           <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400 shrink-0" />
                           <span className="hidden xl:inline text-[10px] text-blue-400">Generating</span>
                         </span>
                       )}
                     </button>
                     <button
                       onClick={(e) => {
                         e.stopPropagation();
                         setStoryToDelete(story.id || null);
                       }}
                       className="p-1.5 text-zinc-500 hover:text-red-400 rounded transition-colors mr-1 opacity-0 group-hover:opacity-100 focus:opacity-100 cursor-pointer"
                       title="Delete Story"
                     >
                       <Trash2 className="w-3.5 h-3.5" />
                     </button>
                   </div>
                 );
               })}
               {stories.length === 0 && (
                  <div className="text-xs text-zinc-600 px-3 py-2 border border-dashed border-zinc-800 rounded-md text-center">No stories saved</div>
               )}
             </div>
          </div>
        </div>

        {/* Google Drive Cloud Sync Status block */}
        <div className="px-4 py-3.5 border-t border-zinc-850 bg-zinc-900/30 select-none">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
              <span>Cloud Storage Status</span>
              {syncStatus === 'syncing' && (
                <RefreshCw className="w-3.5 h-3.5 text-blue-400 animate-spin" />
              )}
              {syncStatus === 'synced' && (
                <Check className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
              )}
              {syncStatus === 'unauthorized' && (
                <CloudOff className="w-3.5 h-3.5 text-amber-500" />
              )}
              {syncStatus === 'error' && (
                <AlertCircle className="w-3.5 h-3.5 text-red-400" />
              )}
            </div>

            <div className="flex flex-col gap-1">
              {syncStatus === 'syncing' && (
                <span className="text-xs text-zinc-400 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-ping"></span>
                  Saving changes...
                </span>
              )}
              {syncStatus === 'synced' && (
                <span className="text-xs text-zinc-400 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                  <span>Synced: {lastSynced ? lastSynced.toLocaleTimeString() : 'Just now'}</span>
                </span>
              )}
              {syncStatus === 'unauthorized' && (
                <div className="space-y-2 py-0.5">
                  <div className="text-[11px] text-amber-400 font-medium leading-normal">Session expired. Cloud sync paused.</div>
                  <button
                    onClick={handleSignIn}
                    disabled={isSigningIn}
                    className="w-full text-center text-xs py-1.5 px-2.5 bg-amber-600/10 hover:bg-amber-600/25 text-amber-300 border border-amber-500/20 rounded-md font-semibold transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {isSigningIn ? 'Connecting...' : 'Reconnect Google Drive'}
                  </button>
                </div>
              )}
              {syncStatus === 'error' && (
                <div className="space-y-2 py-0.5">
                  <div className="text-[11px] text-red-400 font-medium leading-normal truncate" title={syncError}>
                    Sync failure: {syncError || 'Unknown error'}
                  </div>
                  <button
                    onClick={() => {
                      forceResetCache();
                      loadUserStories();
                    }}
                    className="w-full text-center text-xs py-1.5 px-2.5 bg-red-600/10 hover:bg-red-600/25 text-red-300 border border-red-500/20 rounded-md font-semibold transition-colors cursor-pointer"
                  >
                    Retry Sync
                  </button>
                </div>
              )}
              {syncStatus === 'idle' && (
                <span className="text-xs text-zinc-500 flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-600"></span>
                  Ready & connected.
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-zinc-800">
           <div className="flex items-center gap-3 text-sm text-zinc-400">
             <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center text-xs font-bold text-white shrink-0">
               {user.email?.[0].toUpperCase()}
             </div>
             <div className="flex-1 truncate">
               <div className="truncate">{user.email}</div>
             </div>
             <button onClick={logout} className="p-1 hover:text-red-400 transition-colors cursor-pointer" title="Sign out">
                <LogOut className="w-4 h-4" />
             </button>
           </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col relative min-w-0">
        {activeTab === 'editor' ? (
          <StoryEditor 
            activeStoryId={activeStoryId} 
            onStoryChange={(id) => {
              setActiveStoryId(id);
              loadUserStories();
            }}
            onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)}
            onOpenSettings={() => handleSelectTab('settings')}
          />
        ) : activeTab === 'presets' ? (
          <PresetManager onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)} />
        ) : (
          <SettingsPage 
            onToggleSidebar={() => setIsSidebarOpen(!isSidebarOpen)} 
            onBackToEditor={() => handleSelectTab('editor', activeStoryId)}
          />
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {storyToDelete && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-[100]">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2 mb-2">
              <Trash2 className="w-5 h-5 text-red-400 shrink-0" />
              Delete Story
            </h3>
            <p className="text-xs text-zinc-350 mb-5 leading-relaxed">
              Are you sure you want to delete this story? This action is permanent, deleting it from both local cache and Google Drive storage.
            </p>
            <div className="flex justify-end gap-2.5">
              <button 
                onClick={() => setStoryToDelete(null)}
                className="px-3.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-205 text-xs transition-colors font-medium border border-zinc-700 cursor-pointer"
              >
                Cancel
              </button>
              <button 
                onClick={handleDeleteStoryConfirm}
                className="px-3.5 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white text-xs transition-colors font-semibold shadow cursor-pointer"
              >
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <SettingsProvider>
      <StoryGenerationProvider>
        <AppContent />
      </StoryGenerationProvider>
    </SettingsProvider>
  );
}

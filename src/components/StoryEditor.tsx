/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Story, Preset, getPresets, createStory, updateStory, generateSafeUUID, getStory, deleteStory } from '../firebase/db';
import { auth } from '../firebase/auth';
import { authenticatedFetch } from '../firebase/api';
import { Send, Save, DownloadCloud, Loader2, FileText, RefreshCw, AlertCircle, Menu, X, CheckCircle2, Settings, Play, Edit2, Check, Square, Trash2, WifiOff, Sliders } from 'lucide-react';
import Markdown from 'react-markdown';
import { getAccessToken, googleSignIn } from '../firebase/auth';
import { Message, ReconnectState, useStoryGeneration } from '../context/StoryGenerationContext';
import { useSettings } from '../context/SettingsContext';

export default function StoryEditor({
  activeStoryId,
  onStoryChange,
  onToggleSidebar,
  onOpenSettings
}: {
  activeStoryId: string | null;
  onStoryChange: (id: string | null) => void;
  onToggleSidebar: () => void;
  onOpenSettings?: () => void;
}) {
  const { settings } = useSettings();
  const {
    isStoryGenerating,
    getGenerationSession,
    startGeneration,
    stopGeneration,
    cancelAutoReconnect,
    triggerImmediateReconnect,
    clearStoryError,
    subscribeToStory
  } = useStoryGeneration();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [title, setTitle] = useState('');
  
  const [model, setModel] = useState(() => settings.defaultModel || 'gemini-2.5-flash-lite');
  const [availableModels, setAvailableModels] = useState<{name: string, displayName: string}[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string>('');
  const [systemInstruction, setSystemInstruction] = useState('');

  // Refs to guarantee 100% synchronous, current state when triggering immediate sends or continuation
  const systemInstructionRef = useRef<string>(systemInstruction);
  const selectedPresetIdRef = useRef<string>(selectedPresetId);
  const modelRef = useRef<string>(model);

  useEffect(() => {
    systemInstructionRef.current = systemInstruction;
  }, [systemInstruction]);

  useEffect(() => {
    selectedPresetIdRef.current = selectedPresetId;
  }, [selectedPresetId]);

  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);

  // Online status detection
  const [isOnline, setIsOnline] = useState<boolean>(() => typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [reconnectState, setReconnectState] = useState<ReconnectState>({
    isReconnecting: false,
    attempt: 0,
    maxAttempts: 3,
    countdown: 0,
  });

  // Safe UI modals & alerts to replace blocked window.confirm, window.alert, and window.prompt in iframe
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [saveErrorMsg, setSaveErrorMsg] = useState<string | null>(null);
  const [driveExportMsg, setDriveExportMsg] = useState<{ status: 'success' | 'error' | 'pending' | null, text: string }>({ status: null, text: '' });
  
  const [showSaveTitleModal, setShowSaveTitleModal] = useState(false);
  const [promptTitleInputValue, setPromptTitleInputValue] = useState('');
  const [showDriveConfirmModal, setShowDriveConfirmModal] = useState(false);
  const [showDriveAuthModal, setShowDriveAuthModal] = useState(false);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null);
  const [editingMessageContent, setEditingMessageContent] = useState<string>('');
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'unsaved' | 'saving' | 'saved' | 'error'>('idle');
  const lastSavedStateRef = useRef<string>('');
  const isStoryLoadingRef = useRef<boolean>(false);
  
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const shouldScrollRef = useRef<boolean>(true);

  const scrollToBottom = () => {
    if (settings.autoScroll === false) return;
    const container = chatContainerRef.current;
    if (container && shouldScrollRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  };

  const handleScroll = () => {
    const container = chatContainerRef.current;
    if (container) {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 120;
      shouldScrollRef.current = isNearBottom;
    }
  };

  // Monitor network connectivity
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Fetch available models and presets on mount
  useEffect(() => {
    loadPresets();
    fetchModels();
  }, []);

  // Subscribe to live generation updates for the currently active story
  useEffect(() => {
    if (!activeStoryId) {
      setIsLoading(false);
      setGenerationError(null);
      setReconnectState({
        isReconnecting: false,
        attempt: 0,
        maxAttempts: 3,
        countdown: 0
      });
      return;
    }

    const unsubscribe = subscribeToStory(activeStoryId, (session) => {
      setMessages(session.messages);
      setIsLoading(session.isGenerating);
      setGenerationError(session.error);
      setReconnectState(session.reconnectState);
      if (session.isGenerating) {
        scrollToBottom();
      }
    });

    return () => {
      unsubscribe();
    };
  }, [activeStoryId, subscribeToStory]);

  // Load or reset story when activeStoryId changes
  useEffect(() => {
    if (activeStoryId) {
      loadStory(activeStoryId);
    } else {
      // Reset for New Story
      isStoryLoadingRef.current = true;
      setMessages([]);
      setTitle('');
      setInput('');
      setSelectedPresetId('');
      selectedPresetIdRef.current = '';
      setSystemInstruction('');
      systemInstructionRef.current = '';
      const preferredModel = settings.defaultModel || 'gemini-2.5-flash-lite';
      setModel(preferredModel);
      modelRef.current = preferredModel;
      setGenerationError(null);
      setReconnectState({
        isReconnecting: false,
        attempt: 0,
        maxAttempts: 3,
        countdown: 0
      });
      setIsLoading(false);
      setAutoSaveStatus('idle');
      lastSavedStateRef.current = '';
      isStoryLoadingRef.current = false;
    }
  }, [activeStoryId]);

  // Listen for presets updated elsewhere (e.g. from PresetManager tab)
  useEffect(() => {
    const handlePresetsUpdated = async () => {
      await loadPresets();
    };
    window.addEventListener('inkwell:presets-updated', handlePresetsUpdated);
    return () => window.removeEventListener('inkwell:presets-updated', handlePresetsUpdated);
  }, []);

  // Auto-scroll when messages update
  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const fetchModels = async () => {
    try {
      const res = await authenticatedFetch('/api/models');
      if (res.ok) {
        const data = await res.json();
        setAvailableModels(data.models);
        if (data.models.length > 0 && !data.models.some((m: any) => m.name === model)) {
          setModel(data.models[0].name);
        }
      }
    } catch (e) {
      console.error("Failed to fetch models:", e);
      setAvailableModels([
        { name: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite (Recommended)' },
        { name: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' },
        { name: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash-Lite' },
        { name: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }
      ]);
    }
  };

  const loadPresets = async () => {
    try {
      const ps = await getPresets();
      setPresets(ps);
    } catch (e) {
      console.error("Failed to load presets:", e);
    }
  };

  const loadStory = async (id: string) => {
    isStoryLoadingRef.current = true;
    try {
      // Check if this story currently has an active background generation session
      const activeGen = getGenerationSession(id);
      if (activeGen && (activeGen.isGenerating || activeGen.reconnectState.isReconnecting)) {
        setMessages(activeGen.messages);
        setIsLoading(activeGen.isGenerating);
        setGenerationError(activeGen.error);
        setReconnectState(activeGen.reconnectState);
      } else {
        setIsLoading(false);
        setGenerationError(activeGen?.error || null);
        setReconnectState(activeGen?.reconnectState || {
          isReconnecting: false,
          attempt: 0,
          maxAttempts: 3,
          countdown: 0,
        });
      }

      const story = await getStory(id);
      if (story) {
        setTitle(story.title || '');
        // Safeguard: Never overwrite with a shorter history if an in-memory session has newer dialogue!
        let messagesToApply = story.history || [];
        if (activeGen?.messages && activeGen.messages.length >= messagesToApply.length) {
          messagesToApply = activeGen.messages;
        }
        setMessages(messagesToApply);

        const storyModel = story.model || 'gemini-2.5-flash-lite';
        setModel(storyModel);
        setSelectedPresetId(story.presetId || '');

        let instructionToSet = story.systemInstruction || '';
        if (!instructionToSet && story.presetId) {
          const currentPresets = presets.length > 0 ? presets : await getPresets();
          const matched = currentPresets.find(p => p.id === story.presetId);
          if (matched?.prompt) {
            instructionToSet = matched.prompt;
          }
        }
        setSystemInstruction(instructionToSet);
        systemInstructionRef.current = instructionToSet;
        setSelectedPresetId(story.presetId || '');
        selectedPresetIdRef.current = story.presetId || '';
        setModel(storyModel);
        modelRef.current = storyModel;

        lastSavedStateRef.current = JSON.stringify({
          title: story.title || '',
          messages: messagesToApply,
          model: storyModel,
          selectedPresetId: story.presetId || '',
          systemInstruction: instructionToSet
        });
        setAutoSaveStatus('idle');
      }
    } catch (err) {
      console.error("Failed to load story:", err);
    } finally {
      isStoryLoadingRef.current = false;
      setTimeout(() => scrollToBottom(), 50);
    }
  };

  // If presets load after a story with a presetId is opened, hydrate the systemInstruction
  useEffect(() => {
    if (selectedPresetId && !systemInstruction && presets.length > 0) {
      const p = presets.find(item => item.id === selectedPresetId);
      if (p?.prompt) {
        setSystemInstruction(p.prompt);
        systemInstructionRef.current = p.prompt;
      }
    }
  }, [presets, selectedPresetId, systemInstruction]);

  // Debounced auto-save for user edits (title, presets, manual message edits)
  useEffect(() => {
    if (!activeStoryId) return;
    if (isStoryLoadingRef.current) return;
    // When actively generating, StoryGenerationContext handles persistence on complete
    if (isStoryGenerating(activeStoryId)) return;

    const currentState = JSON.stringify({
      title,
      messages,
      model,
      selectedPresetId,
      systemInstruction
    });

    if (currentState === lastSavedStateRef.current) return;

    // If autoSave setting is disabled, mark as unsaved but do not trigger auto-save timer
    if (settings.autoSave === false) {
      setAutoSaveStatus('unsaved');
      return;
    }

    setAutoSaveStatus('unsaved');
    const timer = setTimeout(async () => {
      try {
        setAutoSaveStatus('saving');
        await updateStory(activeStoryId, {
          title: title || 'Untitled Story',
          history: messages,
          model,
          presetId: selectedPresetId || undefined,
          systemInstruction: systemInstruction || undefined
        });
        lastSavedStateRef.current = currentState;
        setAutoSaveStatus('saved');
      } catch (err) {
        console.error("Autosave failed:", err);
        setAutoSaveStatus('error');
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [title, messages, model, selectedPresetId, systemInstruction, activeStoryId, isStoryGenerating]);

  const handlePresetChange = async (presetId: string) => {
    setSelectedPresetId(presetId);
    selectedPresetIdRef.current = presetId;
    let newInstruction = '';
    let newModel = modelRef.current || model;
    let presetTitle = 'Default Persona';

    let currentPresets = presets;
    if (presetId && (!currentPresets || currentPresets.length === 0)) {
      try {
        currentPresets = await getPresets();
        setPresets(currentPresets);
      } catch (e) {
        console.error("Failed to load presets:", e);
      }
    }

    if (presetId) {
      const selected = currentPresets.find(p => p.id === presetId);
      if (selected) {
        newInstruction = selected.prompt;
        presetTitle = selected.title;
        if (selected.model) {
          newModel = selected.model;
          setModel(selected.model);
          modelRef.current = selected.model;
        }
      }
    }
    setSystemInstruction(newInstruction);
    systemInstructionRef.current = newInstruction;

    // If there is an active story, immediately persist the persona switch to the database
    // so that subsequent generations and page reloads reliably reflect the new persona
    if (activeStoryId) {
      try {
        await updateStory(activeStoryId, {
          presetId: presetId || undefined,
          systemInstruction: newInstruction || undefined,
          model: newModel
        });
        lastSavedStateRef.current = JSON.stringify({
          title,
          messages,
          model: newModel,
          selectedPresetId: presetId,
          systemInstruction: newInstruction
        });
        setAutoSaveStatus('saved');
        setSaveSuccessMsg(`Persona switched to "${presetTitle}". Subsequent generations will follow this style.`);
        setTimeout(() => setSaveSuccessMsg(null), 3500);
      } catch (err) {
        console.error("Failed to update story persona:", err);
      }
    }
  };

  const handleModelChange = (newModel: string) => {
    setModel(newModel);
    modelRef.current = newModel;
  };

  const handleSend = async (isRetry = false, customPrompt?: string, baseMessages?: Message[]) => {
    let historyToUse = baseMessages || messages;
    let promptToSend = customPrompt;

    let retryPartial = '';
    if (isRetry) {
      const lastMessage = historyToUse[historyToUse.length - 1];
      if (lastMessage?.role === 'model') retryPartial = lastMessage.text;
      // Find the last user prompt in historyToUse
      const lastUserIndex = historyToUse.map(m => m.role).lastIndexOf('user');
      if (lastUserIndex !== -1) {
        promptToSend = customPrompt || historyToUse[lastUserIndex].text;
        // The base history is all messages before this last user prompt
        historyToUse = historyToUse.slice(0, lastUserIndex);
      } else {
        promptToSend = customPrompt || input;
      }
    } else {
      promptToSend = customPrompt || input;
    }

    if (!promptToSend || !promptToSend.trim()) return;

    let targetStoryId = activeStoryId;
    let initialTitle = title;

    // Use synchronous refs to guarantee the immediate, active persona/system prompt is sent
    const currentModel = modelRef.current || model;
    const currentInstruction = systemInstructionRef.current !== undefined ? systemInstructionRef.current : systemInstruction;
    const currentPresetId = selectedPresetIdRef.current !== undefined ? selectedPresetIdRef.current : selectedPresetId;

    // If this is a brand-new unsaved story, generate a UUID and create it immediately
    // so switching stories while generating maintains full identity and state
    if (!targetStoryId) {
      targetStoryId = generateSafeUUID();
      initialTitle = title.trim() || promptToSend.trim().slice(0, 30) || 'Untitled Story';
      setTitle(initialTitle);
      await createStory(targetStoryId, {
        title: initialTitle,
        history: [{ role: 'user', text: promptToSend.trim() }],
        model: currentModel,
        presetId: currentPresetId || undefined,
        systemInstruction: currentInstruction || undefined,
        userId: auth.currentUser?.uid || 'user'
      });
      onStoryChange(targetStoryId);
    }

    if (!isRetry && !customPrompt) {
      setInput('');
    }

    await startGeneration({
      storyId: targetStoryId,
      prompt: promptToSend,
      model: currentModel,
      systemInstruction: currentInstruction,
      presetId: currentPresetId,
      baseHistory: historyToUse,
      isRetry: false,
      initialAccumulated: retryPartial,
      currentAttempt: 0,
      onStorySaved: (savedId) => {
        if (savedId === activeStoryId) {
          setAutoSaveStatus('saved');
        }
      }
    });
  };

  const handleRetryCurrent = () => {
    if (activeStoryId) clearStoryError(activeStoryId);
    setGenerationError(null);
    handleSend(true);
  };

  const handleSwitchModelAndRetry = (newModel: string) => {
    handleModelChange(newModel);
    if (activeStoryId) clearStoryError(activeStoryId);
    setGenerationError(null);
    setTimeout(() => {
      handleSend(true);
    }, 40);
  };

  const handleEditFailedPrompt = () => {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (lastUser) {
      setInput(lastUser.text);
    }
    if (activeStoryId) clearStoryError(activeStoryId);
    setGenerationError(null);
  };

  const handleStopGeneration = async () => {
    if (activeStoryId) {
      await stopGeneration(activeStoryId);
    }
  };

  const handleCancelAutoReconnect = () => {
    if (activeStoryId) {
      cancelAutoReconnect(activeStoryId);
    }
  };

  const handleTriggerImmediateReconnect = () => {
    if (activeStoryId) {
      triggerImmediateReconnect(activeStoryId);
    }
  };

  const handleDeleteActiveStory = async () => {
    if (!activeStoryId) return;
    setIsDeleting(true);
    try {
      await stopGeneration(activeStoryId);
      await deleteStory(activeStoryId);
      setShowDeleteConfirmModal(false);
      onStoryChange(null);
    } catch (err: any) {
      console.error("Failed to delete story:", err);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveErrorMsg(null);
    setSaveSuccessMsg(null);
    try {
      let storyTitle = title;
      if (!storyTitle) {
        setPromptTitleInputValue('My Interactive Story');
        setShowSaveTitleModal(true);
        setIsSaving(false);
        return;
      }
      
      let savedId = activeStoryId;
      if (!savedId) {
        savedId = generateSafeUUID();
        await createStory(savedId, {
          title: storyTitle,
          history: messages,
          model,
          presetId: selectedPresetId || undefined,
          systemInstruction: systemInstruction || undefined,
          userId: auth.currentUser?.uid || 'user'
        });
        onStoryChange(savedId);
      } else {
        await updateStory(savedId, {
          title: storyTitle,
          history: messages,
          model,
          presetId: selectedPresetId || undefined,
          systemInstruction: systemInstruction || undefined
        });
      }

      lastSavedStateRef.current = JSON.stringify({
        title: storyTitle,
        messages,
        model,
        selectedPresetId,
        systemInstruction
      });
      setAutoSaveStatus('saved');
      setSaveSuccessMsg("Story synced and saved successfully!");
      setTimeout(() => setSaveSuccessMsg(null), 3000);
    } catch (e: any) {
      console.error(e);
      setSaveErrorMsg("Error saving story: " + (e.message || e));
    } finally {
      setIsSaving(false);
    }
  };

  const handleModalSaveSubmit = async () => {
    const finalTitle = promptTitleInputValue.trim() || 'Untitled Story';
    setTitle(finalTitle);
    setShowSaveTitleModal(false);

    setIsSaving(true);
    try {
      let savedId = activeStoryId;
      if (!savedId) {
        savedId = generateSafeUUID();
        await createStory(savedId, {
          title: finalTitle,
          history: messages,
          model,
          presetId: selectedPresetId || undefined,
          systemInstruction: systemInstruction || undefined,
          userId: auth.currentUser?.uid || 'user'
        });
        onStoryChange(savedId);
      } else {
        await updateStory(savedId, {
          title: finalTitle,
          history: messages,
          model,
          presetId: selectedPresetId || undefined,
          systemInstruction: systemInstruction || undefined
        });
      }
      setAutoSaveStatus('saved');
      setSaveSuccessMsg("Story saved with title: " + finalTitle);
      setTimeout(() => setSaveSuccessMsg(null), 3000);
    } catch (e: any) {
      setSaveErrorMsg("Error saving story: " + (e.message || e));
    } finally {
      setIsSaving(false);
    }
  };

  const handleReconnectGoogle = async () => {
    setIsReconnecting(true);
    try {
      const res = await googleSignIn();
      if (res && res.accessToken) {
        setSaveErrorMsg(null);
        setSaveSuccessMsg("Google Drive account successfully reconnected!");
        setTimeout(() => setSaveSuccessMsg(null), 4000);
      }
    } catch (e: any) {
      console.error(e);
      setSaveErrorMsg("Failed to reconnect Google Drive: " + (e.message || e));
    } finally {
      setIsReconnecting(false);
    }
  };

  const handleExportDriveTrigger = async () => {
    const token = getAccessToken();
    if (!token) {
      setShowDriveAuthModal(true);
      return;
    }
    setShowDriveConfirmModal(true);
  };

  const handleExportDrive = async () => {
    setShowDriveConfirmModal(false);
    const token = getAccessToken();
    if (!token) {
      setShowDriveAuthModal(true);
      return;
    }

    setDriveExportMsg({ status: 'pending', text: 'Uploading story transcript directly to Google Drive...' });

    const fileContent = `# ${title || 'Untitled Story'}\n\n` +
      messages.map(m => `### ${m.role === 'user' ? 'Author' : 'Model'}\n\n${m.text}\n`).join('\n---\n\n');

    const metadata = {
      name: `${(title || 'story').replace(/[^a-zA-Z0-9_\-]/g, '_')}_transcript.md`,
      mimeType: 'text/markdown',
    };

    const boundary = '-------314159265358979323846';
    const delimiter = "\r\n--" + boundary + "\r\n";
    const close_delim = "\r\n--" + boundary + "--";

    const multipartRequestBody =
      delimiter +
      'Content-Type: application/json\r\n\r\n' +
      JSON.stringify(metadata) +
      delimiter +
      'Content-Type: text/markdown\r\n\r\n' +
      fileContent +
      close_delim;

    try {
      const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartRequestBody
      });
      
      if (!res.ok) {
         throw new Error("Failed to export to Google Drive API.");
      }
      setDriveExportMsg({ status: 'success', text: 'Successfully saved story file to your Google Drive!' });
      setTimeout(() => setDriveExportMsg({ status: null, text: '' }), 5000);
    } catch (e: any) {
      console.error(e);
      setDriveExportMsg({ status: 'error', text: 'Error uploading file to Drive: ' + (e.message || e) });
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-950 relative min-w-0">
      
      {/* Name Story Interactive Popup Modal */}
      {showSaveTitleModal && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full max-w-sm shadow-2xl">
             <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2 mb-2">
                <FileText className="w-4 h-4 text-zinc-400" />
                Name Your Story
             </h3>
             <p className="text-xs text-zinc-400 mb-4">Please give your story a title to save it to your collection.</p>
             <input 
               type="text"
               autoFocus
               value={promptTitleInputValue}
               onChange={e => setPromptTitleInputValue(e.target.value)}
               onKeyDown={e => {
                  if (e.key === 'Enter') handleModalSaveSubmit();
               }}
               placeholder="Enter story title..."
               className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-base md:text-sm text-zinc-100 mb-4 focus:outline-none focus:border-blue-500 transition-colors"
             />
             <div className="flex justify-end gap-2.5">
               <button 
                  onClick={() => setShowSaveTitleModal(false)}
                  className="px-3.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-xs transition-colors font-medium border border-zinc-700 cursor-pointer"
               >
                 Cancel
               </button>
               <button 
                  onClick={handleModalSaveSubmit}
                  disabled={!promptTitleInputValue.trim()}
                  className="px-3.5 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs transition-colors font-semibold cursor-pointer"
               >
                 Confirm & Save
               </button>
             </div>
          </div>
        </div>
      )}

      {/* Google Drive Export Confirmation Modal */}
      {showDriveConfirmModal && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full max-w-sm shadow-2xl">
             <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2 mb-2">
                <DownloadCloud className="w-5 h-5 text-blue-400" />
                Google Drive Export
             </h3>
             <p className="text-xs text-zinc-300 mb-4">
                Export this story raw transcript as a Markdown (`.md`) file to your personal Google Drive root directory?
             </p>
             <div className="flex justify-end gap-2.5">
               <button 
                  onClick={() => setShowDriveConfirmModal(false)}
                  className="px-3.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-xs transition-colors font-medium border border-zinc-700 cursor-pointer"
               >
                 Cancel
               </button>
               <button 
                  onClick={handleExportDrive}
                  className="px-3.5 py-1.5 rounded bg-blue-600 hover:bg-blue-500 text-white text-xs transition-colors font-semibold shadow cursor-pointer"
               >
                   Confirm Export
               </button>
             </div>
          </div>
        </div>
      )}

      {/* Delete Story Confirmation Modal */}
      {showDeleteConfirmModal && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full max-w-sm shadow-2xl">
             <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2 mb-2">
                <Trash2 className="w-5 h-5 text-red-500 shrink-0" />
                Delete Story
             </h3>
             <p className="text-xs text-zinc-300 mb-5 leading-relaxed">
                Are you sure you want to permanently delete this story? This action cannot be undone.
             </p>
             <div className="flex justify-end gap-2.5">
               <button 
                  onClick={() => setShowDeleteConfirmModal(false)}
                  disabled={isDeleting}
                  className="px-3.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-xs transition-colors font-medium border border-zinc-700 cursor-pointer"
               >
                 Cancel
               </button>
               <button 
                  onClick={handleDeleteActiveStory}
                  disabled={isDeleting}
                  className="px-3.5 py-1.5 rounded bg-red-600 hover:bg-red-500 text-white text-xs transition-colors font-semibold shadow flex items-center gap-1.5 cursor-pointer"
               >
                  {isDeleting && <Loader2 className="w-3 h-3 animate-spin text-white" />}
                  Confirm Delete
               </button>
             </div>
          </div>
        </div>
      )}

      {/* Google Drive Authorization Modal */}
      {showDriveAuthModal && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 w-full max-w-sm shadow-2xl">
             <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2 mb-2">
                <DownloadCloud className="w-5 h-5 text-blue-400" />
                Google Drive Authorization
             </h3>
             <p className="text-xs text-zinc-300 mb-4 leading-relaxed">
                Google Drive requires explicit permission to export your story files to your personal Google Drive account.
             </p>
             <div className="flex justify-end gap-2.5">
               <button 
                  onClick={() => setShowDriveAuthModal(false)}
                  className="px-3.5 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 text-xs transition-colors font-medium border border-zinc-700 cursor-pointer"
               >
                 Cancel
               </button>
               <button 
                  onClick={async () => {
                    setIsAuthorizing(true);
                    try {
                      const result = await googleSignIn();
                      if (result && result.accessToken) {
                        setShowDriveAuthModal(false);
                        setShowDriveConfirmModal(true);
                      }
                    } catch (err: any) {
                      console.error(err);
                      setDriveExportMsg({ status: 'error', text: 'Authorization failed: ' + (err.message || err) });
                      setShowDriveAuthModal(false);
                    } finally {
                      setIsAuthorizing(false);
                    }
                  }}
                  disabled={isAuthorizing}
                  className="px-3.5 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs transition-colors font-semibold flex items-center gap-1.5 shadow cursor-pointer"
               >
                  {isAuthorizing && <Loader2 className="w-3 h-3 animate-spin" />}
                  Authorize & Continue
               </button>
             </div>
          </div>
        </div>
      )}

      {/* Top Bar */}
      <div className="flex flex-col md:flex-row border-b border-zinc-900 bg-zinc-950/80 backdrop-blur shrink-0 z-10 w-full">
         <div className="h-16 flex items-center justify-between px-4 md:px-6 flex-1 w-full gap-2">
            <div className="flex items-center gap-2 md:gap-4 overflow-hidden flex-1">
                <button 
                  onClick={onToggleSidebar} 
                  className="md:hidden p-1.5 text-zinc-400 hover:text-white transition-colors hover:bg-zinc-900 rounded shrink-0 cursor-pointer"
                  title="Toggle Menu"
                >
                    <Menu className="w-5 h-5" />
                </button>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="Untitled Story"
                  className="bg-transparent border-none outline-none font-semibold text-base md:text-lg text-zinc-100 placeholder-zinc-600 focus:ring-0 max-w-[124px] sm:max-w-[200px] md:max-w-none flex-1 md:w-auto"
                />

                {/* Desktop selectors */}
                <div className="hidden md:flex items-center gap-3">
                   <div className="h-4 w-px bg-zinc-800 shrink-0"></div>
                   <select 
                     value={model} 
                     onChange={e => handleModelChange(e.target.value)}
                     className="bg-transparent border-none text-xs text-zinc-400 focus:outline-none focus:ring-0 max-w-[125px] lg:max-w-none cursor-pointer"
                   >
                       {availableModels.length === 0 ? (
                          <option value="gemini-3.8-flash">Loading models...</option>
                       ) : (
                          availableModels.map(m => (
                              <option key={m.name} value={m.name}>{m.displayName}</option>
                          ))
                       )}
                   </select>

                   <div className="h-4 w-px bg-zinc-800 shrink-0"></div>
                   <select
                     value={selectedPresetId}
                     onChange={e => handlePresetChange(e.target.value)}
                     className="bg-transparent border-none text-xs text-zinc-400 focus:outline-none focus:ring-0 max-w-[125px] lg:max-w-none cursor-pointer"
                   >
                      <option value="">Default Persona</option>
                      {presets.map(p => (
                          <option key={p.id} value={p.id!}>{p.title}</option>
                      ))}
                   </select>

                   <button 
                      onClick={() => setShowSystemPrompt(!showSystemPrompt)}
                      className="text-zinc-500 hover:text-zinc-300 transition-colors p-1 cursor-pointer"
                      title="Edit System Prompt"
                   >
                      <Settings className="w-4 h-4" />
                   </button>

                   {onOpenSettings && (
                     <button 
                        onClick={onOpenSettings}
                        className="text-zinc-500 hover:text-blue-400 transition-colors p-1 cursor-pointer"
                        title="功能設定與自動化選項 (Settings)"
                     >
                        <Sliders className="w-4 h-4" />
                     </button>
                   )}
                </div>
            </div>

            {/* Save & Export Controls */}
            <div className="flex items-center gap-1.5 md:gap-2 shrink-0">
               {/* Auto-save status indicator */}
               <div className="flex items-center gap-1.5 text-zinc-500 text-xs mr-1 select-none">
                  {autoSaveStatus === 'saving' && (
                     <>
                        <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
                        <span className="hidden xs:inline text-[11px] text-zinc-400">Saving...</span>
                     </>
                  )}
                  {autoSaveStatus === 'saved' && (
                     <>
                        <Check className="w-3 h-3 text-emerald-500" />
                        <span className="hidden xs:inline text-[11px] text-zinc-400">Autosaved</span>
                     </>
                  )}
                  {autoSaveStatus === 'unsaved' && (
                     <>
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                        <span className="hidden xs:inline text-[11px] text-zinc-400">
                          {settings.autoSave ? 'Unsaved' : '未儲存 (手動模式)'}
                        </span>
                     </>
                  )}
                  {autoSaveStatus === 'error' && (
                     <>
                        <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                        <span className="hidden xs:inline text-[11px] text-red-400 font-medium">Save failure</span>
                     </>
                  )}
               </div>

               <button 
                  onClick={handleSave}
                  disabled={isSaving || (messages.length === 0 && !title)}
                  className="flex items-center gap-1.5 bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 border border-zinc-800 text-zinc-300 px-2.5 py-1.5 rounded-md text-xs md:text-sm transition-colors cursor-pointer"
                  title="Save Story"
               >
                  {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  <span className="hidden xs:inline">Save</span>
               </button>
               <button 
                  onClick={handleExportDriveTrigger}
                  disabled={messages.length === 0}
                  className="flex items-center gap-1.5 bg-blue-600/10 hover:bg-blue-600/20 text-blue-400 border border-blue-900/50 px-2.5 py-1.5 rounded-md text-xs md:text-sm transition-colors cursor-pointer"
                  title="Export to Drive"
               >
                  <DownloadCloud className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Export to Drive</span>
               </button>
               {activeStoryId && (
                  <button 
                     onClick={() => setShowDeleteConfirmModal(true)}
                     className="flex items-center gap-1.5 bg-red-950/20 hover:bg-red-950/40 text-red-400 border border-red-900/40 px-2.5 py-1.5 rounded-md text-xs md:text-sm transition-colors cursor-pointer"
                     title="Delete Story"
                  >
                     <Trash2 className="w-3.5 h-3.5 shrink-0" />
                     <span className="hidden sm:inline">Delete</span>
                  </button>
               )}
            </div>
         </div>

         {/* Mobile selector stacking */}
         <div className="flex md:hidden items-center justify-between gap-2 px-4 py-2 border-t border-zinc-900/80 bg-zinc-950/60 w-full">
             <div className="flex-1 flex items-center gap-1 min-w-0">
                <span className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider shrink-0 mr-1">Model:</span>
                <select 
                  value={model} 
                  onChange={e => handleModelChange(e.target.value)}
                  className="bg-zinc-900/80 border border-zinc-800/80 rounded px-2.5 py-1 text-xs text-zinc-300 focus:outline-none focus:ring-0 w-full max-w-[150px] cursor-pointer"
                >
                    {availableModels.length === 0 ? (
                       <option value="gemini-3.8-flash">Loading...</option>
                    ) : (
                       availableModels.map(m => (
                           <option key={m.name} value={m.name}>{m.displayName}</option>
                       ))
                    )}
                </select>
             </div>

             <div className="h-4 w-px bg-zinc-800 shrink-0 mx-1"></div>

             <div className="flex-1 flex items-center justify-end gap-1 min-w-0">
                <span className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider shrink-0 mr-1">Persona:</span>
                <select
                  value={selectedPresetId}
                  onChange={e => handlePresetChange(e.target.value)}
                  className="bg-zinc-900/80 border border-zinc-800/80 rounded px-2.5 py-1 text-xs text-zinc-300 focus:outline-none focus:ring-0 w-full max-w-[120px] cursor-pointer"
                >
                   <option value="">Default</option>
                   {presets.map(p => (
                       <option key={p.id} value={p.id!}>{p.title}</option>
                   ))}
                </select>
                <button 
                   onClick={() => setShowSystemPrompt(!showSystemPrompt)}
                   className="p-1 text-zinc-500 hover:text-zinc-300 transition-colors ml-0.5 cursor-pointer"
                >
                   <Settings className="w-4 h-4" />
                </button>
             </div>
         </div>
      </div>

      {showSystemPrompt && (
         <div className="w-full bg-zinc-900 border-b border-zinc-800 px-4 md:px-8 py-3 z-10 shrink-0 flex flex-col">
            <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-zinc-400 font-medium">System Prompt</span>
                <button onClick={() => setShowSystemPrompt(false)} className="text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer">
                   <X className="w-4 h-4" />
                </button>
            </div>
            <textarea 
               value={systemInstruction}
               onChange={e => {
                  setSystemInstruction(e.target.value);
                  systemInstructionRef.current = e.target.value;
               }}
               placeholder="Enter custom instructions for the AI model... (Leave blank for default behavior)"
               className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-300 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 h-24 max-h-48 resize-y"
            />
            <div className="flex justify-end mt-2">
               <button
                  onClick={async () => {
                     setShowSystemPrompt(false);
                     const promptToSave = systemInstructionRef.current;
                     if (activeStoryId) {
                        try {
                           await updateStory(activeStoryId, {
                              systemInstruction: promptToSave || undefined
                           });
                           setAutoSaveStatus('saved');
                           setSaveSuccessMsg("System prompt updated. Subsequent generations will use this prompt.");
                           setTimeout(() => setSaveSuccessMsg(null), 3000);
                        } catch (err) {
                           console.error("Failed to update system prompt:", err);
                        }
                     }
                  }}
                  className="text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium border border-blue-900/70 bg-blue-900/20 hover:bg-blue-900/40 px-3 py-1.5 rounded cursor-pointer"
               >
                  Save Prompt
               </button>
            </div>
         </div>
      )}

      {/* Interactive Alert Banners */}
      <div className="w-full shrink-0 px-4 md:px-8 pt-4 space-y-2">
         {saveSuccessMsg && (
            <div className="flex items-center justify-between text-emerald-400 text-xs bg-emerald-950/20 border border-emerald-900/40 px-4 py-2.5 rounded-lg max-w-3xl mx-auto">
               <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                  <span>{saveSuccessMsg}</span>
               </div>
               <button onClick={() => setSaveSuccessMsg(null)} className="text-zinc-500 hover:text-zinc-300 cursor-pointer"><X className="w-3.5 h-3.5" /></button>
            </div>
         )}
         {saveErrorMsg && (
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 text-red-400 text-xs bg-red-950/20 border border-red-900/40 px-4 py-2.5 rounded-lg max-w-3xl mx-auto">
               <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  <span>{saveErrorMsg}</span>
               </div>
               <div className="flex items-center gap-2 self-end md:self-auto shrink-0">
                  {(saveErrorMsg.includes("expired") || saveErrorMsg.includes("UNAUTHORIZED") || saveErrorMsg.includes("unauthorized")) && (
                     <button 
                        onClick={handleReconnectGoogle}
                        disabled={isReconnecting}
                        className="px-2.5 py-1 bg-amber-600/20 hover:bg-amber-600/40 border border-amber-500/30 text-amber-300 rounded text-[11px] font-semibold transition-colors cursor-pointer"
                     >
                        {isReconnecting ? "Connecting..." : "Reconnect Google Drive"}
                     </button>
                  )}
                  <button onClick={() => setSaveErrorMsg(null)} className="text-zinc-500 hover:text-zinc-300 p-1 cursor-pointer"><X className="w-3.5 h-3.5" /></button>
               </div>
            </div>
         )}
         {driveExportMsg.status && (
            <div className={`flex items-center justify-between text-xs px-4 py-2.5 rounded-lg max-w-3xl mx-auto ${
               driveExportMsg.status === 'success' ? 'text-emerald-400 bg-emerald-950/20 border border-emerald-900/40' :
               driveExportMsg.status === 'error' ? 'text-red-400 bg-red-950/20 border border-red-900/40' :
               'text-zinc-300 bg-zinc-900 border border-zinc-800 animate-pulse'
            }`}>
               <div className="flex items-center gap-2">
                  {driveExportMsg.status === 'pending' ? <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" /> :
                   driveExportMsg.status === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
                  <span>{driveExportMsg.text}</span>
               </div>
               {driveExportMsg.status !== 'pending' && (
                  <button onClick={() => setDriveExportMsg({ status: null, text: '' })} className="text-zinc-500 hover:text-zinc-300 cursor-pointer"><X className="w-3.5 h-3.5" /></button>
               )}
            </div>
         )}
      </div>

      {/* Chat Transcript Area */}
      <div 
        ref={chatContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6"
      >
         {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-zinc-500 space-y-4">
               <FileText className="w-16 h-16 opacity-20" />
               <p>Send a message to begin generating your story.</p>
            </div>
         ) : (
              <div className="max-w-3xl mx-auto space-y-8 pb-4">
                  {messages.map((m, i) => (
                     <div key={i} className={`flex items-start gap-2 ${m.role === 'user' ? 'flex-row-reverse justify-start' : 'justify-start'} group z-10`}>
                        <div className={`max-w-[85%] rounded-2xl px-5 py-4 relative ${m.role === 'user' ? 'bg-blue-600 text-white' : 'bg-zinc-900 text-zinc-300 border border-zinc-800 shadow-sm'}`}>
                           {m.role === 'model' ? (
                              <div className="prose prose-invert prose-sm max-w-none prose-p:leading-relaxed prose-pre:bg-zinc-950">
                                 <Markdown>{m.text}</Markdown>
                              </div>
                           ) : (
                              editingMessageIndex === i ? (
                                <div className="flex flex-col gap-2 min-w-[200px] sm:min-w-[300px]">
                                   <textarea
                                      value={editingMessageContent}
                                      onChange={e => setEditingMessageContent(e.target.value)}
                                      className="w-full bg-blue-700/50 border border-blue-500 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-300 resize-none font-sans"
                                      rows={3}
                                      autoFocus
                                   />
                                   <div className="flex items-center justify-end gap-2 mt-1">
                                      <button 
                                         onClick={() => setEditingMessageIndex(null)}
                                         className="text-xs text-blue-200 hover:text-white px-2 py-1 transition-colors cursor-pointer"
                                      >
                                         Cancel
                                      </button>
                                      <button 
                                         onClick={() => {
                                            if (!editingMessageContent.trim()) return;
                                            handleSend(false, editingMessageContent, messages.slice(0, i));
                                            setEditingMessageIndex(null);
                                         }}
                                         className="flex items-center gap-1.5 bg-white text-blue-600 px-3 py-1.5 rounded-md text-xs font-semibold hover:bg-blue-50 transition-colors cursor-pointer"
                                      >
                                         <Send className="w-3 h-3" />
                                         Resend
                                      </button>
                                   </div>
                                </div>
                              ) : (
                                <div className="whitespace-pre-wrap">{m.text}</div>
                              )
                           )}
                        </div>
                        {/* Action buttons for User messages */}
                        {m.role === 'user' && editingMessageIndex !== i && (
                           <div className="flex items-center gap-1 self-center opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
                              <button
                                 onClick={() => {
                                    handleSend(false, m.text, messages.slice(0, i));
                                 }}
                                 disabled={isLoading || reconnectState.isReconnecting}
                                 className="p-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-xl shadow-lg transition-all cursor-pointer"
                                 title="重試此對話 (Retry message)"
                              >
                                 <RefreshCw className="w-3.5 h-3.5" />
                              </button>
                              <button 
                                 onClick={() => {
                                    setEditingMessageIndex(i);
                                    setEditingMessageContent(m.text);
                                 }}
                                 className="p-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-xl shadow-lg transition-all cursor-pointer"
                                 title="編輯訊息 (Edit message)"
                              >
                                 <Edit2 className="w-3.5 h-3.5" />
                              </button>
                           </div>
                        )}

                        {/* Action button for Model messages */}
                        {m.role === 'model' && (
                           <div className="flex items-center gap-1 self-center opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
                              <button
                                 onClick={() => {
                                    // Find preceding user prompt
                                    const prevUserIndex = i > 0 && messages[i - 1]?.role === 'user' ? i - 1 : -1;
                                    if (prevUserIndex !== -1) {
                                       handleSend(false, messages[prevUserIndex].text, messages.slice(0, prevUserIndex));
                                    } else {
                                       // Fallback retry
                                       handleSend(true, undefined, messages.slice(0, i));
                                    }
                                 }}
                                 disabled={isLoading || reconnectState.isReconnecting}
                                 className="p-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-xl shadow-lg transition-all cursor-pointer"
                                 title="重新生成回覆 (Regenerate response)"
                              >
                                 <RefreshCw className="w-3.5 h-3.5" />
                              </button>
                           </div>
                        )}
                     </div>
                  ))}
                  {!isOnline && (
                     <div className="flex items-center justify-between text-xs text-amber-400 bg-amber-950/20 border border-amber-900/40 px-4 py-2.5 rounded-lg max-w-2xl mx-auto shadow">
                        <div className="flex items-center gap-2">
                           <WifiOff className="w-4 h-4 text-amber-400 shrink-0 animate-pulse" />
                           <span>目前處於離線狀態。系統將在網路恢復時自動重新連線並接續生成。</span>
                        </div>
                     </div>
                  )}
                  {reconnectState.isReconnecting && (
                     <div className="flex justify-start animate-fade-in">
                        <div className="max-w-md w-full rounded-2xl p-4 bg-amber-950/25 border border-amber-800/40 shadow-lg space-y-3">
                           <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2.5 text-amber-400 font-medium text-xs">
                                 <RefreshCw className="w-4 h-4 animate-spin text-amber-400 shrink-0" />
                                 <span>
                                    {isOnline
                                       ? reconnectState.reason?.includes('SERVER_STARTING')
                                          ? `伺服器啟動中，等待自動重試 (第 ${reconnectState.attempt}/${reconnectState.maxAttempts} 次)...`
                                          : reconnectState.reason?.includes('SERVICE_UNAVAILABLE')
                                          ? `模型忙碌，等待自動重試 (第 ${reconnectState.attempt}/${reconnectState.maxAttempts} 次)...`
                                          : `連線中斷，正在自動重連 (第 ${reconnectState.attempt}/${reconnectState.maxAttempts} 次)...`
                                       : '網路離線，等待連線恢復後自動重連...'}
                                 </span>
                              </div>
                              {reconnectState.countdown > 0 && isOnline && (
                                 <span className="text-[11px] bg-amber-950/60 border border-amber-800/60 px-2 py-0.5 rounded text-amber-300 font-mono">
                                    {reconnectState.countdown}s
                                 </span>
                              )}
                           </div>

                           <p className="text-[11px] text-zinc-400 leading-relaxed">
                              {reconnectState.reason
                                 ? `原因: ${reconnectState.reason}`
                                 : '偵測到暫時性網路中斷，系統正在自動重新建立連線並無縫接續故事。'}
                           </p>

                           <div className="flex items-center justify-end gap-2 pt-1 border-t border-amber-900/30">
                              <button
                                 onClick={handleCancelAutoReconnect}
                                 className="px-3 py-1 bg-zinc-800/80 hover:bg-zinc-700 text-zinc-300 hover:text-white rounded-md text-xs font-medium border border-zinc-700 transition-colors cursor-pointer"
                              >
                                 取消重連
                              </button>
                              <button
                                 onClick={handleTriggerImmediateReconnect}
                                 className="flex items-center gap-1.5 px-3 py-1 bg-amber-600 hover:bg-amber-500 active:bg-amber-700 text-black rounded-md text-xs font-semibold transition-colors cursor-pointer shadow-sm"
                              >
                                 <RefreshCw className="w-3 h-3" />
                                 立即重連
                              </button>
                           </div>
                        </div>
                     </div>
                  )}
                  {isLoading && !reconnectState.isReconnecting && (
                     <div className="flex justify-start">
                        <div className="max-w-[85%] rounded-2xl px-5 py-4 bg-zinc-900 border border-zinc-800 flex items-center gap-3 text-zinc-400 animate-pulse">
                           <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                           <span className="text-sm">Generating story stream...</span>
                        </div>
                     </div>
                  )}
                  {generationError && (
                     <div className="flex flex-col items-center justify-center space-y-4 py-4 w-full">
                        {(() => {
                           const errLower = generationError.toLowerCase();
                           const isQuota = errLower.includes('quota') || errLower.includes('resource_exhausted') || errLower.includes('429');
                           const isServerStarting = errLower.includes('server_starting');
                           const isUnavailable = errLower.includes('503') || errLower.includes('unavailable') || errLower.includes('high demand');
                           const isNetwork = errLower.includes('連線中斷') || errLower.includes('failed to fetch') || errLower.includes('network') || errLower.includes('timeout');

                           let titleText = '生成異常中斷 (Generation Error)';
                           let descText = generationError;
                           let cardBorder = 'border-red-900/50 bg-red-950/20';
                           let iconColor = 'text-red-400';
                           let btnBg = 'bg-red-600 hover:bg-red-500 text-white';

                           if (isServerStarting) {
                             titleText = '應用伺服器尚未就緒';
                             descText = '伺服器仍在啟動，這不是模型產生的故事內容。請稍候重試；若持續發生，請檢查應用部署狀態。';
                             cardBorder = 'border-orange-900/40 bg-orange-950/20';
                             iconColor = 'text-orange-400';
                             btnBg = 'bg-orange-600 hover:bg-orange-500 text-white';
                           } else if (isQuota) {
                             titleText = '模型配額已達上限 (Model Quota Limit Reached)';
                             descText = '當前模型暫時達到免費用量上限 (429)。您的所有對話記錄已完整保存！建議切換至高額度模型 (如 Gemini 2.5 Flash-Lite) 繼續寫作，或點擊重試。';
                             cardBorder = 'border-amber-900/40 bg-amber-950/15';
                             iconColor = 'text-amber-500';
                             btnBg = 'bg-amber-500 hover:bg-amber-400 text-black';
                           } else if (isUnavailable) {
                             titleText = '服務尖峰高負載 (503 Service High Demand)';
                             descText = 'Google 模型目前忙碌。畫面上的內容會保留供您繼續操作；請稍候重試或切換模型。';
                             cardBorder = 'border-indigo-900/40 bg-indigo-950/20';
                             iconColor = 'text-indigo-400';
                             btnBg = 'bg-indigo-600 hover:bg-indigo-500 text-white';
                           } else if (isNetwork) {
                             titleText = '網路連線逾時或中斷 (Network Interrupted)';
                             descText = '與伺服器的連線發生中斷或逾時。請檢查網路連線及同步狀態，然後點擊重試。';
                             cardBorder = 'border-orange-900/40 bg-orange-950/20';
                             iconColor = 'text-orange-400';
                             btnBg = 'bg-orange-600 hover:bg-orange-500 text-white';
                           }

                           return (
                             <div className={`p-5 rounded-2xl max-w-xl w-full text-zinc-300 space-y-4 shadow-lg border ${cardBorder}`}>
                               <div className="flex items-start gap-3">
                                 <AlertCircle className={`w-5 h-5 shrink-0 mt-0.5 animate-pulse ${iconColor}`} />
                                 <div className="space-y-1.5 flex-1">
                                   <div className="flex items-center justify-between">
                                     <h4 className={`font-semibold text-sm ${iconColor}`}>{titleText}</h4>
                                     <span className="text-[10px] text-zinc-500 bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800">請檢查同步狀態</span>
                                   </div>
                                   <p className="text-xs text-zinc-400 leading-relaxed">
                                     {descText}
                                   </p>
                                 </div>
                               </div>

                               {availableModels && availableModels.filter(m => m.name !== model).length > 0 && (
                                 <div className="border-t border-zinc-800/80 pt-3">
                                   <span className="text-[11px] font-medium text-zinc-400 block mb-1.5 uppercase tracking-wider">
                                     切換模型並立即重試 (Quick Switch & Resume):
                                   </span>
                                   <div className="flex flex-wrap gap-2">
                                     {availableModels.filter(m => m.name !== model).slice(0, 3).map(m => (
                                       <button
                                         key={m.name}
                                         onClick={() => handleSwitchModelAndRetry(m.name)}
                                         className="px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 active:bg-zinc-700 text-zinc-300 rounded-lg text-xs transition-colors border border-zinc-800 font-medium hover:border-zinc-700 cursor-pointer flex items-center gap-1.5"
                                       >
                                         <span>切換至 {m.displayName || m.name}</span>
                                       </button>
                                     ))}
                                   </div>
                                 </div>
                               )}

                               <div className="flex items-center justify-between gap-3 border-t border-zinc-900/60 pt-3">
                                 <div className="flex items-center gap-2">
                                   <button
                                     onClick={handleEditFailedPrompt}
                                     className="flex items-center gap-1 px-2.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-lg text-xs transition-colors border border-zinc-800 cursor-pointer font-medium"
                                     title="將最後一條提示詞帶回輸入框修改"
                                   >
                                     <Edit2 className="w-3 h-3" />
                                     編輯提示詞
                                   </button>
                                   <button
                                     onClick={() => {
                                       if (activeStoryId) clearStoryError(activeStoryId);
                                       setGenerationError(null);
                                     }}
                                     className="px-2.5 py-1.5 text-zinc-400 hover:text-zinc-200 text-xs transition-colors font-medium cursor-pointer"
                                   >
                                     關閉提示
                                   </button>
                                 </div>

                                 <button
                                   onClick={handleRetryCurrent}
                                   className={`flex items-center gap-1.5 px-3.5 py-1.5 font-semibold rounded-lg text-xs transition-colors cursor-pointer shadow-sm ${btnBg}`}
                                 >
                                   <RefreshCw className="w-3.5 h-3.5" />
                                   立即重試 (Retry)
                                 </button>
                               </div>
                             </div>
                           );
                        })()}
                     </div>
                  )}
              </div>
         )}
      </div>

      {/* Input Area */}
      <div className="p-4 bg-zinc-950 border-t border-zinc-900 shrink-0">
          <div className="max-w-3xl mx-auto relative">
              <textarea
                 value={input}
                 onChange={e => setInput(e.target.value)}
                 onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                       e.preventDefault();
                       handleSend(false);
                    }
                 }}
                 placeholder="Type your instruction or story continuation... (Press Enter to send)"
                 className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 pb-12 text-base md:text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-700 resize-none font-sans"
                 rows={3}
              />
              <div className="absolute bottom-3 right-3 flex items-center gap-2">
                 {isLoading || reconnectState.isReconnecting ? (
                    <button 
                       onClick={handleStopGeneration}
                       title="Stop generating & cancel reconnect"
                       className="p-2 bg-red-600/20 text-red-500 hover:bg-red-600 hover:text-white border border-red-900/50 rounded-lg transition-colors cursor-pointer flex items-center justify-center group"
                    >
                        <Square className="w-4 h-4 fill-current transition-transform group-hover:scale-110" />
                    </button>
                 ) : (
                    <>
                       <button 
                          onClick={() => handleSend(false, "continue")}
                          title="Auto-send 'continue'"
                          className="flex items-center gap-1.5 p-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 rounded-lg transition-colors cursor-pointer border border-zinc-700"
                       >
                          <Play className="w-4 h-4" />
                       </button>
                       <button 
                          onClick={() => handleSend(false)}
                          disabled={!input.trim()}
                          className="p-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors cursor-pointer"
                       >
                           <Send className="w-4 h-4" />
                       </button>
                    </>
                 )}
              </div>
          </div>
      </div>
    </div>
  );
}

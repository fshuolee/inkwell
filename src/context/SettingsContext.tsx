import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { AppSettings, DEFAULT_SETTINGS, loadStoredSettings, saveStoredSettings } from '../types/settings';

interface SettingsContextType {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  updateAllSettings: (newSettings: AppSettings) => void;
  saveSettings: (overrideSettings?: AppSettings) => void;
  resetToDefaults: () => void;
  isDirty: boolean;
  saveStatus: 'idle' | 'saved';
}

const SettingsContext = createContext<SettingsContextType | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [savedSettings, setSavedSettings] = useState<AppSettings>(() => loadStoredSettings());
  const [settings, setSettings] = useState<AppSettings>(() => loadStoredSettings());
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle');

  // Load initial settings on mount
  useEffect(() => {
    const loaded = loadStoredSettings();
    setSavedSettings(loaded);
    setSettings(loaded);
  }, []);

  const isDirty = JSON.stringify(settings) !== JSON.stringify(savedSettings);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      // Also automatically keep in storage for seamless experience
      saveStoredSettings(next);
      return next;
    });
    setSaveStatus('idle');
  }, []);

  const updateAllSettings = useCallback((newSettings: AppSettings) => {
    setSettings(newSettings);
    setSaveStatus('idle');
  }, []);

  const saveSettings = useCallback((overrideSettings?: AppSettings) => {
    const toSave = overrideSettings || settings;
    saveStoredSettings(toSave);
    setSavedSettings(toSave);
    setSettings(toSave);
    setSaveStatus('saved');
    setTimeout(() => {
      setSaveStatus('idle');
    }, 2500);
  }, [settings]);

  const resetToDefaults = useCallback(() => {
    setSettings(DEFAULT_SETTINGS);
    saveStoredSettings(DEFAULT_SETTINGS);
    setSavedSettings(DEFAULT_SETTINGS);
    setSaveStatus('saved');
    setTimeout(() => {
      setSaveStatus('idle');
    }, 2500);
  }, []);

  return (
    <SettingsContext.Provider
      value={{
        settings,
        updateSetting,
        updateAllSettings,
        saveSettings,
        resetToDefaults,
        isDirty,
        saveStatus,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextType {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}

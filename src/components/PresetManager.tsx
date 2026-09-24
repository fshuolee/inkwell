import React, { useState, useEffect } from 'react';
import { Preset, getPresets, createPreset, updatePreset, deletePreset, generateSafeUUID } from '../firebase/db';
import { Save, Plus, Trash2, Edit2, CheckCircle2, Menu, AlertCircle, X, Loader2 } from 'lucide-react';
import { auth } from '../firebase/auth';

export default function PresetManager({ onToggleSidebar }: { onToggleSidebar: () => void }) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [selectedModel, setSelectedModel] = useState('gemini-3.8-flash');
  const [availableModels, setAvailableModels] = useState<{name: string, displayName: string}[]>([]);

  // Custom UI alert states to avoid window.confirm & window.alert on iframe constraint
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadPresets();
    loadModels();
  }, []);

  const loadModels = async () => {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      if (data.models && data.models.length > 0) {
        const sorted = data.models.sort((a: any, b: any) => getCapabilityRank(b.name) - getCapabilityRank(a.name));
        setAvailableModels(sorted);
      } else {
        setAvailableModels([{ name: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' }]);
      }
    } catch (e) {
      console.error(e);
      setAvailableModels([{ name: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' }]);
    }
  };

  const getCapabilityRank = (name: string): number => {
    const ln = name.toLowerCase();
    // Deprioritize preview-lite or experimental models that hit demand spikes
    if (ln.includes('lite-preview')) return 15;
    if (ln.includes('3.8-flash')) return 100;
    if (ln.includes('2.5-flash') && !ln.includes('native') && !ln.includes('tts') && !ln.includes('lite')) return 98;
    if (ln.includes('flash-latest')) return 96;
    if (ln.includes('3.7-flash')) return 95;
    if (ln.includes('3.1-pro')) return 90;
    if (ln.includes('2.5-pro') && !ln.includes('tts')) return 88;
    if (ln.includes('pro-latest')) return 85;
    if (ln.includes('3.1-flash') && !ln.includes('lite')) return 80;
    if (ln.includes('3.6-flash')) return 75;
    if (ln.includes('3.5-flash')) return 70;
    if (ln.includes('pro')) return 60;
    if (ln.includes('flash')) return 50;
    return 10;
  };

  const loadPresets = async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const data = await getPresets();
      setPresets(data);
    } catch (err: any) {
      console.error(err);
      setErrorMsg('Failed to load system prompts from cloud.');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!title.trim() || !prompt.trim() || !auth.currentUser) return;
    setErrorMsg(null);
    setSuccessMsg(null);
    setIsSaving(true);
    try {
      if (editingId) {
        await updatePreset(editingId, { title, prompt, model: selectedModel });
        setEditingId(null);
        setSuccessMsg('System prompt updated successfully!');
      } else {
        await createPreset(generateSafeUUID(), { title, prompt, model: selectedModel, userId: auth.currentUser.uid });
        setSuccessMsg('System prompt created successfully!');
      }
      window.dispatchEvent(new CustomEvent('inkwell:presets-updated'));
      setTitle('');
      setPrompt('');
      setSelectedModel('gemini-3.8-flash');
      await loadPresets();
      setTimeout(() => setSuccessMsg(null), 4000);
    } catch (err: any) {
      console.error(err);
      setErrorMsg('Error saving system prompt: ' + (err.message || err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = (preset: Preset) => {
    setEditingId(preset.id!);
    setTitle(preset.title);
    setPrompt(preset.prompt);
    setSelectedModel(preset.model || 'gemini-3.8-flash');
    setErrorMsg(null);
    setSuccessMsg(null);
  };

  const handleCancel = () => {
    setEditingId(null);
    setTitle('');
    setPrompt('');
    setSelectedModel('gemini-3.8-flash');
    setErrorMsg(null);
  };

  const handleDeleteRequest = (id: string) => {
    setConfirmDeleteId(id);
    setErrorMsg(null);
    setSuccessMsg(null);
  };

  const handleConfirmDelete = async () => {
    if (!confirmDeleteId) return;
    setIsDeleting(true);
    setErrorMsg(null);
    try {
      await deletePreset(confirmDeleteId);
      window.dispatchEvent(new CustomEvent('inkwell:presets-updated'));
      if (editingId === confirmDeleteId) handleCancel();
      setConfirmDeleteId(null);
      setSuccessMsg('System prompt deleted.');
      await loadPresets();
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: any) {
      console.error("Delete error:", err);
      setErrorMsg("Failed to delete system prompt from cloud: " + (err.message || 'Error occurred.'));
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-950">
      {/* Top Bar */}
      <div className="h-16 border-b border-zinc-900 bg-zinc-950/80 backdrop-blur flex items-center justify-between px-6 shrink-0 z-10">
         <div className="flex items-center gap-3">
             <button 
               onClick={onToggleSidebar} 
               className="md:hidden p-1.5 text-zinc-400 hover:text-white transition-colors hover:bg-zinc-900 rounded"
               title="Toggle Menu"
             >
                 <Menu className="w-5 h-5" />
             </button>
             <h2 className="font-semibold text-lg text-zinc-100">System Prompts</h2>
             <div className="h-4 w-px bg-zinc-800"></div>
             <p className="text-zinc-500 text-xs hidden sm:block">Manage your AI persona presets</p>
         </div>
      </div>

      <div className="flex-1 flex flex-col p-6 overflow-y-auto">
        <div className="max-w-4xl mx-auto w-full space-y-8">
          
          {/* Notifications */}
          {errorMsg && (
             <div className="flex items-center justify-between gap-3 text-red-400 text-sm bg-red-950/20 border border-red-900/50 px-5 py-3 rounded-xl">
                <div className="flex items-center gap-3">
                  <AlertCircle className="w-5 h-5 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
                <button onClick={() => setErrorMsg(null)} className="text-zinc-500 hover:text-zinc-300">
                  <X className="w-4 h-4" />
                </button>
             </div>
          )}

          {successMsg && (
             <div className="flex items-center justify-between gap-3 text-emerald-400 text-sm bg-emerald-950/20 border border-emerald-900/50 px-5 py-3 rounded-xl">
                <div className="flex items-center gap-3">
                  <CheckCircle2 className="w-5 h-5 shrink-0 text-emerald-400" />
                  <span>{successMsg}</span>
                </div>
                <button onClick={() => setSuccessMsg(null)} className="text-zinc-500 hover:text-zinc-300">
                  <X className="w-4 h-4" />
                </button>
             </div>
          )}

          {/* Delete Confirmation Overlay Modal (Sleek, Safe Alternative to window.confirm) */}
          {confirmDeleteId && (
             <div className="bg-zinc-900/80 border border-red-900/40 p-5 rounded-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div>
                   <h4 className="text-sm font-semibold text-zinc-100">Remove this system prompt?</h4>
                   <p className="text-xs text-zinc-400 mt-1">This will permanently delete this preset from your cloud profile.</p>
                </div>
                <div className="flex gap-2 shrink-0">
                   <button 
                     onClick={() => setConfirmDeleteId(null)}
                     className="px-3 py-1.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 text-xs transition-colors font-medium border border-zinc-700"
                   >
                     Cancel
                   </button>
                   <button 
                     onClick={handleConfirmDelete}
                     disabled={isDeleting}
                     className="px-3 py-1.5 rounded bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs transition-colors font-semibold flex items-center gap-1"
                   >
                     {isDeleting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                     Delete System Prompt
                   </button>
                </div>
             </div>
          )}

          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
            <h3 className="text-lg font-medium text-zinc-100">{editingId ? 'Edit Preset' : 'New Preset'}</h3>
            <input
              type="text"
              placeholder="Preset Title (e.g., Sci-Fi Narrator)"
              disabled={isSaving}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-4 py-2 text-base md:text-sm text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors placeholder:text-zinc-600 disabled:opacity-50"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              placeholder="System Prompt Instructions..."
              disabled={isSaving}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-4 py-3 text-base md:text-sm text-zinc-100 focus:outline-none focus:border-blue-500 transition-colors h-32 resize-none placeholder:text-zinc-600 font-mono disabled:opacity-50"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-zinc-400 font-medium">Model for Preset (模型設定)</label>
              <select
                value={selectedModel}
                disabled={isSaving}
                onChange={e => setSelectedModel(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-4 py-2 text-base md:text-sm text-zinc-300 focus:outline-none focus:border-blue-500 transition-colors cursor-pointer disabled:opacity-50"
              >
                {availableModels.length === 0 ? (
                  <option value="gemini-3.8-flash">Loading models...</option>
                ) : (
                  availableModels.map(m => (
                    <option key={m.name} value={m.name}>{m.displayName}</option>
                  ))
                )}
              </select>
            </div>
            <div className="flex justify-end gap-3">
              {editingId && (
                 <button 
                   onClick={handleCancel} 
                   disabled={isSaving}
                   className="px-4 py-2 rounded text-zinc-400 hover:text-white transition-colors text-sm disabled:opacity-50"
                 >
                   Cancel
                 </button>
              )}
              <button
                onClick={handleSave}
                disabled={!title.trim() || !prompt.trim() || isSaving}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2 rounded text-sm font-medium transition-colors cursor-pointer"
              >
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin text-white" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                {isSaving ? (editingId ? 'Updating...' : 'Saving...') : (editingId ? 'Update Preset' : 'Save Preset')}
              </button>
            </div>
          </div>

          <div>
            <h3 className="text-lg font-medium mb-4 text-zinc-200">Saved Presets</h3>
            {loading ? (
               <div className="text-zinc-500 text-sm flex items-center gap-2">
                 <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
                 <span>Loading presets from Firebase...</span>
               </div>
            ) : presets.length === 0 ? (
               <div className="text-zinc-500 text-sm">No presets found. Create one above to sync with your account.</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {presets.map(p => (
                  <div key={p.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 flex flex-col hover:border-zinc-700/80 transition-all">
                    <div className="flex justify-between items-start mb-2">
                       <h4 className="font-semibold text-zinc-100">{p.title}</h4>
                       {p.model && (
                         <div className="text-[10px] bg-blue-950/40 text-blue-400 border border-blue-900/40 px-2 py-0.5 rounded font-mono font-medium mt-1 inline-block">
                           {p.model}
                         </div>
                       )}
                       <div className="flex gap-2 shrink-0">
                         <button onClick={() => handleEdit(p)} className="text-zinc-500 hover:text-blue-400 p-1 rounded transition-colors" title="Edit">
                           <Edit2 className="w-4 h-4" />
                         </button>
                         <button onClick={() => handleDeleteRequest(p.id!)} className="text-zinc-500 hover:text-red-400 p-1 rounded transition-colors" title="Delete">
                           <Trash2 className="w-4 h-4" />
                         </button>
                       </div>
                    </div>
                    <p className="text-zinc-400 text-sm line-clamp-3 mb-2 flex-1 whitespace-pre-wrap font-sans">{p.prompt}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

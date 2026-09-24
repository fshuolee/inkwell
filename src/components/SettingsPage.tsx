import React, { useState, useEffect } from 'react';
import { 
  Sliders, 
  Cpu, 
  RefreshCw, 
  FileText, 
  RotateCcw, 
  Save, 
  Check, 
  Menu, 
  AlertCircle,
  Sparkles,
  Layers,
  ScrollText,
  SlidersHorizontal
} from 'lucide-react';
import { useSettings } from '../context/SettingsContext';

interface SettingsPageProps {
  onToggleSidebar?: () => void;
  onBackToEditor?: () => void;
}

export default function SettingsPage({ onToggleSidebar, onBackToEditor }: SettingsPageProps) {
  const { settings, updateSetting, saveSettings, resetToDefaults, saveStatus } = useSettings();
  const [availableModels, setAvailableModels] = useState<{ name: string; displayName: string }[]>([]);

  useEffect(() => {
    fetch('/api/models')
      .then((res) => res.json())
      .then((data) => {
        if (data.models && Array.isArray(data.models)) {
          setAvailableModels(data.models);
        }
      })
      .catch((err) => {
        console.error('Failed to fetch models for settings:', err);
      });
  }, []);

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-950 text-zinc-200 overflow-hidden">
      {/* Header */}
      <header className="h-14 border-b border-zinc-800 px-4 md:px-8 flex items-center justify-between bg-zinc-900/60 backdrop-blur-md shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              className="p-1.5 -ml-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-colors cursor-pointer md:hidden"
              title="Toggle sidebar"
            >
              <Menu className="w-5 h-5" />
            </button>
          )}
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-blue-400 shrink-0" />
            <h1 className="text-base font-semibold text-zinc-100 truncate">功能設定與自動化選項</h1>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onBackToEditor && (
            <button
              onClick={onBackToEditor}
              className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-md transition-colors cursor-pointer"
            >
              返回編輯器
            </button>
          )}

          <button
            onClick={resetToDefaults}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 border border-zinc-700/60 rounded-md transition-colors cursor-pointer"
            title="還原所有選項至系統預設值"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">還原預設值</span>
          </button>

          <button
            onClick={() => saveSettings()}
            className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-md transition-colors shadow-sm cursor-pointer"
          >
            {saveStatus === 'saved' ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-300" />
                <span>已儲存</span>
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5" />
                <span>儲存設定</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* Main Content Scroll Area */}
      <div className="flex-1 overflow-y-auto px-4 md:px-8 py-6">
        <div className="max-w-3xl mx-auto space-y-8 pb-16">
          {/* Top Intro Notice */}
          <div className="p-4 rounded-lg bg-zinc-900/80 border border-zinc-800 text-xs text-zinc-400 leading-relaxed space-y-1.5">
            <div className="text-zinc-200 font-medium flex items-center gap-2 text-sm">
              <SlidersHorizontal className="w-4 h-4 text-blue-400 shrink-0" />
              透明度與自主控制保證
            </div>
            <p>
              本頁面列出所有系統內建的「背景自動化」功能。你可以自由將不需要或感覺不透明的行為完全關閉。
              關閉後系統將嚴格依照原始指令與模型回傳執行，不會在背後進行任何隱性調用、文字篡改或靜默模型替換。
            </p>
          </div>

          {/* Section 1: 模型與容錯機制 (Model & Failover) */}
          <section className="space-y-4">
            <div className="border-b border-zinc-800/80 pb-2">
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Cpu className="w-4 h-4 text-blue-400" />
                模型容錯與故障轉移 (Model & Failover)
              </h2>
              <p className="text-xs text-zinc-500 mt-0.5">控制當模型發生配額耗盡或連線中斷時的後續處理方式</p>
            </div>

            <div className="space-y-3">
              {/* Setting 1: autoModelFallback */}
              <div className="p-4 rounded-lg bg-zinc-900/50 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">自動備用模型容錯切換 (Auto Model Fallback)</span>
                    <span className={`text-[11px] font-mono px-1.5 py-0.2 border rounded ${settings.autoModelFallback ? 'text-blue-400 border-blue-900/50 bg-blue-950/30' : 'text-zinc-500 border-zinc-700 bg-zinc-800/40'}`}>
                      {settings.autoModelFallback ? '開啟' : '已關閉'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    當你選取的模型遭遇 Google API 配額超額（429）或尖峰高負載（503）時，是否自動輪詢切換至其他備援模型（如 gemini-2.5-flash-lite）。
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    關閉後：系統將嚴格僅使用你指定的模型。若該模型報錯，將直接中斷並顯示真實錯誤訊息，完全不進行靜默備援替換。
                  </p>
                </div>

                <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1 sm:mt-0">
                  <input
                    type="checkbox"
                    checked={settings.autoModelFallback}
                    onChange={(e) => updateSetting('autoModelFallback', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>

              {/* Setting 2: autoReconnect */}
              <div className="p-4 rounded-lg bg-zinc-900/50 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">網路斷線/異常自動倒數重試 (Auto Reconnect & Retry)</span>
                    <span className={`text-[11px] font-mono px-1.5 py-0.2 border rounded ${settings.autoReconnect ? 'text-blue-400 border-blue-900/50 bg-blue-950/30' : 'text-zinc-500 border-zinc-700 bg-zinc-800/40'}`}>
                      {settings.autoReconnect ? '開啟' : '已關閉'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    遇到暫時性斷線或串流讀取失敗時，是否自動在背景啟動最多 3 次的倒數計時並自動重試連線。
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    關閉後：遇錯立即停止，介面顯示錯誤橫幅並提供手動「重新嘗試」按鈕，絕不在背景擅自發動計時器或發送重試請求。
                  </p>
                </div>

                <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1 sm:mt-0">
                  <input
                    type="checkbox"
                    checked={settings.autoReconnect}
                    onChange={(e) => updateSetting('autoReconnect', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
            </div>
          </section>

          {/* Section 2: 生成與接續行為 (Generation & Continuation) */}
          <section className="space-y-4">
            <div className="border-b border-zinc-800/80 pb-2">
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-blue-400" />
                生成與接續行為 (Generation & Continuation)
              </h2>
              <p className="text-xs text-zinc-500 mt-0.5">自訂續寫與串流時的文本處理與循環機制</p>
            </div>

            <div className="space-y-3">
              {/* Setting 3: autoContinuationLoop */}
              <div className="p-4 rounded-lg bg-zinc-900/50 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">自動多輪長度接續 (Auto Multi-Round Continuation Loop)</span>
                    <span className={`text-[11px] font-mono px-1.5 py-0.2 border rounded ${settings.autoContinuationLoop ? 'text-blue-400 border-blue-900/50 bg-blue-950/30' : 'text-zinc-500 border-zinc-700 bg-zinc-800/40'}`}>
                      {settings.autoContinuationLoop ? '開啟' : '已關閉'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    在續寫時，若模型輸出的最後一個字元不是句號等完結標點，後端伺服器是否自動循環發起下一輪接續（最多 4 輪）。
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    關閉後：每次點擊發送或續寫，嚴格只發起 1 次單一模型調用，模型輸出完畢即結束，絕不進行內部多輪重覆生成。
                  </p>
                </div>

                <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1 sm:mt-0">
                  <input
                    type="checkbox"
                    checked={settings.autoContinuationLoop}
                    onChange={(e) => updateSetting('autoContinuationLoop', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>

              {/* Setting 4: autoDeduplicateOverlap */}
              <div className="p-4 rounded-lg bg-zinc-900/50 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">自動去除接續重疊文字 (Auto Overlap Deduplication)</span>
                    <span className={`text-[11px] font-mono px-1.5 py-0.2 border rounded ${settings.autoDeduplicateOverlap ? 'text-blue-400 border-blue-900/50 bg-blue-950/30' : 'text-zinc-500 border-zinc-700 bg-zinc-800/40'}`}>
                      {settings.autoDeduplicateOverlap ? '開啟' : '已關閉'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    當模型接續時重複吐出前文結尾的幾十個字時，系統演算法是否自動比對並修剪掉該重複前綴。
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    關閉後：完全保留模型原汁原味輸出的所有字元，不做任何字串比對、前綴修除或緩衝去重。
                  </p>
                </div>

                <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1 sm:mt-0">
                  <input
                    type="checkbox"
                    checked={settings.autoDeduplicateOverlap}
                    onChange={(e) => updateSetting('autoDeduplicateOverlap', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>

              {/* Setting 5: autoFillDefaultPrompt */}
              <div className="p-4 rounded-lg bg-zinc-900/50 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">空提示詞自動補入續寫引導 (Auto-Fill Continuation Prompt)</span>
                    <span className={`text-[11px] font-mono px-1.5 py-0.2 border rounded ${settings.autoFillDefaultPrompt ? 'text-blue-400 border-blue-900/50 bg-blue-950/30' : 'text-zinc-500 border-zinc-700 bg-zinc-800/40'}`}>
                      {settings.autoFillDefaultPrompt ? '開啟' : '已關閉'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    在未在輸入框輸入文字而點擊「續寫」時，系統是否自動傳遞預設的接續引導詞（如 "Please continue the story seamlessly."）。
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    關閉後：完全不加入任何隱性引導詞，僅傳遞純淨對話歷史與使用者真實輸入內容。
                  </p>
                </div>

                <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1 sm:mt-0">
                  <input
                    type="checkbox"
                    checked={settings.autoFillDefaultPrompt}
                    onChange={(e) => updateSetting('autoFillDefaultPrompt', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>

              {/* Setting 6: autoRepromptOnAbruptEnd */}
              <div className="p-4 rounded-lg bg-zinc-900/50 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">中斷時自動追加提示追問 (Auto Re-prompt on Abrupt Stop)</span>
                    <span className={`text-[11px] font-mono px-1.5 py-0.2 border rounded ${settings.autoRepromptOnAbruptEnd ? 'text-blue-400 border-blue-900/50 bg-blue-950/30' : 'text-zinc-500 border-zinc-700 bg-zinc-800/40'}`}>
                      {settings.autoRepromptOnAbruptEnd ? '開啟' : '已關閉'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    當模型因達 Token 限制（MAX_TOKENS）或安全標記中斷時，是否自動追加合成使用者訊息催促其繼續展開。
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    關閉後：中斷時立即結束串流，不進行任何後續追加追問。
                  </p>
                </div>

                <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1 sm:mt-0">
                  <input
                    type="checkbox"
                    checked={settings.autoRepromptOnAbruptEnd}
                    onChange={(e) => updateSetting('autoRepromptOnAbruptEnd', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
            </div>
          </section>

          {/* Section 3: 編輯器與介面體驗 (Editor & UX) */}
          <section className="space-y-4">
            <div className="border-b border-zinc-800/80 pb-2">
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <FileText className="w-4 h-4 text-blue-400" />
                編輯器與介面體驗 (Editor & UX)
              </h2>
              <p className="text-xs text-zinc-500 mt-0.5">控制本地草稿儲存與捲動行為</p>
            </div>

            <div className="space-y-3">
              {/* Setting 7: autoSave */}
              <div className="p-4 rounded-lg bg-zinc-900/50 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">即時背景自動儲存草稿 (Auto-Save to Local DB)</span>
                    <span className={`text-[11px] font-mono px-1.5 py-0.2 border rounded ${settings.autoSave ? 'text-blue-400 border-blue-900/50 bg-blue-950/30' : 'text-zinc-500 border-zinc-700 bg-zinc-800/40'}`}>
                      {settings.autoSave ? '開啟' : '已關閉'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    在標題變更、段落編輯或生成完成後，於背景定時自動將草稿同步至瀏覽器本機資料庫（IndexedDB）。
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    關閉後：完全不於背景自動寫入儲存，僅在你手動按下編輯器工具列的「儲存」按鈕時才執行寫入。
                  </p>
                </div>

                <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1 sm:mt-0">
                  <input
                    type="checkbox"
                    checked={settings.autoSave}
                    onChange={(e) => updateSetting('autoSave', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>

              {/* Setting 8: autoScroll */}
              <div className="p-4 rounded-lg bg-zinc-900/50 border border-zinc-800/80 flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-200">生成時自動捲動到底部 (Auto-Scroll to Bottom)</span>
                    <span className={`text-[11px] font-mono px-1.5 py-0.2 border rounded ${settings.autoScroll ? 'text-blue-400 border-blue-900/50 bg-blue-950/30' : 'text-zinc-500 border-zinc-700 bg-zinc-800/40'}`}>
                      {settings.autoScroll ? '開啟' : '已關閉'}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    模型串流輸出最新內容時，自動將故事閱讀視窗順暢捲動至最新生成的字詞。
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    關閉後：保持你在頁面上的任何滾動位置，絕不會因新文字串流產生而強制跳轉捲動。
                  </p>
                </div>

                <label className="relative inline-flex items-center cursor-pointer shrink-0 mt-1 sm:mt-0">
                  <input
                    type="checkbox"
                    checked={settings.autoScroll}
                    onChange={(e) => updateSetting('autoScroll', e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                </label>
              </div>
            </div>
          </section>

          {/* Section 4: 預設參數偏好 (Generation Parameters) */}
          <section className="space-y-4">
            <div className="border-b border-zinc-800/80 pb-2">
              <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
                <Sliders className="w-4 h-4 text-blue-400" />
                預設參數偏好 (Generation Defaults)
              </h2>
              <p className="text-xs text-zinc-500 mt-0.5">自訂新開故事時採用的預設模型與溫度</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Default Model */}
              <div className="p-4 rounded-lg bg-zinc-900/50 border border-zinc-800/80 space-y-2">
                <label className="text-xs font-medium text-zinc-300 block">新故事預設模型 (Default Model)</label>
                <select
                  value={settings.defaultModel}
                  onChange={(e) => updateSetting('defaultModel', e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-md px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-blue-500 cursor-pointer"
                >
                  {availableModels.length > 0 ? (
                    availableModels.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.displayName}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite (高可用/推薦)</option>
                      <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
                      <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash-Lite</option>
                      <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                    </>
                  )}
                </select>
                <p className="text-[11px] text-zinc-500">在建立新故事或重置編輯器時預設選用的生成模型。</p>
              </div>

              {/* Default Temperature */}
              <div className="p-4 rounded-lg bg-zinc-900/50 border border-zinc-800/80 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-zinc-300 block">預設隨機度 (Temperature: {settings.defaultTemperature})</label>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.0"
                  step="0.05"
                  value={settings.defaultTemperature}
                  onChange={(e) => updateSetting('defaultTemperature', parseFloat(e.target.value))}
                  className="w-full h-1.5 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
                <div className="flex justify-between text-[10px] text-zinc-500">
                  <span>0.0 (嚴謹穩定)</span>
                  <span>0.7 (預設創作)</span>
                  <span>1.0 (高度隨機)</span>
                </div>
              </div>
            </div>
          </section>

          {/* Bottom Save Reminder */}
          <div className="pt-4 flex items-center justify-between border-t border-zinc-800">
            <div className="text-xs text-zinc-500">
              設定已自動保存在本機瀏覽器中，點擊右上角「儲存設定」亦可即刻確認同步。
            </div>
            <button
              onClick={() => saveSettings()}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-md transition-colors shadow-sm cursor-pointer"
            >
              {saveStatus === 'saved' ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-300" />
                  <span>已儲存設定</span>
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>儲存設定</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

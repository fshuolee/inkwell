export interface AppSettings {
  // 1. Model & Failover
  autoModelFallback: boolean; // 當所選模型配額超額 (429) 或服務高負載 (503) 時，是否自動切換至其他備用模型
  autoReconnect: boolean;     // 網路斷線或暫時性異常時，是否在背景自動啟動 3 次倒數重試

  // 2. Generation & Continuation Behavior
  autoContinuationLoop: boolean;     // 點擊續寫時，若遇到句子未完成是否自動發起下一輪接續
  autoDeduplicateOverlap: boolean;   // 是否自動偵測並修除模型在接續時重複生成的上下文文字
  autoFillDefaultPrompt: boolean;    // 未輸入任何文字點擊續寫時，是否自動補入接續引導詞
  autoRepromptOnAbruptEnd: boolean;  // 因 Token 上限或異常中斷時，是否自動追加接續提示繼續產生

  // 3. Editor & UI Behavior
  autoSave: boolean;        // 編輯內容或生成完成時，是否即時自動儲存至本地資料庫
  autoScroll: boolean;      // 串流生成文字時，是否自動將頁面捲動至最底部

  // 4. Defaults & Generation Parameters
  defaultTemperature: number; // 預設生成隨機度 (0.0 - 1.0)
  defaultModel: string;       // 預設模型
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoModelFallback: true,
  autoReconnect: true,
  autoContinuationLoop: true,
  autoDeduplicateOverlap: true,
  autoFillDefaultPrompt: true,
  autoRepromptOnAbruptEnd: true,
  autoSave: true,
  autoScroll: true,
  defaultTemperature: 0.7,
  defaultModel: 'gemini-2.5-flash-lite',
};

const SETTINGS_STORAGE_KEY = 'inkwell_app_settings_v1';

export function loadStoredSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (e) {
    console.error('Failed to parse stored settings:', e);
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveStoredSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save settings to localStorage:', e);
  }
}

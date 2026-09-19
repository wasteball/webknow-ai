/**
 * Playwright 里的 `page.evaluate` / `worker.evaluate` 会在扩展上下文求值，
 * 那里存在 chrome API，但测试文件本身不在扩展的类型环境里，因此只声明用到的子集。
 */
declare const chrome: {
  runtime: {
    getManifest(): {
      host_permissions?: string[];
      permissions?: string[];
      side_panel?: { default_path?: string };
    };
    connect(options: { name: string }): {
      onMessage: { addListener(cb: (message: { type: string; id?: number }) => void): void };
      postMessage(message: unknown): void;
      disconnect(): void;
    };
  };
  storage: {
    local: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      clear(): Promise<void>;
    };
    session: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  };
  tabs: {
    query(query: Record<string, unknown>): Promise<{ id?: number }[]>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  scripting: {
    executeScript(injection: { target: { tabId: number }; files: string[] }): Promise<unknown[]>;
  };
  permissions: { contains(permissions: { origins: string[] }): Promise<boolean> };
  sidePanel: {
    getOptions(options: Record<string, never>): Promise<{ path?: string; enabled?: boolean }>;
  };
};

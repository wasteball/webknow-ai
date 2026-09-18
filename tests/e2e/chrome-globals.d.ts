/**
 * Playwright 里的 `page.evaluate` / `worker.evaluate` 会在扩展上下文求值，
 * 那里存在 chrome API，但测试文件本身不在扩展的类型环境里，因此只声明用到的子集。
 */
declare const chrome: {
  runtime: {
    getManifest(): { host_permissions?: string[]; side_panel?: { default_path?: string } };
  };
  storage: {
    local: { set(items: Record<string, unknown>): Promise<void> };
    session: {
      get(keys: null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  tabs: { query(query: Record<string, unknown>): Promise<{ id?: number }[]> };
  permissions: { contains(permissions: { origins: string[] }): Promise<boolean> };
  sidePanel: {
    getOptions(options: Record<string, never>): Promise<{ path?: string; enabled?: boolean }>;
  };
};

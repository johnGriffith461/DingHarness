/// <reference types="vite/client" />

/** preload.ts 通过 contextBridge 暴露的窄接口。加方法时这里同步补。 */
declare global {
  interface Window {
    shell: {
      ping: () => Promise<{
        ok: boolean;
        platform: string;
        versions: { electron: string; node: string; chrome: string };
      }>;
      userDataDir: () => Promise<string>;
    };
  }
}

export {};

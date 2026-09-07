import { defineConfig, transformWithOxc, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const adapter = fileURLToPath(new URL('./client/sdk-storage.ts', import.meta.url));
const sdkStorage = /[/\\]@colyseus[/\\]sdk[/\\]build[/\\]Storage\.mjs$/;
function optionalStorage(): Plugin {
  return {
    name: 'optional-colyseus-storage',
    enforce: 'pre',
    async load(id) {
      if (sdkStorage.test(id))
        return (await transformWithOxc(readFileSync(adapter, 'utf8'), adapter)).code;
    },
  };
}
export default defineConfig({
  // The SDK's optional auth-storage read must not block account-free play.
  plugins: [optionalStorage()],
  optimizeDeps: { rolldownOptions: { plugins: [optionalStorage()] } },
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/three/')) return 'three';
          if (id.includes('/@colyseus/')) return 'multiplayer';
        },
      },
    },
  },
});

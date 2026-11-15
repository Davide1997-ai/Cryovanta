import { defineConfig } from 'vite';
export default defineConfig({ base: './', server: { port: 5173, host: true }, build: { chunkSizeWarningLimit: 1500, rollupOptions: { input: { main: 'index.html', pad: 'pad.html' } } } });

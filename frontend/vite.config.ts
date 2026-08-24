import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/queue': 'http://localhost:3000',
      '/visitors': 'http://localhost:3000',
      '/chat': 'http://localhost:3000',
      '/debug': 'http://localhost:3000',
    },
  },
});

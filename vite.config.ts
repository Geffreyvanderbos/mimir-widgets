import { defineConfig } from 'vite';

const entry = (path: string) => new URL(path, import.meta.url).pathname;

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: entry('./index.html'),
        countdown: entry('./countdown/index.html'),
        pomodoro: entry('./pomodoro/index.html'),
        weather: entry('./weather/index.html'),
      },
    },
  },
});

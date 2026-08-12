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
        calc: entry('./calc/index.html'),
        dummy: entry('./dummy/index.html'),
        timer: entry('./timer/index.html'),
        hike: entry('./hike/index.html'),
        gpx: entry('./gpx/index.html'),
        fx: entry('./fx/index.html'),
        color: entry('./color/index.html'),
        train: entry('./train/index.html'),
        holidays: entry('./holidays/index.html'),
        nearby: entry('./nearby/index.html'),
      },
    },
  },
});

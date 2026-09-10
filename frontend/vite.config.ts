import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const vendorManualChunks = (id: string) => {
  if (!id.includes('node_modules')) {
    return undefined;
  }
  if (
    id.includes('node_modules\\react\\') ||
    id.includes('node_modules/react/') ||
    id.includes('node_modules\\react-dom\\') ||
    id.includes('node_modules/react-dom/') ||
    id.includes('node_modules\\react-router') ||
    id.includes('node_modules/react-router') ||
    id.includes('node_modules\\scheduler\\') ||
    id.includes('node_modules/scheduler/')
  ) {
    return 'vendor-react';
  }
  if (
    id.includes('node_modules\\antd\\') ||
    id.includes('node_modules/antd/') ||
    id.includes('node_modules\\@ant-design\\') ||
    id.includes('node_modules/@ant-design/') ||
    id.includes('node_modules\\rc-') ||
    id.includes('node_modules/rc-') ||
    id.includes('node_modules\\@rc-component\\') ||
    id.includes('node_modules/@rc-component/')
  ) {
    return 'vendor-antd';
  }
  if (
    id.includes('node_modules\\axios\\') ||
    id.includes('node_modules/axios/') ||
    id.includes('node_modules\\dayjs\\') ||
    id.includes('node_modules/dayjs/') ||
    id.includes('node_modules\\zustand\\') ||
    id.includes('node_modules/zustand/') ||
    id.includes('node_modules\\clsx\\') ||
    id.includes('node_modules/clsx/') ||
    id.includes('node_modules\\lucide-react\\') ||
    id.includes('node_modules/lucide-react/')
  ) {
    return 'vendor-utils';
  }
  if (
    id.includes('node_modules\\classnames\\') ||
    id.includes('node_modules/classnames/') ||
    id.includes('node_modules\\throttle-debounce\\') ||
    id.includes('node_modules/throttle-debounce/') ||
    id.includes('node_modules\\stylis\\') ||
    id.includes('node_modules/stylis/') ||
    id.includes('node_modules\\@emotion\\') ||
    id.includes('node_modules/@emotion/') ||
    id.includes('node_modules\\@babel\\') ||
    id.includes('node_modules/@babel/') ||
    id.includes('node_modules\\scroll-into-view-if-needed\\') ||
    id.includes('node_modules/scroll-into-view-if-needed/') ||
    id.includes('node_modules\\compute-scroll-into-view\\') ||
    id.includes('node_modules/compute-scroll-into-view/') ||
    id.includes('node_modules\\copy-to-clipboard\\') ||
    id.includes('node_modules/copy-to-clipboard/') ||
    id.includes('node_modules\\toggle-selection\\') ||
    id.includes('node_modules/toggle-selection/') ||
    id.includes('node_modules\\shallowequal\\') ||
    id.includes('node_modules/shallowequal/') ||
    id.includes('node_modules\\dom-align\\') ||
    id.includes('node_modules/dom-align/')
  ) {
    return 'vendor-antd-helpers';
  }
  return 'vendor-misc';
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = env.VITE_API_PROXY_TARGET || env.VITE_API_BASE_URL;
  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      strictPort: true,
      proxy: proxyTarget
        ? {
            '/api': {
              target: proxyTarget,
              changeOrigin: true,
              ws: false
            }
          }
        : undefined
    },
    build: {
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: vendorManualChunks
        }
      }
    }
  };
});

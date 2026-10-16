import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    // ⚠️ 与旧项目 race 的 5174 隔离，本环境（race3）改用 5175
    port: 5175,
    proxy: {
      '/api': {
        // 可用环境变量 VITE_DEV_PROXY 覆盖（如本地 venv 后端）
        // race3 Docker 后端主机端口为 18001（8001 被 Windows 系统保留无法绑定）
        target: process.env.VITE_DEV_PROXY || 'http://localhost:18001',
        changeOrigin: true,
      },
    },
  },
})

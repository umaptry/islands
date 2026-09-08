import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 60000,
  outputDir: 'output/browser-tests',
  reporter: [['list'], ['html', { outputFolder: 'output/playwright-report', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:7861', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [375, 390, 768, 1440].map(width => ({ name: `${width}px`, use: { viewport: { width, height: 900 } } })),
  webServer: {
    command: 'python -m uvicorn app:app --host 127.0.0.1 --port 7861',
    url: 'http://127.0.0.1:7861/api/health', timeout: 180000, reuseExistingServer: false,
    env: { SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', SUPABASE_ANON_KEY: '',
      EMBEDDING_PROVIDER: 'onnx', MAP_ARTIFACTS_DIR: '', MAP_RUNTIME_CHECK: '0', KOTOBA_DISABLE_RATE_LIMIT: '1' },
  },
});

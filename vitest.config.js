import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    clearMocks: true,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      // Test-only credentials; no real provider or user secrets.
      API_KEYS: 'test-user-key',
      ADMIN_API_KEYS: 'test-admin-key',
    },
  },
});

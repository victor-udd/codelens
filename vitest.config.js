import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    clearMocks: true,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
    },
  },
});

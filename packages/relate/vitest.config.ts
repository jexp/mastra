import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit:packages/relate',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
    ],
  },
});

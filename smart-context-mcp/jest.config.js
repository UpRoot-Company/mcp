export default {
  testEnvironment: 'node',
  transform: {},
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  setupFilesAfterEnv: ['<rootDir>/dist/tests/setup.js'],
  testMatch: ['**/dist/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/dist/tests/performance/'],
  verbose: true
};

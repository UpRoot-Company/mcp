export default {
  testEnvironment: 'node',
  transform: {},
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  setupFilesAfterEnv: ['<rootDir>/dist/src/tests/setup.js'],
  testMatch: ['**/dist/src/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/dist/src/tests/performance/'],
  verbose: true
};

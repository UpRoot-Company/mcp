export default {
  testEnvironment: 'node',
  transform: {},
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['**/dist/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/dist/tests/performance/'],
  verbose: true
};

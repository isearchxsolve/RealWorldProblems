/**
 * Root test runner for the repository-level scenario suites under `tests/`.
 *
 * The api workspace keeps its own Jest configuration (api/jest.config.js) that is
 * exercised by `yarn api:test`; this runner exposes the same scenario suites at the
 * canonical `tests/<scenario>` paths without altering the workspace configuration
 * or CI workflows.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  clearMocks: true,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'ES2022',
          moduleResolution: 'node',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          skipLibCheck: true,
          types: ['node', 'jest']
        }
      }
    ]
  }
};

/**
 * ESLint flat config for Alpha Ice Surfers 3D.
 * Run with: npx eslint js workers libs
 */

export default [
  {
    files: ['js/**/*.js', 'workers/**/*.js', 'libs/tween.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        indexedDB: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        Worker: 'readonly',
        self: 'readonly',
        screen: 'readonly',
        confirm: 'readonly',
        AudioContext: 'readonly',
        webkitAudioContext: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'eqeqeq': ['warn', 'smart'],
      'no-var': 'error',
      'prefer-const': 'warn'
    }
  }
];

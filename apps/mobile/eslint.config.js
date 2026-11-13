// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    rules: {
      // Off on purpose, the one rule disabled here. react/no-unescaped-entities exists to stop a stray ' " > or } in HTML
      // markup being read as syntax. In React Native, JSX text is handed to <Text> as it is: there is no HTML parser, an
      // apostrophe renders as an apostrophe, and the places it flagged (26 of the 62 errors) were ordinary English copy ("Can't reach",
      // "What's wrong?"). Rewriting them as &apos; or curly quotes would make the copy harder to read and edit and change
      // nothing on screen. Every other error this lint reported was fixed in the code instead.
      'react/no-unescaped-entities': 'off',
      // Every modal goes through components/Modal.tsx, which tells lib/overlay.ts it is open, so the store rating ask
      // (lib/review-trigger.ts) never lands on top of one.
      'no-restricted-imports': ['error', { paths: [{ name: 'react-native', importNames: ['Modal'], message: "Use { Modal } from components/Modal: it counts open modals for lib/overlay.ts." }] }],
    },
  },
  {
    files: ['src/components/Modal.tsx'],
    rules: { 'no-restricted-imports': 'off' },
  },
]);

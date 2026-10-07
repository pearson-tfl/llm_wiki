// The estate's lint: typescript-eslint's two promise rules over src/, and
// nothing else (pearson-tfl/llm_wiki#90). Run: npm run lint
// The violations already in src/ when it was added are listed, per file and
// rule, in eslint-suppressions.json; a new one fails. See ESTATE.md, Check.
import { defineConfig } from "eslint/config"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"

export default defineConfig({
  files: ["src/**/*.{ts,tsx}"],
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
  },
  // Upstream's code carries disable comments for rules this lint does not
  // run. The react-hooks plugin is registered, none of its rules turned on,
  // so the two comments naming its rules do not fail as unknown rules.
  linterOptions: { reportUnusedDisableDirectives: "off" },
  plugins: { "@typescript-eslint": tseslint.plugin, "react-hooks": reactHooks },
  rules: {
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
  },
})

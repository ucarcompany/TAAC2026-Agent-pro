# Minimal package.json

Use this package file when creating a standalone TAAC2026 CLI workspace.

```json
{
  "name": "taac2026-cli-workspace",
  "version": "0.1.0",
  "private": true,
  "description": "Standalone TAAC2026 / Taiji experiment CLI workspace.",
  "type": "module",
  "bin": {
    "taac2026": "./bin/taac2026.mjs"
  },
  "scripts": {
    "cli": "node bin/taac2026.mjs",
    "scrape:all": "node scrape-taiji.mjs --all",
    "scrape": "node scrape-taiji.mjs",
    "diff:config": "node compare-config-yaml.mjs",
    "prepare:submit": "node prepare-taiji-submit.mjs",
    "submit": "node submit-taiji.mjs",
    "check": "node --check bin/taac2026.mjs && node --check scrape-taiji.mjs && node --check compare-config-yaml.mjs && node --check prepare-taiji-submit.mjs && node --check submit-taiji.mjs"
  },
  "dependencies": {
    "cos-nodejs-sdk-v5": "^2.15.4",
    "js-yaml": "^4.1.0",
    "playwright": "^1.52.0"
  }
}
```

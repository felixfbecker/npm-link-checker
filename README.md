# npm-link-checker

A little CLI tool that makes sure the packages you `npm link`ed are not behind the version declared in package.json.

## Installation

```
npm install npm-link-checker
```

## Usage

Run `check-npm-links` in a folder with package.json and node_modules.
Pass `--watch` to watch the linked repositories and check whenever their git HEAD changes.

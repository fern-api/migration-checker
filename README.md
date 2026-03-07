# Docs Migration Analyzer

Automated analysis tool for comparing old and new documentation sites during migration.

## Setup

```bash
npm install
```

## Run Analysis

```bash
# Using default URLs
node analyze.js

# Specify custom URLs
node analyze.js https://old-site.com https://new-site.com

# Specify custom sitemap URL (3rd argument)
node analyze.js https://old-site.com https://new-site.com https://old-site.com/custom-sitemap.xml

# Specify custom heading selectors (4th argument)
node analyze.js https://docs.merge.dev https://merge.ferndocs.com "" "h1,h2,h3,.custom-heading"
```

**Custom Heading Selectors (Priority Fallback System):**

The script tries selectors **in order from left to right** and uses the first match found.

Example: `h1,h2,h3,.custom-heading`

1. First tries to find `h1` (standard heading)
2. If no `h1`, tries `h2`
3. If no `h2`, tries `h3`
4. If none found, falls back to `.custom-heading`

Default: `h1,h2,h3`

**Sitemap Auto-Detection:**

The script first tries common sitemap locations:

- `/sitemap.xml`
- `/sitemap_index.xml`
- `/sitemap-index.xml`
- `/sitemaps/sitemap.xml`
- `/sitemap/sitemap.xml`
- `/docs/sitemap.xml`

If not found, it prompts you to enter the sitemap URL manually.

## What It Does

**3-Tier Analysis:**

1. **Critical (404s)**: Pages that don't exist on the new site
2. **Warnings**:
   - Wrong redirect destinations (H1 doesn't match)
   - Content mismatches (heading structure differs by >40%)
3. **Pass**: Pages that migrated successfully

**Performance:**

- Adjust concurrency in `analyze.js` by changing `CONCURRENCY` constant (line 11)
- Default: 25 concurrent pages
- Higher values = faster but more resource intensive

## Report

The tool generates `migration-report-[timestamp].html` with:

- Summary statistics
- Critical issues to fix immediately
- Warnings to investigate
- Passed pages with match percentages
- Direct links to open any page on old/new site
- Heading comparisons for content mismatches

The report automatically opens in your browser when analysis completes.

**Interactive Features:**

- **Dismiss False Positives**: Click "Dismiss (False Positive)" on warnings that aren't real issues
- **Confirm Issues**: Click "Confirm Issue" to mark items that need attention
- **Filter Views**: Use buttons to filter (Show All, Active Only, Dismissed Only, Confirmed Only)
- **Persistent State**: Your dismissals/confirmations are saved in localStorage and persist across page reloads

## Caching

Passed pages are cached to `migration-cache.json` and skipped on subsequent runs.

Use `--full` to force a complete rescan (e.g., after deploying fixes):

```bash
node analyze.js https://old-site.com https://new-site.com "" "" --full
```

## Live Report

During analysis, a live-updating report is available:

- **File**: `migration-report-live.html`
- Auto-refreshes every 5 seconds
- Shows results as they come in
- Automatically deleted when analysis completes

## Screenshots

The tool captures screenshots for issues:

- **Directory**: `screenshots/`
- **Format**: JPEG at 50% quality (small file size)
- **Naming**: `[path]-old.jpg` and `[path]-new.jpg`
- Captured for all warnings and critical issues
- Viewable in the HTML report via "Show/Hide Screenshots" toggle

## LLM Output

Generates a structured JSON file for AI-assisted redirect fixing:

- **File**: `migration-data.json`
- Contains all warnings and critical issues with:
  - Page paths and URLs
  - Heading comparisons
  - Screenshot file paths
- Includes instructions for an LLM to suggest corrected redirects
- Output format: YAML redirects list

Example usage with an AI:

```bash
# After running analysis, feed the JSON to an LLM
cat migration-data.json | claude "Review these issues and suggest redirects"
```

## Redirects File

Generates a ready-to-use redirects configuration:

- **File**: `redirects-[timestamp].mdx`
- Contains three sections:
  1. **Verified Redirects**: Working correctly (content matches)
  2. **Needs Review**: Redirects with heading mismatches
  3. **Missing Redirects**: 404s that need destinations
- Includes implementation snippets for Fern (`fern.config.yml`)

---

## Upgrade Diff Tool

Visual, structural, and text comparison between two versions of a docs site (e.g. production vs preview).

### Usage

```bash
node upgrade-diff.js <production-url> <preview-url> [sitemap-url] [options]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--filter=<pattern>` | Only check pages matching this path pattern | (all pages) |
| `--concurrency=<n>` | Number of parallel comparisons | `10` |
| `--explorer[=<pattern>]` | Append `?explorer` to pages | off |
| `--diff-threshold=<n>` | Pixel diff % threshold for embedding images in report | `2` |
| `--check-header` | Include header elements in comparisons | off (stripped) |
| `--check-sidebar` | Include sidebar elements in comparisons | off (stripped) |
| `--check-footer` | Include footer elements in comparisons | off (stripped) |
| `--share` | Regenerate shareable report from existing data | — |
| `--ci` | Write CI summary JSON for GitHub Actions | off |

### Examples

```bash
# Basic comparison
node upgrade-diff.js https://docs.example.com https://preview.example.com

# Only API reference pages, with header/sidebar included
node upgrade-diff.js https://docs.example.com https://preview.example.com \
  --filter=/api-reference --check-header --check-sidebar

# Lower threshold to catch smaller visual regressions
node upgrade-diff.js https://docs.example.com https://preview.example.com \
  --diff-threshold=1

# Regenerate shareable report from last run
node upgrade-diff.js --share
```

### Component Check Flags

By default, the tool strips headers, sidebars, and footers from comparisons to focus on page content. Use the `--check-*` flags to include them:

- `--check-header` keeps: `header`, `[role="banner"]`, `.header`
- `--check-sidebar` keeps: `.sidebar`
- `--check-footer` keeps: `footer`, `[role="contentinfo"]`, `.footer`

### GitHub Action

This tool can run as a GitHub Action on pull requests. Add it to your workflow:

```yaml
# .github/workflows/docs-diff.yml
name: Docs Diff

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  docs-diff:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: ./
        with:
          production-url: ${{ vars.DOCS_PRODUCTION_URL }}
          preview-url: ${{ vars.DOCS_PREVIEW_URL }}
```

**Required repository variables:**

| Variable | Description |
|----------|-------------|
| `DOCS_PRODUCTION_URL` | Production docs URL |
| `DOCS_PREVIEW_URL` | Preview/staging docs URL |

**Optional repository variables:**

| Variable | Description | Default |
|----------|-------------|---------|
| `DOCS_DIFF_FILTER` | Path filter pattern | (all pages) |
| `DOCS_DIFF_CONCURRENCY` | Parallel comparisons | `10` |
| `DOCS_DIFF_THRESHOLD` | Pixel diff threshold | `2` |
| `DOCS_CHECK_HEADER` | Include header | `false` |
| `DOCS_CHECK_SIDEBAR` | Include sidebar | `false` |
| `DOCS_CHECK_FOOTER` | Include footer | `false` |

The action posts a summary comment on the PR with a table of changes and a link to the full HTML report artifact.

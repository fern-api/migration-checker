const puppeteer = require('puppeteer');
const fs = require('fs');
const xml2js = require('xml2js');
const Diff = require('diff');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch').default || require('pixelmatch');
const readline = require('readline');

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
const positional = [];

for (const arg of args) {
  if (arg.startsWith('--')) {
    const [key, val] = arg.slice(2).split('=');
    flags[key] = val ?? true;
  } else {
    positional.push(arg);
  }
}

let PROD_URL = (positional[0] || '').replace(/\/$/, '');
let PREVIEW_URL = (positional[1] || '').replace(/\/$/, '');
const SITEMAP_URL = positional[2] || null;
const FILTER = flags.filter || null;
const CONCURRENCY = parseInt(flags.concurrency, 10) || 10;
// --explorer with no value = apply to all filtered pages
// --explorer=/reference = only add ?explorer to pages matching this pattern
const EXPLORER = flags.explorer !== undefined ? (flags.explorer === true ? '' : flags.explorer) : null;
const DIFF_THRESHOLD = parseFloat(flags['diff-threshold']) || 2;
const CHECK_HEADER = !!flags['check-header'];
const CHECK_SIDEBAR = !!flags['check-sidebar'];
const CHECK_FOOTER = !!flags['check-footer'];
const CI_MODE = !!flags.ci;

if (!flags.share && (!PROD_URL || !PREVIEW_URL)) {
  console.error('Usage: node upgrade-diff.js <production-url> <preview-url> [sitemap-url] [options]');
  console.error('');
  console.error('Options:');
  console.error('  --filter=<pattern>       Only check pages matching this path pattern');
  console.error('  --concurrency=<n>        Number of parallel comparisons (default: 10)');
  console.error('  --explorer[=<pattern>]   Append ?explorer to pages (optionally filtered)');
  console.error('  --diff-threshold=<n>     Pixel diff % to embed in report (default: 2)');
  console.error('  --check-header           Include header in comparisons (stripped by default)');
  console.error('  --check-sidebar          Include sidebar in comparisons (stripped by default)');
  console.error('  --check-footer           Include footer in comparisons (stripped by default)');
  console.error('  --share                  Regenerate shareable report from existing data');
  process.exit(1);
}

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m'
};

// ─── Output Paths ────────────────────────────────────────────────────────────

const TIMESTAMP = Date.now();
const SCREENSHOTS_DIR = 'upgrade-diff-screenshots';
const DATA_FILE = 'upgrade-diff-data.json';
const LIVE_REPORT = 'upgrade-diff-report-live.html';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Results Store ───────────────────────────────────────────────────────────

const results = [];
let completedCount = 0;
let totalPages = 0;

// ─── Sitemap Fetching (reused from analyze.js) ──────────────────────────────

async function trySitemapUrl(sitemapUrl) {
  try {
    const response = await fetch(sitemapUrl);
    if (!response.ok) return null;

    const xml = await response.text();
    const parser = new xml2js.Parser();
    const parsed = await parser.parseStringPromise(xml);

    if (!parsed.urlset || !parsed.urlset.url) return null;

    return parsed.urlset.url.map(entry => {
      const fullUrl = entry.loc[0];
      const urlObj = new URL(fullUrl);
      return urlObj.pathname + urlObj.search + urlObj.hash;
    });
  } catch (e) {
    return null;
  }
}

function promptUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function fetchSitemap(baseUrl) {
  const origin = baseUrl.replace(/\/$/, '');

  if (SITEMAP_URL) {
    console.log(`Trying provided sitemap: ${SITEMAP_URL}...`);
    const urls = await trySitemapUrl(SITEMAP_URL);
    if (urls) { console.log(`Found ${urls.length} pages in sitemap\n`); return urls; }
    console.log(`${colors.red}Could not fetch sitemap from ${SITEMAP_URL}${colors.reset}\n`);
  }

  const commonPaths = [
    '/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml',
    '/sitemaps/sitemap.xml', '/sitemap/sitemap.xml', '/docs/sitemap.xml'
  ];

  console.log(`Searching for sitemap at ${origin}...`);
  for (const path of commonPaths) {
    console.log(`  Trying ${path}...`);
    const urls = await trySitemapUrl(origin + path);
    if (urls) {
      console.log(`  Found sitemap at ${path}!\nFound ${urls.length} pages\n`);
      return urls;
    }
  }

  console.log(`\n${colors.red}Could not find sitemap automatically.${colors.reset}\n`);
  const userUrl = await promptUser('Enter sitemap URL (or Ctrl+C to exit): ');
  if (!userUrl) throw new Error('No sitemap URL provided');

  const urls = await trySitemapUrl(userUrl);
  if (!urls) throw new Error(`Failed to fetch sitemap from ${userUrl}`);
  console.log(`Found ${urls.length} pages\n`);
  return urls;
}

// ─── Navigation (reused from analyze.js) ─────────────────────────────────────

async function navigateWithRetry(page, url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    } catch (error) {
      if (attempt < retries) {
        console.log(`  ${colors.yellow}Retry ${attempt + 1}/${retries} for ${url}${colors.reset}`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        throw error;
      }
    }
  }
}

// ─── Scroll to Bottom (trigger lazy-loaded content) ─────────────────────────

async function scrollToBottom(page) {
  await page.evaluate(async () => {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const scrollHeight = () => document.body.scrollHeight;

    // Scroll down in steps to trigger lazy-loaded content
    let prev = 0;
    let curr = scrollHeight();
    while (prev !== curr) {
      prev = curr;
      window.scrollTo(0, curr);
      await delay(500);
      curr = scrollHeight();
    }

    // Double-check: wait longer and verify height is truly stable
    await delay(2000);
    const afterWait = scrollHeight();
    if (afterWait !== curr) {
      // More content loaded — scroll again
      window.scrollTo(0, afterWait);
      await delay(1000);
    }

    // Scroll back to top so screenshot starts from top
    window.scrollTo(0, 0);
    await delay(500);
  });
}

// ─── Screenshot Capture (adapted from analyze.js) ───────────────────────────

function safeName(path) {
  return path.replace(/[/?&=]/g, '_').replace(/^_/, '').replace(/_$/, '') || 'root';
}

async function captureScreenshot(page, path, label) {
  try {
    ensureDir(SCREENSHOTS_DIR);
    const filename = `${safeName(path)}-${label}.png`;

    // Hide stripped components so screenshots match the comparison scope
    const hideSelectors = [];
    if (!CHECK_HEADER) hideSelectors.push('header', '[role="banner"]', '.header', '#fern-header');
    if (!CHECK_SIDEBAR) hideSelectors.push('.sidebar', '#fern-sidebar', '.fern-sidebar', '#fern-toc', 'aside');
    if (!CHECK_FOOTER) hideSelectors.push('footer', '[role="contentinfo"]', '.footer', '#fern-footer', '.fern-footer');

    if (hideSelectors.length > 0) {
      await page.evaluate((selectors) => {
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(el => {
            el.dataset.diffHidden = el.style.display;
            el.style.display = 'none';
          });
        }
      }, hideSelectors);
    }

    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/${filename}`,
      fullPage: true,
      type: 'png'
    });

    // Restore hidden elements so page state isn't affected
    if (hideSelectors.length > 0) {
      await page.evaluate((selectors) => {
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach(el => {
            el.style.display = el.dataset.diffHidden || '';
            delete el.dataset.diffHidden;
          });
        }
      }, hideSelectors);
    }

    return filename;
  } catch (e) {
    return null;
  }
}

// ─── Screenshot Diff (pixel-level comparison) ───────────────────────────────

function generateScreenshotDiff(prodFile, previewFile, path) {
  try {
    const prodPng = PNG.sync.read(fs.readFileSync(`${SCREENSHOTS_DIR}/${prodFile}`));
    const previewPng = PNG.sync.read(fs.readFileSync(`${SCREENSHOTS_DIR}/${previewFile}`));

    // Compare only the overlapping region (min dimensions) so height
    // mismatches from lazy-loading don't create giant red blocks.
    // Track the extra pixels separately.
    const width = Math.max(prodPng.width, previewPng.width);
    const compareHeight = Math.min(prodPng.height, previewPng.height);
    const maxHeight = Math.max(prodPng.height, previewPng.height);

    // Crop/pad both images to (width x compareHeight) for the comparison
    function cropImage(png, w, h) {
      if (png.width === w && png.height === h) return png.data;
      const out = Buffer.alloc(w * h * 4, 0);
      const copyW = Math.min(png.width, w);
      const copyH = Math.min(png.height, h);
      for (let y = 0; y < copyH; y++) {
        for (let x = 0; x < copyW; x++) {
          const srcIdx = (y * png.width + x) * 4;
          const dstIdx = (y * w + x) * 4;
          out[dstIdx] = png.data[srcIdx];
          out[dstIdx + 1] = png.data[srcIdx + 1];
          out[dstIdx + 2] = png.data[srcIdx + 2];
          out[dstIdx + 3] = png.data[srcIdx + 3];
        }
      }
      return out;
    }

    const prodData = cropImage(prodPng, width, compareHeight);
    const previewData = cropImage(previewPng, width, compareHeight);

    const diff = new PNG({ width, height: compareHeight });
    const mismatchedPixels = pixelmatch(prodData, previewData, diff.data, width, compareHeight, {
      threshold: 0.1,
      diffColor: [255, 0, 0],
      alpha: 0.3
    });

    const diffFilename = `${safeName(path)}-diff.png`;
    fs.writeFileSync(`${SCREENSHOTS_DIR}/${diffFilename}`, PNG.sync.write(diff));

    // Calculate diff percent against the comparable area only
    const comparePixels = width * compareHeight;
    const diffPercent = comparePixels > 0 ? ((mismatchedPixels / comparePixels) * 100).toFixed(2) : '0.00';

    // Note height difference if any
    const heightDiff = maxHeight - compareHeight;

    return { filename: diffFilename, mismatchedPixels, totalPixels: comparePixels, diffPercent, heightDiff };
  } catch (e) {
    return null;
  }
}

// ─── Content Extraction ─────────────────────────────────────────────────────

/**
 * Extract visible text from the main content area of the page.
 * Auto-detects common content containers, strips nav/header/footer.
 */
async function extractPageContent(page) {
  return page.evaluate(({ checkHeader, checkSidebar, checkFooter }) => {
    // Priority list of content selectors
    const contentSelectors = [
      'main',
      'article',
      '[role="main"]',
      '.fern-page-content',
      '.page-content',
      '.content-body',
      '.markdown-body',
      '#content',
      '#main-content',
      '.documentation-content'
    ];

    let contentRoot = null;
    for (const sel of contentSelectors) {
      contentRoot = document.querySelector(sel);
      if (contentRoot) break;
    }

    if (!contentRoot) contentRoot = document.body;

    // Clone to avoid mutating the page
    const clone = contentRoot.cloneNode(true);

    // Build removeSelectors dynamically based on check flags
    const removeSelectors = [
      'nav', '[role="navigation"]', '.nav',
      '.table-of-contents', '.toc',
      'script', 'style', 'noscript'
    ];
    if (!checkHeader) removeSelectors.push('header', '[role="banner"]', '.header', '#fern-header');
    if (!checkSidebar) removeSelectors.push('.sidebar', '#fern-sidebar', '.fern-sidebar', '#fern-toc', 'aside');
    if (!checkFooter) removeSelectors.push('footer', '[role="contentinfo"]', '.footer', '#fern-footer', '.fern-footer');

    for (const sel of removeSelectors) {
      clone.querySelectorAll(sel).forEach(el => el.remove());
    }

    // Extract visible text, preserving block-level structure
    function extractText(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();
      const blockTags = new Set([
        'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'li', 'tr', 'blockquote', 'pre', 'section', 'article',
        'ul', 'ol', 'table', 'thead', 'tbody', 'dt', 'dd', 'hr'
      ]);

      let text = '';
      for (const child of node.childNodes) {
        text += extractText(child);
      }

      if (blockTags.has(tag)) {
        text = '\n' + text.trim() + '\n';
      }

      return text;
    }

    const raw = extractText(clone);
    // Normalize: collapse whitespace within lines, collapse blank lines
    return raw
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(line => line.length > 0)
      .join('\n');
  }, { checkHeader: CHECK_HEADER, checkSidebar: CHECK_SIDEBAR, checkFooter: CHECK_FOOTER });
}

// ─── DOM Structure Extraction ───────────────────────────────────────────────

/**
 * Extract a simplified semantic DOM tree from the main content area.
 * Captures: tag names, heading text, code block languages, link hrefs, nesting.
 */
async function extractDOMStructure(page) {
  return page.evaluate(({ checkHeader, checkSidebar, checkFooter }) => {
    const contentSelectors = [
      'main', 'article', '[role="main"]',
      '.fern-page-content', '.page-content', '.content-body',
      '.markdown-body', '#content', '#main-content', '.documentation-content'
    ];

    let contentRoot = null;
    for (const sel of contentSelectors) {
      contentRoot = document.querySelector(sel);
      if (contentRoot) break;
    }
    if (!contentRoot) contentRoot = document.body;

    const removeSelectors = [
      'nav', '[role="navigation"]', '.nav',
      '.table-of-contents', '.toc',
      'script', 'style', 'noscript'
    ];
    if (!checkHeader) removeSelectors.push('header', '[role="banner"]', '.header', '#fern-header');
    if (!checkSidebar) removeSelectors.push('.sidebar', '#fern-sidebar', '.fern-sidebar', '#fern-toc', 'aside');
    if (!checkFooter) removeSelectors.push('footer', '[role="contentinfo"]', '.footer', '#fern-footer', '.fern-footer');

    // Semantic tags we care about
    const semanticTags = new Set([
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'pre', 'code', 'blockquote',
      'ul', 'ol', 'li',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'a', 'img',
      'section', 'article', 'main', 'div',
      'details', 'summary',
      'dl', 'dt', 'dd',
      'hr'
    ]);

    function buildTree(node) {
      if (node.nodeType !== Node.ELEMENT_NODE) return null;

      const tag = node.tagName.toLowerCase();

      // Skip removed selectors
      for (const sel of removeSelectors) {
        try { if (node.matches(sel)) return null; } catch (e) {}
      }

      if (!semanticTags.has(tag)) {
        // Not a semantic tag — pass through children
        const children = [];
        for (const child of node.children) {
          const subtree = buildTree(child);
          if (subtree) {
            if (Array.isArray(subtree)) children.push(...subtree);
            else children.push(subtree);
          }
        }
        return children.length > 0 ? children : null;
      }

      const entry = { tag };

      // Headings: include text
      if (/^h[1-6]$/.test(tag)) {
        entry.text = node.textContent.trim().slice(0, 200);
      }

      // Code blocks: include language
      if (tag === 'pre') {
        const codeEl = node.querySelector('code');
        if (codeEl) {
          const langClass = [...codeEl.classList].find(c => c.startsWith('language-'));
          entry.lang = langClass ? langClass.replace('language-', '') : null;
        }
      }

      // Links: include href
      if (tag === 'a') {
        entry.href = node.getAttribute('href') || null;
      }

      // Images: include alt
      if (tag === 'img') {
        entry.alt = node.getAttribute('alt') || null;
      }

      // Build children
      const children = [];
      for (const child of node.children) {
        const subtree = buildTree(child);
        if (subtree) {
          if (Array.isArray(subtree)) children.push(...subtree);
          else children.push(subtree);
        }
      }
      if (children.length > 0) entry.children = children;

      return entry;
    }

    const tree = buildTree(contentRoot);
    return Array.isArray(tree) ? { tag: 'root', children: tree } : (tree || { tag: 'root' });
  }, { checkHeader: CHECK_HEADER, checkSidebar: CHECK_SIDEBAR, checkFooter: CHECK_FOOTER });
}

// ─── Structure Serialization ────────────────────────────────────────────────

/**
 * Serialize a DOM structure tree into indented text for diffing.
 */
function serializeStructure(node, indent = 0) {
  if (!node) return '';
  const pad = '  '.repeat(indent);
  let line = `${pad}<${node.tag}`;

  if (node.text) line += ` "${node.text}"`;
  if (node.lang) line += ` lang="${node.lang}"`;
  if (node.href) line += ` href="${node.href}"`;
  if (node.alt) line += ` alt="${node.alt}"`;

  line += '>';

  if (!node.children || node.children.length === 0) {
    return line + '\n';
  }

  let result = line + '\n';
  for (const child of node.children) {
    result += serializeStructure(child, indent + 1);
  }
  return result;
}

// ─── Diff Computation ───────────────────────────────────────────────────────

function computeTextDiff(oldText, newText) {
  const changes = Diff.diffLines(oldText, newText);
  let added = 0;
  let removed = 0;
  const hunks = [];

  for (const part of changes) {
    if (part.added) {
      added += part.count || part.value.split('\n').filter(Boolean).length;
      hunks.push({ type: 'add', value: part.value });
    } else if (part.removed) {
      removed += part.count || part.value.split('\n').filter(Boolean).length;
      hunks.push({ type: 'remove', value: part.value });
    } else {
      hunks.push({ type: 'context', value: part.value });
    }
  }

  const hasChanges = added > 0 || removed > 0;
  return { hasChanges, added, removed, hunks };
}

function computeStructureDiff(oldTree, newTree) {
  const oldText = serializeStructure(oldTree);
  const newText = serializeStructure(newTree);
  return computeTextDiff(oldText, newText);
}

// ─── Page Classification ────────────────────────────────────────────────────

function classifyPage(textDiff, structureDiff, error) {
  if (error) return 'error';
  if (structureDiff && structureDiff.hasChanges) return 'structure-changed';
  if (textDiff && textDiff.hasChanges) return 'text-changed';
  return 'unchanged';
}

// ─── Per-Page Analysis ──────────────────────────────────────────────────────

async function analyzePageDiff(browser, path) {
  const prodUrl = PROD_URL + path;
  const previewUrl = PREVIEW_URL + path;
  let page;

  try {
    page = await browser.newPage();

    // ── Production page ──
    const prodResponse = await navigateWithRetry(page, prodUrl);
    const prodStatus = prodResponse.status();

    if (prodStatus >= 400) {
      return {
        path, classification: 'error',
        error: `Production returned ${prodStatus}`,
        prodUrl, previewUrl,
        prodScreenshot: null, previewScreenshot: null, screenshotDiff: null,
        textDiff: null, structureDiff: null
      };
    }

    await scrollToBottom(page);
    const prodText = await extractPageContent(page);
    const prodStructure = await extractDOMStructure(page);
    const prodScreenshot = await captureScreenshot(page, path, 'prod');

    // ── Preview page ──
    const previewResponse = await navigateWithRetry(page, previewUrl);
    const previewStatus = previewResponse.status();

    if (previewStatus >= 400) {
      return {
        path, classification: 'error',
        error: `Preview returned ${previewStatus}`,
        prodUrl, previewUrl,
        prodScreenshot, previewScreenshot: null, screenshotDiff: null,
        textDiff: null, structureDiff: null
      };
    }

    await scrollToBottom(page);
    const previewText = await extractPageContent(page);
    const previewStructure = await extractDOMStructure(page);
    const previewScreenshot = await captureScreenshot(page, path, 'preview');

    // ── Compute diffs ──
    const textDiff = computeTextDiff(prodText, previewText);
    const structureDiff = computeStructureDiff(prodStructure, previewStructure);
    const classification = classifyPage(textDiff, structureDiff, null);

    // ── Screenshot diff ──
    let screenshotDiff = null;
    if (prodScreenshot && previewScreenshot) {
      screenshotDiff = generateScreenshotDiff(prodScreenshot, previewScreenshot, path);
    }

    const label = classification === 'unchanged' ? colors.green :
                  classification === 'text-changed' ? colors.yellow :
                  colors.red;
    const heightNote = screenshotDiff && screenshotDiff.heightDiff ? ` +${screenshotDiff.heightDiff}px height diff` : '';
    const diffPct = screenshotDiff ? ` (${screenshotDiff.diffPercent}% pixels differ${heightNote})` : '';
    console.log(`  ${label}${classification}${colors.reset} ${path}${diffPct}`);

    return {
      path, classification, error: null,
      prodUrl, previewUrl,
      prodScreenshot, previewScreenshot, screenshotDiff,
      textDiff, structureDiff
    };

  } catch (error) {
    console.log(`  ${colors.red}error${colors.reset} ${path}: ${error.message}`);
    return {
      path, classification: 'error',
      error: error.message,
      prodUrl, previewUrl,
      prodScreenshot: null, previewScreenshot: null, screenshotDiff: null,
      textDiff: null, structureDiff: null
    };
  } finally {
    if (page) {
      try { await page.close(); } catch (e) {}
    }

    completedCount++;
    if (completedCount % CONCURRENCY === 0 || completedCount === totalPages) {
      const pct = Math.round((completedCount / totalPages) * 100);
      const counts = getCounts();
      console.log(`\n${colors.cyan}Progress: ${completedCount}/${totalPages} (${pct}%) — ${counts.structureChanged} structure, ${counts.textChanged} text, ${counts.unchanged} unchanged, ${counts.error} error${colors.reset}\n`);
      writeLiveReport();
    }
  }
}

// ─── Batch Processing ───────────────────────────────────────────────────────

async function processBatch(browser, paths) {
  const promises = paths.map(path => analyzePageDiff(browser, path));
  const batchResults = await Promise.all(promises);
  results.push(...batchResults);
}

// ─── Count Helpers ──────────────────────────────────────────────────────────

function getCounts() {
  return {
    structureChanged: results.filter(r => r.classification === 'structure-changed').length,
    textChanged: results.filter(r => r.classification === 'text-changed').length,
    unchanged: results.filter(r => r.classification === 'unchanged').length,
    error: results.filter(r => r.classification === 'error').length,
    total: results.length
  };
}

// ─── Diff → HTML Rendering ──────────────────────────────────────────────────

function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Compact Diff (context-only, skip large unchanged blocks) ───────────────

function renderCompactDiffHTML(hunks) {
  if (!hunks || hunks.length === 0) return '<div class="diff-empty">No differences</div>';

  const CONTEXT_LINES = 3;
  let html = '<div class="diff-block">';

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    const escaped = escapeHTML(hunk.value);
    const lines = escaped.split('\n').filter(l => l.length > 0);

    if (hunk.type === 'context') {
      // For context, only show a few lines around changes
      const prevIsChange = i > 0 && hunks[i - 1].type !== 'context';
      const nextIsChange = i < hunks.length - 1 && hunks[i + 1].type !== 'context';

      if (lines.length <= CONTEXT_LINES * 2 + 1) {
        // Small context — show all
        for (const line of lines) {
          html += `<div class="diff-line diff-context">  ${line}</div>`;
        }
      } else {
        // Large context — show top/bottom only
        const showTop = prevIsChange ? CONTEXT_LINES : (i === 0 ? 0 : CONTEXT_LINES);
        const showBottom = nextIsChange ? CONTEXT_LINES : (i === hunks.length - 1 ? 0 : CONTEXT_LINES);

        for (let j = 0; j < showTop && j < lines.length; j++) {
          html += `<div class="diff-line diff-context">  ${lines[j]}</div>`;
        }
        const skipped = lines.length - showTop - showBottom;
        if (skipped > 0) {
          html += `<div class="diff-separator">... ${skipped} unchanged lines ...</div>`;
        }
        for (let j = Math.max(showTop, lines.length - showBottom); j < lines.length; j++) {
          html += `<div class="diff-line diff-context">  ${lines[j]}</div>`;
        }
      }
    } else if (hunk.type === 'add') {
      for (const line of lines) {
        html += `<div class="diff-line diff-add">+ ${line}</div>`;
      }
    } else if (hunk.type === 'remove') {
      for (const line of lines) {
        html += `<div class="diff-line diff-remove">- ${line}</div>`;
      }
    }
  }

  html += '</div>';
  return html;
}

// ─── JSON Data Output ───────────────────────────────────────────────────────

function writeDataJSON() {
  const counts = getCounts();
  const data = {
    metadata: {
      generated: new Date().toISOString(),
      productionUrl: PROD_URL,
      previewUrl: PREVIEW_URL,
      filter: FILTER,
      summary: counts
    },
    pages: results.map(r => ({
      path: r.path,
      classification: r.classification,
      error: r.error,
      prodUrl: r.prodUrl,
      previewUrl: r.previewUrl,
      prodScreenshot: r.prodScreenshot ? `${SCREENSHOTS_DIR}/${r.prodScreenshot}` : null,
      previewScreenshot: r.previewScreenshot ? `${SCREENSHOTS_DIR}/${r.previewScreenshot}` : null,
      screenshotDiff: r.screenshotDiff ? { filename: `${SCREENSHOTS_DIR}/${r.screenshotDiff.filename}`, diffPercent: r.screenshotDiff.diffPercent, mismatchedPixels: r.screenshotDiff.mismatchedPixels } : null,
      textDiff: r.textDiff ? { hasChanges: r.textDiff.hasChanges, added: r.textDiff.added, removed: r.textDiff.removed } : null,
      structureDiff: r.structureDiff ? { hasChanges: r.structureDiff.hasChanges, added: r.structureDiff.added, removed: r.structureDiff.removed } : null
    }))
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── HTML Report ────────────────────────────────────────────────────────────

function generateReportHTML(isLive = false) {
  const counts = getCounts();

  // Sort: structure-changed first, then text-changed, then error, then unchanged
  const sortOrder = { 'structure-changed': 0, 'text-changed': 1, 'error': 2, 'unchanged': 3 };
  const sorted = [...results].sort((a, b) => (sortOrder[a.classification] ?? 4) - (sortOrder[b.classification] ?? 4));

  const pageCards = sorted.map((r, idx) => {
    const badge = {
      'structure-changed': '<span class="badge badge-structure">Structure Changed</span>',
      'text-changed': '<span class="badge badge-text">Text Changed</span>',
      'unchanged': '<span class="badge badge-unchanged">Unchanged</span>',
      'error': '<span class="badge badge-error">Error</span>'
    }[r.classification] || '';

    const diffStats = [];
    if (r.textDiff && r.textDiff.hasChanges) {
      diffStats.push(`<span class="stat-add">+${r.textDiff.added}</span> <span class="stat-remove">-${r.textDiff.removed}</span> text lines`);
    }
    if (r.structureDiff && r.structureDiff.hasChanges) {
      diffStats.push(`<span class="stat-add">+${r.structureDiff.added}</span> <span class="stat-remove">-${r.structureDiff.removed}</span> structure lines`);
    }

    const textDiffHTML = r.textDiff && r.textDiff.hasChanges
      ? renderCompactDiffHTML(r.textDiff.hunks) : '<div class="diff-empty">No text differences</div>';

    const structDiffHTML = r.structureDiff && r.structureDiff.hasChanges
      ? renderCompactDiffHTML(r.structureDiff.hunks) : '<div class="diff-empty">No structure differences</div>';

    const hasScreenshots = r.prodScreenshot || r.previewScreenshot;

    if (r.screenshotDiff) {
      const heightNote = r.screenshotDiff.heightDiff ? ` <span class="stat-dim">(+${r.screenshotDiff.heightDiff}px height)</span>` : '';
      diffStats.push(`<span class="stat-remove">${r.screenshotDiff.diffPercent}%</span> pixels differ${heightNote}`);
    }

    return `
    <div class="card classification-${r.classification}" data-classification="${r.classification}">
      <div class="card-header" onclick="toggleCard(${idx})">
        <div class="card-title">
          ${badge}
          <code class="card-path">${escapeHTML(r.path)}</code>
          ${diffStats.length > 0 ? `<span class="diff-stats">${diffStats.join(' | ')}</span>` : ''}
        </div>
        <span class="card-toggle" id="toggle-${idx}">&#9654;</span>
      </div>
      <div class="card-body" id="card-body-${idx}" style="display:none">
        ${r.error ? `<div class="error-message">${escapeHTML(r.error)}</div>` : ''}
        <div class="card-links">
          <a href="${escapeHTML(r.prodUrl)}" target="_blank">Production</a>
          <a href="${escapeHTML(r.previewUrl)}" target="_blank">Preview</a>
        </div>
        <div class="tabs">
          <button class="tab active" onclick="switchTab(${idx}, 'text')">Text Diff</button>
          <button class="tab" onclick="switchTab(${idx}, 'structure')">Structure Diff</button>
          ${hasScreenshots ? `<button class="tab" onclick="switchTab(${idx}, 'screenshots')">Screenshots</button>` : ''}
        </div>
        <div class="tab-content" id="tab-text-${idx}">${textDiffHTML}</div>
        <div class="tab-content" id="tab-structure-${idx}" style="display:none">${structDiffHTML}</div>
        ${hasScreenshots ? `
        <div class="tab-content" id="tab-screenshots-${idx}" style="display:none">
          <div class="screenshots-grid-3">
            ${r.prodScreenshot ? `
            <div class="screenshot-col">
              <h4>Production</h4>
              <img src="${SCREENSHOTS_DIR}/${r.prodScreenshot}" loading="lazy" alt="Production screenshot">
            </div>` : ''}
            ${r.previewScreenshot ? `
            <div class="screenshot-col">
              <h4>Preview</h4>
              <img src="${SCREENSHOTS_DIR}/${r.previewScreenshot}" loading="lazy" alt="Preview screenshot">
            </div>` : ''}
            ${r.screenshotDiff ? `
            <div class="screenshot-col screenshot-diff-col">
              <h4>Diff (${r.screenshotDiff.diffPercent}% changed)</h4>
              <img src="${SCREENSHOTS_DIR}/${r.screenshotDiff.filename}" loading="lazy" alt="Screenshot diff">
            </div>` : ''}
          </div>
        </div>` : ''}
      </div>
    </div>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  ${isLive ? '<meta http-equiv="refresh" content="5">' : ''}
  <title>${isLive ? '[LIVE] ' : ''}Upgrade Diff Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      padding: 20px;
    }
    a { color: #58a6ff; }

    /* Dashboard */
    .dashboard {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 20px;
    }
    .dashboard h1 {
      font-size: 22px;
      color: #f0f6fc;
      margin-bottom: 8px;
    }
    .dashboard .meta {
      font-size: 13px;
      color: #8b949e;
      margin-bottom: 16px;
    }
    .dashboard .meta code {
      background: #21262d;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 12px;
    }
    .summary-stats {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .summary-stat {
      padding: 10px 18px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      transition: opacity 0.2s;
      user-select: none;
    }
    .summary-stat:hover { opacity: 0.85; }
    .summary-stat.active { outline: 2px solid #f0f6fc; outline-offset: 2px; }
    .ss-structure { background: #f8514926; color: #f85149; border: 1px solid #f8514933; }
    .ss-text { background: #d2992226; color: #d29922; border: 1px solid #d2992233; }
    .ss-unchanged { background: #3fb95026; color: #3fb950; border: 1px solid #3fb95033; }
    .ss-error { background: #ff7b7226; color: #ff7b72; border: 1px solid #ff7b7233; }

    ${isLive ? `
    .live-indicator {
      display: inline-block;
      background: #3fb950;
      color: #0d1117;
      padding: 3px 10px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 700;
      animation: pulse 2s infinite;
      margin-left: 10px;
      vertical-align: middle;
    }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
    ` : ''}

    /* Cards */
    .cards { display: flex; flex-direction: column; gap: 8px; }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      overflow: hidden;
    }
    .card.classification-structure-changed { border-left: 3px solid #f85149; }
    .card.classification-text-changed { border-left: 3px solid #d29922; }
    .card.classification-unchanged { border-left: 3px solid #3fb950; }
    .card.classification-error { border-left: 3px solid #ff7b72; }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .card-header:hover { background: #1c2128; }
    .card-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .card-path { font-size: 13px; color: #c9d1d9; background: none; }
    .card-toggle { color: #8b949e; font-size: 12px; transition: transform 0.2s; }
    .card-toggle.open { transform: rotate(90deg); }

    /* Badges */
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-structure { background: #f8514926; color: #f85149; }
    .badge-text { background: #d2992226; color: #d29922; }
    .badge-unchanged { background: #3fb95026; color: #3fb950; }
    .badge-error { background: #ff7b7226; color: #ff7b72; }

    .diff-stats {
      font-size: 11px;
      color: #8b949e;
    }
    .stat-add { color: #3fb950; }
    .stat-remove { color: #f85149; }

    .card-body { padding: 0 16px 16px; }
    .card-links {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .card-links a {
      padding: 4px 10px;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 4px;
      font-size: 12px;
      text-decoration: none;
    }
    .card-links a:hover { background: #30363d; }

    .error-message {
      background: #f8514915;
      color: #f85149;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 13px;
      margin-bottom: 12px;
      border: 1px solid #f8514933;
    }

    /* Tabs */
    .tabs {
      display: flex;
      gap: 0;
      border-bottom: 1px solid #30363d;
      margin-bottom: 12px;
    }
    .tab {
      padding: 8px 16px;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: #8b949e;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .tab:hover { color: #c9d1d9; }
    .tab.active {
      color: #f0f6fc;
      border-bottom-color: #58a6ff;
    }

    /* Diffs */
    .diff-block {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 4px;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 12px;
      line-height: 1.6;
      overflow-x: auto;
      max-height: 500px;
      overflow-y: auto;
    }
    .diff-line {
      padding: 0 12px;
      white-space: pre-wrap;
      word-break: break-all;
    }
    .diff-add {
      background: #12261e;
      color: #3fb950;
    }
    .diff-remove {
      background: #2a1215;
      color: #f85149;
    }
    .diff-context {
      color: #8b949e;
    }
    .diff-separator {
      padding: 4px 12px;
      background: #161b22;
      color: #484f58;
      font-style: italic;
      text-align: center;
      border-top: 1px solid #21262d;
      border-bottom: 1px solid #21262d;
    }
    .diff-empty {
      padding: 20px;
      text-align: center;
      color: #484f58;
      font-style: italic;
    }

    /* Screenshots */
    .screenshots-grid-3 {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 12px;
    }
    .screenshot-col {
      border: 1px solid #30363d;
      border-radius: 4px;
      overflow: hidden;
    }
    .screenshot-col h4 {
      background: #21262d;
      padding: 6px 10px;
      font-size: 12px;
      color: #8b949e;
      border-bottom: 1px solid #30363d;
    }
    .screenshot-col img {
      width: 100%;
      display: block;
    }
    .screenshot-diff-col {
      border-color: #f85149;
    }
    .screenshot-diff-col h4 {
      background: #2a1215;
      color: #f85149;
    }

    /* Filter controls */
    .filter-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .filter-bar label {
      font-size: 13px;
      color: #8b949e;
    }
    .filter-bar input {
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 4px;
      padding: 6px 10px;
      color: #c9d1d9;
      font-size: 13px;
      width: 250px;
    }
    .filter-bar input::placeholder { color: #484f58; }
    .expand-all-btn {
      padding: 5px 12px;
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 4px;
      color: #c9d1d9;
      font-size: 12px;
      cursor: pointer;
    }
    .expand-all-btn:hover { background: #30363d; }
  </style>
</head>
<body>
  <div class="dashboard">
    <h1>Upgrade Diff Report${isLive ? '<span class="live-indicator">LIVE</span>' : ''}</h1>
    <div class="meta">
      <div>Generated: ${new Date().toLocaleString()}</div>
      <div>Production: <code>${escapeHTML(PROD_URL)}</code></div>
      <div>Preview: <code>${escapeHTML(PREVIEW_URL)}</code></div>
      ${FILTER ? `<div>Filter: <code>${escapeHTML(FILTER)}</code></div>` : ''}
      <div>Pages analyzed: <strong>${results.length}</strong>${isLive ? ` / ${totalPages}` : ''}</div>
    </div>
    <div class="summary-stats">
      <div class="summary-stat ss-structure" onclick="filterCards('structure-changed')">${counts.structureChanged} Structure Changed</div>
      <div class="summary-stat ss-text" onclick="filterCards('text-changed')">${counts.textChanged} Text Changed</div>
      <div class="summary-stat ss-unchanged" onclick="filterCards('unchanged')">${counts.unchanged} Unchanged</div>
      <div class="summary-stat ss-error" onclick="filterCards('error')">${counts.error} Errors</div>
    </div>
  </div>

  <div class="filter-bar">
    <label>Search:</label>
    <input type="text" id="search-input" placeholder="Filter by path..." oninput="applySearch()">
    <button class="expand-all-btn" onclick="expandChanged()">Expand Changed</button>
    <button class="expand-all-btn" onclick="collapseAll()">Collapse All</button>
  </div>

  <div class="cards" id="cards-container">
    ${pageCards}
  </div>

  <script>
    let activeFilter = null;

    function toggleCard(idx) {
      const body = document.getElementById('card-body-' + idx);
      const toggle = document.getElementById('toggle-' + idx);
      const isOpen = body.style.display !== 'none';
      body.style.display = isOpen ? 'none' : 'block';
      toggle.classList.toggle('open', !isOpen);
    }

    function switchTab(idx, tabName) {
      const tabs = ['text', 'structure', 'screenshots'];
      for (const t of tabs) {
        const el = document.getElementById('tab-' + t + '-' + idx);
        if (el) el.style.display = t === tabName ? 'block' : 'none';
      }
      const card = document.getElementById('card-body-' + idx);
      card.querySelectorAll('.tab').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.toLowerCase().includes(tabName));
      });
    }

    function filterCards(classification) {
      const stats = document.querySelectorAll('.summary-stat');
      if (activeFilter === classification) {
        activeFilter = null;
        stats.forEach(s => s.classList.remove('active'));
      } else {
        activeFilter = classification;
        stats.forEach(s => s.classList.remove('active'));
        event.target.classList.add('active');
      }
      applySearch();
    }

    function applySearch() {
      const query = document.getElementById('search-input').value.toLowerCase();
      document.querySelectorAll('.card').forEach(card => {
        const path = card.querySelector('.card-path').textContent.toLowerCase();
        const cls = card.dataset.classification;
        const matchesFilter = !activeFilter || cls === activeFilter;
        const matchesSearch = !query || path.includes(query);
        card.style.display = (matchesFilter && matchesSearch) ? 'block' : 'none';
      });
    }

    function expandChanged() {
      document.querySelectorAll('.card').forEach((card, idx) => {
        const cls = card.dataset.classification;
        if (cls === 'structure-changed' || cls === 'text-changed') {
          const body = document.getElementById('card-body-' + idx);
          const toggle = document.getElementById('toggle-' + idx);
          if (body) { body.style.display = 'block'; }
          if (toggle) { toggle.classList.add('open'); }
        }
      });
    }

    function collapseAll() {
      document.querySelectorAll('.card').forEach((card, idx) => {
        const body = document.getElementById('card-body-' + idx);
        const toggle = document.getElementById('toggle-' + idx);
        if (body) { body.style.display = 'none'; }
        if (toggle) { toggle.classList.remove('open'); }
      });
    }
  </script>
</body>
</html>`;
}

function writeLiveReport() {
  fs.writeFileSync(LIVE_REPORT, generateReportHTML(true));
}

function writeFinalReport() {
  const filename = `upgrade-diff-report-${TIMESTAMP}.html`;
  fs.writeFileSync(filename, generateReportHTML(false));
  return filename;
}

// ─── Self-contained shareable report ────────────────────────────────────────

function embedImage(filepath) {
  try {
    const data = fs.readFileSync(filepath);

    // If PNG, re-encode as lower-res JPEG-like quality by quantizing
    // For shareable reports, downscale to max 600px wide
    if (filepath.endsWith('.png')) {
      const png = PNG.sync.read(data);
      const maxWidth = 600;
      if (png.width > maxWidth) {
        const scale = maxWidth / png.width;
        const newW = maxWidth;
        const newH = Math.round(png.height * scale);
        const resized = new PNG({ width: newW, height: newH });

        // Nearest-neighbor downscale
        for (let y = 0; y < newH; y++) {
          for (let x = 0; x < newW; x++) {
            const srcX = Math.floor(x / scale);
            const srcY = Math.floor(y / scale);
            const srcIdx = (srcY * png.width + srcX) * 4;
            const dstIdx = (y * newW + x) * 4;
            resized.data[dstIdx] = png.data[srcIdx];
            resized.data[dstIdx + 1] = png.data[srcIdx + 1];
            resized.data[dstIdx + 2] = png.data[srcIdx + 2];
            resized.data[dstIdx + 3] = png.data[srcIdx + 3];
          }
        }
        const smallPng = PNG.sync.write(resized);
        return `data:image/png;base64,${smallPng.toString('base64')}`;
      }
    }

    const ext = filepath.endsWith('.png') ? 'png' : 'jpeg';
    return `data:image/${ext};base64,${data.toString('base64')}`;
  } catch (e) {
    return '';
  }
}

function generateShareableReport() {
  // Only embed diff images for pages with meaningful visual changes (>threshold% pixel diff)
  const embedCandidates = results.filter(r =>
    r.classification !== 'unchanged' &&
    r.screenshotDiff &&
    parseFloat(r.screenshotDiff.diffPercent) >= DIFF_THRESHOLD
  );

  console.log(`Embedding diff images for ${embedCandidates.length} pages with >${DIFF_THRESHOLD}% pixel diff...`);

  // Only embed the diff overlay image (not prod/preview — those are just links)
  const originals = new Map();
  for (const r of embedCandidates) {
    originals.set(r, { _diffDataUri: r._diffDataUri });
    if (r.screenshotDiff) {
      r._diffDataUri = embedImage(`${SCREENSHOTS_DIR}/${r.screenshotDiff.filename}`);
    }
  }

  // Generate report
  const html = generateShareableHTML();

  // Restore
  for (const [r, orig] of originals) {
    r._diffDataUri = orig._diffDataUri;
  }

  const filename = `upgrade-diff-share-${TIMESTAMP}.html`;
  fs.writeFileSync(filename, html);
  return filename;
}

function generateShareableHTML() {
  // Same as generateReportHTML but uses data URIs for images
  const counts = getCounts();
  const sortOrder = { 'structure-changed': 0, 'text-changed': 1, 'error': 2, 'unchanged': 3 };
  const sorted = [...results].sort((a, b) => (sortOrder[a.classification] ?? 4) - (sortOrder[b.classification] ?? 4));

  const pageCards = sorted.map((r, idx) => {
    const badge = {
      'structure-changed': '<span class="badge badge-structure">Structure Changed</span>',
      'text-changed': '<span class="badge badge-text">Text Changed</span>',
      'unchanged': '<span class="badge badge-unchanged">Unchanged</span>',
      'error': '<span class="badge badge-error">Error</span>'
    }[r.classification] || '';

    const diffStats = [];
    if (r.textDiff && r.textDiff.hasChanges) {
      diffStats.push(`<span class="stat-add">+${r.textDiff.added}</span> <span class="stat-remove">-${r.textDiff.removed}</span> text lines`);
    }
    if (r.structureDiff && r.structureDiff.hasChanges) {
      diffStats.push(`<span class="stat-add">+${r.structureDiff.added}</span> <span class="stat-remove">-${r.structureDiff.removed}</span> structure lines`);
    }
    if (r.screenshotDiff) {
      const heightNote = r.screenshotDiff.heightDiff ? ` <span class="stat-dim">(+${r.screenshotDiff.heightDiff}px height)</span>` : '';
      diffStats.push(`<span class="stat-remove">${r.screenshotDiff.diffPercent}%</span> pixels differ${heightNote}`);
    }

    const textDiffHTML = r.textDiff && r.textDiff.hasChanges
      ? renderCompactDiffHTML(r.textDiff.hunks) : '<div class="diff-empty">No text differences</div>';
    const structDiffHTML = r.structureDiff && r.structureDiff.hasChanges
      ? renderCompactDiffHTML(r.structureDiff.hunks) : '<div class="diff-empty">No structure differences</div>';

    const diffSrc = r._diffDataUri || '';
    const hasDiffImage = !!diffSrc;

    return `
    <div class="card classification-${r.classification}" data-classification="${r.classification}">
      <div class="card-header" onclick="toggleCard(${idx})">
        <div class="card-title">
          ${badge}
          <code class="card-path">${escapeHTML(r.path)}</code>
          ${diffStats.length > 0 ? `<span class="diff-stats">${diffStats.join(' | ')}</span>` : ''}
        </div>
        <span class="card-toggle" id="toggle-${idx}">&#9654;</span>
      </div>
      <div class="card-body" id="card-body-${idx}" style="display:none">
        ${r.error ? `<div class="error-message">${escapeHTML(r.error)}</div>` : ''}
        <div class="card-links">
          <a href="${escapeHTML(r.prodUrl)}" target="_blank">Open Production</a>
          <a href="${escapeHTML(r.previewUrl)}" target="_blank">Open Preview</a>
        </div>
        <div class="tabs">
          <button class="tab active" onclick="switchTab(${idx}, 'text')">Text Diff</button>
          <button class="tab" onclick="switchTab(${idx}, 'structure')">Structure Diff</button>
          ${hasDiffImage ? `<button class="tab" onclick="switchTab(${idx}, 'screenshots')">Visual Diff</button>` : ''}
        </div>
        <div class="tab-content" id="tab-text-${idx}">${textDiffHTML}</div>
        <div class="tab-content" id="tab-structure-${idx}" style="display:none">${structDiffHTML}</div>
        ${hasDiffImage ? `
        <div class="tab-content" id="tab-screenshots-${idx}" style="display:none">
          <div class="screenshot-col screenshot-diff-col" style="max-width:800px">
            <h4>Pixel Diff — ${r.screenshotDiff ? r.screenshotDiff.diffPercent : '?'}% changed (red = different)</h4>
            <img src="${diffSrc}" loading="lazy" alt="Screenshot diff">
          </div>
          <p style="margin-top:8px;font-size:12px;color:#8b949e;">Open the Production and Preview links above to compare side-by-side in your browser.</p>
        </div>` : ''}
      </div>
    </div>`;
  }).join('\n');

  // Reuse the same CSS/JS from generateReportHTML but as a standalone string
  return generateReportShell(counts, pageCards);
}

function generateReportShell(counts, pageCards) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Upgrade Diff Report (Shareable)</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    a { color: #58a6ff; }
    .dashboard { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; margin-bottom: 20px; }
    .dashboard h1 { font-size: 22px; color: #f0f6fc; margin-bottom: 8px; }
    .dashboard .meta { font-size: 13px; color: #8b949e; margin-bottom: 16px; }
    .dashboard .meta code { background: #21262d; padding: 2px 6px; border-radius: 3px; font-size: 12px; }
    .summary-stats { display: flex; gap: 12px; flex-wrap: wrap; }
    .summary-stat { padding: 10px 18px; border-radius: 6px; font-weight: 600; font-size: 14px; cursor: pointer; transition: opacity 0.2s; user-select: none; }
    .summary-stat:hover { opacity: 0.85; }
    .summary-stat.active { outline: 2px solid #f0f6fc; outline-offset: 2px; }
    .ss-structure { background: #f8514926; color: #f85149; border: 1px solid #f8514933; }
    .ss-text { background: #d2992226; color: #d29922; border: 1px solid #d2992233; }
    .ss-unchanged { background: #3fb95026; color: #3fb950; border: 1px solid #3fb95033; }
    .ss-error { background: #ff7b7226; color: #ff7b72; border: 1px solid #ff7b7233; }
    .cards { display: flex; flex-direction: column; gap: 8px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; overflow: hidden; }
    .card.classification-structure-changed { border-left: 3px solid #f85149; }
    .card.classification-text-changed { border-left: 3px solid #d29922; }
    .card.classification-unchanged { border-left: 3px solid #3fb950; }
    .card.classification-error { border-left: 3px solid #ff7b72; }
    .card-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; cursor: pointer; transition: background 0.15s; }
    .card-header:hover { background: #1c2128; }
    .card-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .card-path { font-size: 13px; color: #c9d1d9; background: none; }
    .card-toggle { color: #8b949e; font-size: 12px; transition: transform 0.2s; }
    .card-toggle.open { transform: rotate(90deg); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge-structure { background: #f8514926; color: #f85149; }
    .badge-text { background: #d2992226; color: #d29922; }
    .badge-unchanged { background: #3fb95026; color: #3fb950; }
    .badge-error { background: #ff7b7226; color: #ff7b72; }
    .diff-stats { font-size: 11px; color: #8b949e; }
    .stat-add { color: #3fb950; }
    .stat-remove { color: #f85149; }
    .card-body { padding: 0 16px 16px; }
    .card-links { display: flex; gap: 8px; margin-bottom: 12px; }
    .card-links a { padding: 4px 10px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; font-size: 12px; text-decoration: none; }
    .card-links a:hover { background: #30363d; }
    .error-message { background: #f8514915; color: #f85149; padding: 8px 12px; border-radius: 4px; font-size: 13px; margin-bottom: 12px; border: 1px solid #f8514933; }
    .tabs { display: flex; gap: 0; border-bottom: 1px solid #30363d; margin-bottom: 12px; }
    .tab { padding: 8px 16px; background: none; border: none; border-bottom: 2px solid transparent; color: #8b949e; font-size: 13px; cursor: pointer; transition: all 0.15s; }
    .tab:hover { color: #c9d1d9; }
    .tab.active { color: #f0f6fc; border-bottom-color: #58a6ff; }
    .diff-block { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; line-height: 1.6; overflow-x: auto; max-height: 500px; overflow-y: auto; }
    .diff-line { padding: 0 12px; white-space: pre-wrap; word-break: break-all; }
    .diff-add { background: #12261e; color: #3fb950; }
    .diff-remove { background: #2a1215; color: #f85149; }
    .diff-context { color: #8b949e; }
    .diff-separator { padding: 4px 12px; background: #161b22; color: #484f58; font-style: italic; text-align: center; border-top: 1px solid #21262d; border-bottom: 1px solid #21262d; }
    .diff-empty { padding: 20px; text-align: center; color: #484f58; font-style: italic; }
    .screenshots-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    .screenshot-col { border: 1px solid #30363d; border-radius: 4px; overflow: hidden; }
    .screenshot-col h4 { background: #21262d; padding: 6px 10px; font-size: 12px; color: #8b949e; border-bottom: 1px solid #30363d; }
    .screenshot-col img { width: 100%; display: block; }
    .screenshot-diff-col { border-color: #f85149; }
    .screenshot-diff-col h4 { background: #2a1215; color: #f85149; }
    .filter-bar { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
    .filter-bar label { font-size: 13px; color: #8b949e; }
    .filter-bar input { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 6px 10px; color: #c9d1d9; font-size: 13px; width: 250px; }
    .filter-bar input::placeholder { color: #484f58; }
    .expand-all-btn { padding: 5px 12px; background: #21262d; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 12px; cursor: pointer; }
    .expand-all-btn:hover { background: #30363d; }
    .share-note { background: #d2992215; border: 1px solid #d2992233; color: #d29922; padding: 10px 16px; border-radius: 6px; font-size: 13px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="dashboard">
    <h1>Upgrade Diff Report</h1>
    <div class="meta">
      <div>Generated: ${new Date().toLocaleString()}</div>
      <div>Production: <code>${escapeHTML(PROD_URL)}</code></div>
      <div>Preview: <code>${escapeHTML(PREVIEW_URL)}</code></div>
      ${FILTER ? `<div>Filter: <code>${escapeHTML(FILTER)}</code></div>` : ''}
      <div>Pages analyzed: <strong>${results.length}</strong></div>
    </div>
    <div class="summary-stats">
      <div class="summary-stat ss-structure" onclick="filterCards('structure-changed')">${counts.structureChanged} Structure Changed</div>
      <div class="summary-stat ss-text" onclick="filterCards('text-changed')">${counts.textChanged} Text Changed</div>
      <div class="summary-stat ss-unchanged" onclick="filterCards('unchanged')">${counts.unchanged} Unchanged</div>
      <div class="summary-stat ss-error" onclick="filterCards('error')">${counts.error} Errors</div>
    </div>
  </div>
  <div class="share-note">Self-contained report — screenshots embedded for changed pages only. Unchanged pages have diffs but no screenshots.</div>
  <div class="filter-bar">
    <label>Search:</label>
    <input type="text" id="search-input" placeholder="Filter by path..." oninput="applySearch()">
    <button class="expand-all-btn" onclick="expandChanged()">Expand Changed</button>
    <button class="expand-all-btn" onclick="collapseAll()">Collapse All</button>
  </div>
  <div class="cards" id="cards-container">
    ${pageCards}
  </div>
  <script>
    let activeFilter = null;
    function toggleCard(idx) {
      const body = document.getElementById('card-body-' + idx);
      const toggle = document.getElementById('toggle-' + idx);
      const isOpen = body.style.display !== 'none';
      body.style.display = isOpen ? 'none' : 'block';
      toggle.classList.toggle('open', !isOpen);
    }
    function switchTab(idx, tabName) {
      const tabs = ['text', 'structure', 'screenshots'];
      for (const t of tabs) {
        const el = document.getElementById('tab-' + t + '-' + idx);
        if (el) el.style.display = t === tabName ? 'block' : 'none';
      }
      const card = document.getElementById('card-body-' + idx);
      card.querySelectorAll('.tab').forEach(btn => {
        btn.classList.toggle('active', btn.textContent.toLowerCase().includes(tabName));
      });
    }
    function filterCards(classification) {
      const stats = document.querySelectorAll('.summary-stat');
      if (activeFilter === classification) { activeFilter = null; stats.forEach(s => s.classList.remove('active')); }
      else { activeFilter = classification; stats.forEach(s => s.classList.remove('active')); event.target.classList.add('active'); }
      applySearch();
    }
    function applySearch() {
      const query = document.getElementById('search-input').value.toLowerCase();
      document.querySelectorAll('.card').forEach(card => {
        const path = card.querySelector('.card-path').textContent.toLowerCase();
        const cls = card.dataset.classification;
        const matchesFilter = !activeFilter || cls === activeFilter;
        const matchesSearch = !query || path.includes(query);
        card.style.display = (matchesFilter && matchesSearch) ? 'block' : 'none';
      });
    }
    function expandChanged() {
      document.querySelectorAll('.card').forEach((card, idx) => {
        const cls = card.dataset.classification;
        if (cls === 'structure-changed' || cls === 'text-changed') {
          const body = document.getElementById('card-body-' + idx);
          const toggle = document.getElementById('toggle-' + idx);
          if (body) body.style.display = 'block';
          if (toggle) toggle.classList.add('open');
        }
      });
    }
    function collapseAll() {
      document.querySelectorAll('.card').forEach((card, idx) => {
        const body = document.getElementById('card-body-' + idx);
        const toggle = document.getElementById('toggle-' + idx);
        if (body) body.style.display = 'none';
        if (toggle) toggle.classList.remove('open');
      });
    }
  </script>
</body>
</html>`;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('Upgrade Diff Tool\n');
  console.log(`Production:  ${PROD_URL}`);
  console.log(`Preview:     ${PREVIEW_URL}`);
  console.log(`Filter:      ${FILTER || '(none)'}`);
  console.log(`Explorer:    ${EXPLORER !== null ? (EXPLORER || 'all filtered pages') : 'no'}`);
  console.log(`Concurrency: ${CONCURRENCY}\n`);

  try {
    // Fetch sitemap from production site
    let paths = await fetchSitemap(PROD_URL);

    // Apply filter
    if (FILTER) {
      const before = paths.length;
      paths = paths.filter(p => p.startsWith(FILTER));
      console.log(`Filter ${FILTER}: ${paths.length} of ${before} pages match\n`);
    }

    // Add ?explorer variants for API reference pages
    if (EXPLORER !== null) {
      const explorerPattern = EXPLORER; // e.g. "/reference" or "" for all
      const matchingPaths = explorerPattern
        ? paths.filter(p => p.includes(explorerPattern))
        : paths;
      const explorerPaths = matchingPaths.map(p => {
        const sep = p.includes('?') ? '&' : '?';
        return p + sep + 'explorer';
      });
      console.log(`Explorer mode: adding ${explorerPaths.length} ?explorer variants${explorerPattern ? ` (matching "${explorerPattern}")` : ''} (${paths.length + explorerPaths.length} total)\n`);
      paths = [...paths, ...explorerPaths];
    }

    if (paths.length === 0) {
      console.log(`${colors.red}No pages to analyze.${colors.reset}`);
      process.exit(1);
    }

    totalPages = paths.length;

    // Launch browser
    console.log('Launching browser...\n');
    const browser = await puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1280, height: 800 }
    });

    // Create initial live report
    writeLiveReport();
    console.log(`${colors.green}Live report: ${LIVE_REPORT}${colors.reset}`);
    console.log('Open it in a browser to see results as they come in.\n');

    console.log(`Analyzing ${paths.length} pages...\n`);

    // Process in batches
    for (let i = 0; i < paths.length; i += CONCURRENCY) {
      const batch = paths.slice(i, i + CONCURRENCY);
      await processBatch(browser, batch);
    }

    await browser.close();

    // Output
    const counts = getCounts();
    console.log('\n' + '='.repeat(60));
    console.log('Analysis Complete!\n');
    console.log(`  ${colors.red}Structure Changed: ${counts.structureChanged}${colors.reset}`);
    console.log(`  ${colors.yellow}Text Changed:      ${counts.textChanged}${colors.reset}`);
    console.log(`  ${colors.green}Unchanged:         ${counts.unchanged}${colors.reset}`);
    console.log(`  ${colors.red}Errors:            ${counts.error}${colors.reset}`);
    console.log('='.repeat(60) + '\n');

    const reportFile = writeFinalReport();
    writeDataJSON();

    // Remove live report
    try { fs.unlinkSync(LIVE_REPORT); } catch (e) {}

    console.log(`${colors.green}Report: ${reportFile}${colors.reset}`);
    console.log(`${colors.green}Data:   ${DATA_FILE}${colors.reset}`);
    console.log(`${colors.green}Screenshots: ${SCREENSHOTS_DIR}/${colors.reset}`);

    // Generate shareable self-contained report
    const shareFile = generateShareableReport();
    console.log(`${colors.green}Share:  ${shareFile} (self-contained, send this file)${colors.reset}`);

    // CI mode: write summary JSON for GitHub Actions consumption
    if (CI_MODE) {
      const ciSummary = {
        counts,
        reportFile,
        shareFile,
        dataFile: DATA_FILE,
        changedPages: results
          .filter(r => r.classification !== 'unchanged')
          .map(r => ({
            path: r.path,
            classification: r.classification,
            diffPercent: r.screenshotDiff ? r.screenshotDiff.diffPercent : null
          }))
      };
      const ciFile = 'upgrade-diff-ci-summary.json';
      fs.writeFileSync(ciFile, JSON.stringify(ciSummary, null, 2));
      console.log(`${colors.green}CI Summary: ${ciFile}${colors.reset}`);
    }

    // Try to open report (skip in CI)
    if (!CI_MODE) {
      try {
        const { exec } = require('child_process');
        exec(`open "${reportFile}"`);
      } catch (e) {}
    }

  } catch (error) {
    console.error(`${colors.red}ERROR: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

// ─── Share mode: regenerate shareable report from existing data ──────────────

if (flags.share) {
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`${colors.red}No ${DATA_FILE} found. Run the analysis first.${colors.reset}`);
    process.exit(1);
  }

  console.log('Generating shareable report from existing data...\n');
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

  // Restore URLs from saved data
  PROD_URL = PROD_URL || data.metadata.productionUrl;
  PREVIEW_URL = PREVIEW_URL || data.metadata.previewUrl;

  // Rehydrate results from JSON + screenshots on disk
  for (const page of data.pages) {
    const r = {
      path: page.path,
      classification: page.classification,
      error: page.error,
      prodUrl: page.prodUrl,
      previewUrl: page.previewUrl,
      prodScreenshot: page.prodScreenshot ? page.prodScreenshot.replace(`${SCREENSHOTS_DIR}/`, '') : null,
      previewScreenshot: page.previewScreenshot ? page.previewScreenshot.replace(`${SCREENSHOTS_DIR}/`, '') : null,
      screenshotDiff: page.screenshotDiff ? {
        filename: page.screenshotDiff.filename.replace(`${SCREENSHOTS_DIR}/`, ''),
        diffPercent: page.screenshotDiff.diffPercent,
        mismatchedPixels: page.screenshotDiff.mismatchedPixels
      } : null,
      textDiff: page.textDiff,
      structureDiff: page.structureDiff
    };
    results.push(r);
  }

  const shareFile = generateShareableReport();
  console.log(`${colors.green}Share: ${shareFile} (self-contained, send this file)${colors.reset}`);

  const sizeMB = (fs.statSync(shareFile).size / 1024 / 1024).toFixed(1);
  console.log(`${colors.green}Size:  ${sizeMB} MB${colors.reset}`);
} else {
  main();
}

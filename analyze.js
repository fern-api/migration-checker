const puppeteer = require('puppeteer');
const fs = require('fs');
const xml2js = require('xml2js');
const readline = require('readline');

// Configuration
const OLD_SITE = process.argv[2] || 'https://docs.merge.dev';
const NEW_SITE = process.argv[3] || 'https://merge.ferndocs.com';
const SITEMAP_URL = process.argv[4]; // Optional: user can specify sitemap URL
const CUSTOM_SELECTORS = process.argv[5] || 'h1,h2,h3'; // Custom heading selectors
const CONCURRENCY = 25; // Number of pages to analyze in parallel
const CACHE_FILE = 'migration-cache.json';
const FULL_SCAN = process.argv.includes('--full'); // Force full rescan

const results = {
  critical: [],
  warnings: [],
  pass: [],
  timestamp: new Date().toISOString()
};

// Live report file for streaming results
const LIVE_REPORT = 'migration-report-live.html';

// Load cache of previously passed pages
function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      return new Set(data.passed || []);
    }
  } catch (e) {}
  return new Set();
}

// Save cache of passed pages
function saveCache() {
  const passed = results.pass.map(p => p.path);
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ passed, timestamp: new Date().toISOString() }, null, 2));
  console.log(`${colors.green}Cache saved: ${passed.length} passed pages${colors.reset}`);
}

// Generate LLM-friendly JSON output
function generateLLMOutput() {
  // Process warnings - screenshots are already saved as filenames
  const warnings = results.warnings.map(item => ({
    path: item.path,
    issue: item.issue,
    oldUrl: item.oldUrl,
    newUrl: item.newUrl,
    ...(item.issue === 'wrong-redirect' ? {
      redirectedTo: item.redirectedTo,
      oldHeading: item.oldH1,
      newHeading: item.newH1
    } : {
      matchRate: item.matchRate,
      oldHeadings: item.oldHeadings?.map(h => h.text) || [],
      newHeadings: item.newHeadings?.map(h => h.text) || []
    }),
    screenshots: {
      old: item.oldScreenshot ? `${SCREENSHOTS_DIR}/${item.oldScreenshot}` : null,
      new: item.newScreenshot ? `${SCREENSHOTS_DIR}/${item.newScreenshot}` : null
    }
  }));

  // Process critical issues
  const critical = results.critical.map(item => ({
    path: item.path,
    issue: item.issue,
    error: item.error || null,
    oldUrl: item.oldUrl,
    newUrl: item.newUrl,
    screenshots: {
      new: item.newScreenshot ? `${SCREENSHOTS_DIR}/${item.newScreenshot}` : null
    }
  }));

  // Summary of passed pages
  const passed = results.pass.map(item => ({
    path: item.path,
    matchRate: item.matchRate,
    redirectedTo: item.redirected || null
  }));

  const output = {
    metadata: {
      generated: new Date().toISOString(),
      oldSite: OLD_SITE,
      newSite: NEW_SITE,
      summary: {
        critical: critical.length,
        warnings: warnings.length,
        passed: passed.length
      }
    },
    instructions: `You are helping fix redirect mappings for a documentation site migration.

TASK: Review the warnings and critical issues below and suggest corrected redirects.

For each warning with "wrong-redirect" issue:
- The old page at "path" is redirecting to "redirectedTo"
- But the headings don't match: oldHeading vs newHeading
- Determine if this is a FALSE POSITIVE (headings are equivalent, e.g., "Groups" = "The Group object")
- Or a REAL ISSUE that needs a different redirect destination

For each critical "404" issue:
- The page doesn't exist on the new site
- Suggest where it should redirect to

Output your suggestions as a YAML redirects list like:
redirects:
  - source: "/old/path/"
    destination: "/new/path/"
`,
    critical,
    warnings,
    passed
  };

  ensureOutputDirs();
  const filepath = `${LLM_OUTPUT_DIR}/migration-data.json`;
  fs.writeFileSync(filepath, JSON.stringify(output, null, 2));
  console.log(`${colors.green}LLM output saved: ${filepath}${colors.reset}`);
  console.log(`${colors.green}Screenshots in: ${SCREENSHOTS_DIR}/${colors.reset}`);

  return filepath;
}

let completedCount = 0;

// ANSI color codes
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m'
};

// Output directory for LLM data and screenshots
const LLM_OUTPUT_DIR = 'llm-output';
const SCREENSHOTS_DIR = `${LLM_OUTPUT_DIR}/screenshots`;

// Ensure output directories exist
function ensureOutputDirs() {
  if (!fs.existsSync(LLM_OUTPUT_DIR)) fs.mkdirSync(LLM_OUTPUT_DIR);
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR);
}

// Capture screenshot and save to file, return filename
async function captureScreenshot(page, path, site) {
  try {
    ensureOutputDirs();
    const safeName = path.replace(/\//g, '_').replace(/^_/, '').replace(/_$/, '') || 'root';
    const filename = `${safeName}-${site}.jpg`;
    const filepath = `${SCREENSHOTS_DIR}/${filename}`;

    await page.screenshot({
      path: filepath,
      fullPage: false,
      type: 'jpeg',
      quality: 50
    });
    return filename;
  } catch (e) {
    return null;
  }
}

// Write live-updating HTML report
function writeLiveReport() {
  const html = generateReportHTML(true);
  fs.writeFileSync(LIVE_REPORT, html);
}

// Prompt user for input
function promptUser(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Try to fetch sitemap from a given URL
async function trySitemapUrl(sitemapUrl) {
  try {
    const response = await fetch(sitemapUrl);
    if (!response.ok) return null;

    const xml = await response.text();
    const parser = new xml2js.Parser();
    const parsed = await parser.parseStringPromise(xml);

    if (!parsed.urlset || !parsed.urlset.url) return null;

    const urls = parsed.urlset.url.map(entry => {
      const fullUrl = entry.loc[0];
      const urlObj = new URL(fullUrl);
      return urlObj.pathname + urlObj.search + urlObj.hash;
    });

    return urls;
  } catch (e) {
    return null;
  }
}

// Fetch and parse sitemap with auto-detection
async function fetchSitemap(baseUrl) {
  const origin = baseUrl.replace(/\/$/, '');

  // If user provided sitemap URL, try that first
  if (SITEMAP_URL) {
    console.log(`Trying user-provided sitemap: ${SITEMAP_URL}...`);
    const urls = await trySitemapUrl(SITEMAP_URL);
    if (urls) {
      console.log(`Found ${urls.length} pages in sitemap\n`);
      return urls;
    }
    console.log(`${colors.red}ERROR: Could not fetch sitemap from ${SITEMAP_URL}${colors.reset}\n`);
  }

  // Try common sitemap locations
  const commonPaths = [
    '/sitemap.xml',
    '/sitemap_index.xml',
    '/sitemap-index.xml',
    '/sitemaps/sitemap.xml',
    '/sitemap/sitemap.xml',
    '/docs/sitemap.xml'
  ];

  console.log(`Searching for sitemap at ${origin}...`);

  for (const path of commonPaths) {
    const sitemapUrl = origin + path;
    console.log(`  Trying ${path}...`);
    const urls = await trySitemapUrl(sitemapUrl);
    if (urls) {
      console.log(`  Found sitemap at ${path}!\n`);
      console.log(`Found ${urls.length} pages in sitemap\n`);
      return urls;
    }
  }

  // No sitemap found, prompt user
  console.log(`\n${colors.red}ERROR: Could not find sitemap automatically.${colors.reset}\n`);
  const userSitemapUrl = await promptUser('Please enter the full sitemap URL (or press Ctrl+C to exit): ');

  if (!userSitemapUrl) {
    throw new Error('No sitemap URL provided');
  }

  console.log(`\nFetching sitemap from ${userSitemapUrl}...`);
  const urls = await trySitemapUrl(userSitemapUrl);

  if (!urls) {
    throw new Error(`Failed to fetch or parse sitemap from ${userSitemapUrl}`);
  }

  console.log(`Found ${urls.length} pages in sitemap\n`);
  return urls;
}

// Get page headings (using custom selectors)
async function getHeadings(page) {
  try {
    return await page.$$eval(CUSTOM_SELECTORS, els =>
      els.map(el => ({
        level: el.tagName ? el.tagName.toLowerCase() : el.className,
        text: el.innerText.trim()
      }))
    );
  } catch (e) {
    return [];
  }
}

// Get main page heading (priority fallback system)
// Tries each selector in order and returns the first match
// Example: "h1,h2,h3,.custom-class" will try h1 first, then h2, then h3, then .custom-class
// This ensures standard headings are preferred over custom classes
async function getMainHeading(page) {
  const selectors = CUSTOM_SELECTORS.split(',').map(s => s.trim());

  for (const selector of selectors) {
    try {
      const heading = await page.$eval(selector, el => el.innerText.trim());
      if (heading) return heading;
    } catch (e) {
      // Selector not found, try next in priority order
    }
  }

  return null;
}

// Calculate text similarity using Levenshtein distance
function textSimilarity(str1, str2) {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();
  
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;
  
  // Create matrix
  const matrix = [];
  for (let i = 0; i <= s1.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= s2.length; j++) {
    matrix[0][j] = j;
  }
  
  // Fill matrix
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost // substitution
      );
    }
  }
  
  const distance = matrix[s1.length][s2.length];
  const maxLen = Math.max(s1.length, s2.length);
  return 1 - (distance / maxLen);
}

// Find best similarity match for a text in a set of texts
function findBestMatch(text, textSet) {
  let bestScore = 0;
  for (const candidate of textSet) {
    const score = textSimilarity(text, candidate);
    if (score > bestScore) bestScore = score;
  }
  return bestScore;
}

// Compare heading structures (level-agnostic, only text content matters)
// Uses fuzzy matching - texts with >80% similarity count as matches
const SIMILARITY_THRESHOLD = 0.8;

function compareHeadings(oldHeadings, newHeadings) {
  if (oldHeadings.length === 0 || newHeadings.length === 0) return 0;

  // Extract just the text, ignore heading levels (h1 vs h2 vs h3 doesn't matter)
  const oldTexts = oldHeadings.map(h => h.text.toLowerCase().trim());
  const newTexts = new Set(newHeadings.map(h => h.text.toLowerCase().trim()));

  // Count how many old headings have a similar match in new headings
  let totalSimilarity = 0;
  for (const text of oldTexts) {
    // Check for exact match first
    if (newTexts.has(text)) {
      totalSimilarity += 1;
    } else {
      // Check for fuzzy match
      const bestMatch = findBestMatch(text, newTexts);
      if (bestMatch >= SIMILARITY_THRESHOLD) {
        totalSimilarity += bestMatch; // Partial credit for similar matches
      }
    }
  }

  // Return match percentage based on old site headings
  return totalSimilarity / oldHeadings.length;
}

// Navigate with retry logic
async function navigateWithRetry(page, url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await page.goto(url, {
        waitUntil: 'networkidle2', // More forgiving than networkidle0
        timeout: 45000
      });
      return response;
    } catch (error) {
      if (attempt < retries) {
        console.log(`  ${colors.yellow}Retry ${attempt + 1}/${retries} for ${url}${colors.reset}`);
        await new Promise(r => setTimeout(r, 3000)); // Wait 3s before retry
      } else {
        throw error;
      }
    }
  }
}

// Analyze a single page
async function analyzePage(browser, path, total) {
  const oldUrl = OLD_SITE + path;
  const newUrl = NEW_SITE + path;

  let page;
  try {
    page = await browser.newPage();

    // Check old site first
    await navigateWithRetry(page, oldUrl);
    const oldHeading = await getMainHeading(page);
    const oldHeadings = await getHeadings(page);
    const oldScreenshot = await captureScreenshot(page, path, 'old');
    // Check new site
    const response = await navigateWithRetry(page, newUrl);
    const finalUrl = page.url();
    const finalPath = new URL(finalUrl).pathname;
    const status = response.status();

    // Tier 1: Check for 404
    if (status === 404) {
      console.log(`  ${colors.red}CRITICAL: 404 - Not Found${colors.reset}`);
      const newScreenshot = await captureScreenshot(page, path, 'new');
      results.critical.push({
        path,
        issue: '404',
        oldUrl,
        newUrl,
        newScreenshot
      });
      writeLiveReport();
      return;
    }

    // Tier 2: Check redirects
    if (finalPath !== path) {
      const newHeading = await getMainHeading(page);

      // Only flag mismatch if both headings exist and differ
      const headingsMatch = !oldHeading || !newHeading || oldHeading.toLowerCase() === newHeading.toLowerCase();

      if (!headingsMatch) {
        console.log(`  ${colors.yellow}WARNING: Redirect ${path} -> ${finalPath}${colors.reset}`);
        console.log(`     Heading mismatch: "${oldHeading}" != "${newHeading}"`);
        const newScreenshot = await captureScreenshot(page, path, 'new');
        results.warnings.push({
          path,
          issue: 'wrong-redirect',
          redirectedTo: finalPath,
          oldH1: oldHeading,
          newH1: newHeading,
          oldUrl,
          newUrl: finalUrl,
          oldScreenshot,
          newScreenshot
        });
        writeLiveReport();
        return;
      }

      console.log(`  ${colors.green}PASS: Redirected correctly ${path} -> ${finalPath}${colors.reset}`);
    }

    // Tier 3: Check content quality
    const newHeadings = await getHeadings(page);
    const matchRate = compareHeadings(oldHeadings, newHeadings);

    if (matchRate < 0.6) {
      console.log(`  ${colors.yellow}WARNING: Low heading match (${Math.round(matchRate * 100)}%)${colors.reset}`);
      const newScreenshot = await captureScreenshot(page, path, 'new');
      results.warnings.push({
        path,
        issue: 'content-mismatch',
        matchRate,
        oldHeadings,
        newHeadings,
        oldUrl,
        newUrl: finalUrl,
        oldScreenshot,
        newScreenshot
      });
      writeLiveReport();
    } else {
      console.log(`  ${colors.green}PASS: ${Math.round(matchRate * 100)}% heading match${colors.reset}`);
      results.pass.push({
        path,
        matchRate,
        oldUrl,
        newUrl: finalUrl,
        redirected: finalPath !== path ? finalPath : null
      });
    }

  } catch (error) {
    console.log(`  ${colors.red}ERROR: ${error.message}${colors.reset}`);
    results.critical.push({
      path,
      issue: 'error',
      error: error.message,
      oldUrl,
      newUrl
    });
    writeLiveReport();
  } finally {
    // Safe page close - catch errors to prevent crash
    if (page) {
      try {
        await page.close();
      } catch (e) {
        // Ignore close errors (tab may already be closed)
      }
    }

    // Update progress
    completedCount++;
    if (completedCount % CONCURRENCY === 0 || completedCount === total) {
      const pct = Math.round((completedCount / total) * 100);
      console.log(`\n${colors.green}Progress: ${completedCount}/${total} (${pct}%) - ${results.critical.length} critical, ${results.warnings.length} warnings${colors.reset}\n`);
    }
  }
}

// Generate HTML report
function generateReportHTML(isLive = false) {
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  ${isLive ? '<meta http-equiv="refresh" content="5">' : ''}
  <title>${isLive ? '[LIVE] ' : ''}Migration Report - ${new Date().toLocaleDateString()}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f5f5f5;
      padding: 20px;
    }
    .header {
      background: white;
      padding: 24px;
      border-radius: 8px;
      margin-bottom: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    h1 { font-size: 24px; margin-bottom: 16px; }
    .stats {
      display: flex;
      gap: 20px;
      margin-top: 16px;
    }
    .stat {
      padding: 12px 20px;
      border-radius: 6px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s, transform 0.2s;
      user-select: none;
    }
    .stat:hover {
      transform: translateY(-2px);
    }
    .stat.inactive {
      opacity: 0.4;
    }
    .stat.critical { background: #fee; color: #c00; }
    .stat.warning { background: #ffeaa7; color: #d63031; }
    .stat.pass { background: #d1fae5; color: #065f46; }
    .section {
      background: white;
      padding: 24px;
      border-radius: 8px;
      margin-bottom: 20px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .section h2 {
      font-size: 18px;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 2px solid #eee;
    }
    .section.critical h2 { border-color: #c00; }
    .section.warning h2 { border-color: #d63031; }
    .section.pass h2 { border-color: #10b981; }
    .item {
      padding: 16px;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      margin-bottom: 12px;
    }
    .item-path {
      font-family: monospace;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .item-issue {
      color: #666;
      font-size: 13px;
      margin-bottom: 8px;
    }
    .item-links {
      display: flex;
      gap: 10px;
      margin-top: 8px;
    }
    .item-links a {
      padding: 4px 12px;
      background: #f3f4f6;
      border-radius: 4px;
      text-decoration: none;
      color: #374151;
      font-size: 12px;
      font-weight: 500;
    }
    .item-links a:hover {
      background: #e5e7eb;
    }
    .headings {
      margin-top: 8px;
      padding: 8px;
      background: #f9fafb;
      border-radius: 4px;
      font-size: 11px;
      font-family: monospace;
    }
    .headings-comparison {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 8px;
    }
    .headings-col h4 {
      font-size: 11px;
      margin-bottom: 4px;
      color: #666;
    }
    .item-actions {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid #e5e7eb;
    }
    .action-btn {
      padding: 6px 14px;
      border: none;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }
    .dismiss-btn {
      background: #f3f4f6;
      color: #6b7280;
    }
    .dismiss-btn:hover {
      background: #e5e7eb;
    }
    .confirm-btn {
      background: #fee2e2;
      color: #991b1b;
    }
    .confirm-btn:hover {
      background: #fecaca;
    }
    .item.dismissed {
      opacity: 0.4;
      border-color: #d1d5db;
    }
    .item.confirmed {
      border-color: #f87171;
      background: #fef2f2;
    }
    .filters {
      margin-bottom: 16px;
      display: flex;
      gap: 12px;
    }
    .filter-btn {
      padding: 6px 12px;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      background: white;
      font-size: 12px;
      cursor: pointer;
    }
    .filter-btn.active {
      background: #3b82f6;
      color: white;
      border-color: #3b82f6;
    }
    .filter-btn.clear-btn {
      background: #fee2e2;
      border-color: #fca5a5;
      color: #991b1b;
    }
    .filter-btn.clear-btn:hover {
      background: #fecaca;
    }
    .screenshots {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-top: 12px;
    }
    .screenshot-col {
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      overflow: hidden;
    }
    .screenshot-col h4 {
      background: #f3f4f6;
      padding: 6px 10px;
      font-size: 11px;
      color: #666;
      border-bottom: 1px solid #e5e7eb;
    }
    .screenshot-col img {
      width: 100%;
      display: block;
    }
    .screenshots-toggle {
      background: #f3f4f6;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      padding: 8px 12px;
      font-size: 12px;
      cursor: pointer;
      margin-top: 12px;
      color: #666;
    }
    .screenshots-toggle:hover {
      background: #e5e7eb;
    }
    .screenshots.collapsed {
      display: none;
    }
    .live-indicator {
      display: inline-block;
      background: #10b981;
      color: white;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      animation: pulse 2s infinite;
      margin-left: 12px;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Migration Analysis Report${isLive ? '<span class="live-indicator">LIVE - Auto-refreshes every 5s</span>' : ''}</h1>
    <p>Generated: ${new Date().toLocaleString()}</p>
    <p>Old Site: <code>${OLD_SITE}</code></p>
    <p>New Site: <code>${NEW_SITE}</code></p>
    <div class="stats">
      <div class="stat critical" onclick="toggleSection('critical')">🔴 ${results.critical.length} Critical</div>
      <div class="stat warning" onclick="toggleSection('warning')">🟡 ${results.warnings.length} Warnings</div>
      <div class="stat pass" onclick="toggleSection('pass')">🟢 ${results.pass.length} Pass</div>
    </div>
  </div>

  ${results.critical.length > 0 ? `
  <div class="section critical" id="section-critical">
    <h2>🔴 Critical Issues (${results.critical.length})</h2>
    ${results.critical.map(item => `
      <div class="item">
        <div class="item-path">${item.path}</div>
        <div class="item-issue">
          ${item.issue === '404' ? '404 - Page Not Found' : item.issue === 'error' ? `Error: ${item.error}` : item.issue}
        </div>
        <div class="item-links">
          <a href="${item.oldUrl}" target="_blank">Open Old Site</a>
          <a href="${item.newUrl}" target="_blank">Open New Site</a>
        </div>
        ${item.newScreenshot ? `
        <button class="screenshots-toggle" onclick="this.nextElementSibling.classList.toggle('collapsed')">Show/Hide Screenshot</button>
        <div class="screenshots">
          <div class="screenshot-col">
            <h4>New Site (404/Error)</h4>
            <img src="${SCREENSHOTS_DIR}/${item.newScreenshot}" loading="lazy" alt="New site screenshot">
          </div>
        </div>
        ` : ''}
      </div>
    `).join('')}
  </div>
  ` : ''}

  ${results.warnings.length > 0 ? `
  <div class="section warning" id="section-warning">
    <h2>🟡 Warnings (${results.warnings.length})</h2>
    <div class="filters">
      <button class="filter-btn active" data-filter="all">Show All</button>
      <button class="filter-btn" data-filter="active">Active Only</button>
      <button class="filter-btn" data-filter="dismissed">Dismissed Only</button>
      <button class="filter-btn" data-filter="confirmed">Confirmed Only</button>
      <button class="filter-btn clear-btn" onclick="clearAllStates()">Clear All</button>
    </div>
    ${results.warnings.map((item, index) => `
      <div class="item" data-path="${item.path}" data-index="${index}">
        <div class="item-path">${item.path}</div>
        <div class="item-issue">
          ${item.issue === 'wrong-redirect'
            ? `Redirected to: ${item.redirectedTo}<br>Heading mismatch: "${item.oldH1}" ≠ "${item.newH1}"`
            : `Content mismatch: ${Math.round(item.matchRate * 100)}% heading match`
          }
        </div>
        <div class="item-links">
          <a href="${item.oldUrl}" target="_blank">Open Old Site</a>
          <a href="${item.newUrl}" target="_blank">Open New Site</a>
        </div>
        ${item.oldScreenshot || item.newScreenshot ? `
        <button class="screenshots-toggle" onclick="this.nextElementSibling.classList.toggle('collapsed')">Show/Hide Screenshots</button>
        <div class="screenshots">
          ${item.oldScreenshot ? `
          <div class="screenshot-col">
            <h4>Old Site</h4>
            <img src="${SCREENSHOTS_DIR}/${item.oldScreenshot}" loading="lazy" alt="Old site screenshot">
          </div>
          ` : ''}
          ${item.newScreenshot ? `
          <div class="screenshot-col">
            <h4>New Site</h4>
            <img src="${SCREENSHOTS_DIR}/${item.newScreenshot}" loading="lazy" alt="New site screenshot">
          </div>
          ` : ''}
        </div>
        ` : ''}
        ${item.oldHeadings && item.newHeadings ? `
          <div class="headings-comparison">
            <div class="headings-col">
              <h4>Old Site Headings:</h4>
              <div class="headings">
                ${item.oldHeadings.map(h => `${h.level}: ${h.text}`).join('<br>')}
              </div>
            </div>
            <div class="headings-col">
              <h4>New Site Headings:</h4>
              <div class="headings">
                ${item.newHeadings.map(h => `${h.level}: ${h.text}`).join('<br>')}
              </div>
            </div>
          </div>
          <div style="margin-top:8px;font-size:10px;color:#888;font-style:italic;">
            Note: Heading levels (h1/h2/h3) don't affect the match score, only text content.
          </div>
        ` : ''}
        <div class="item-actions">
          <button class="action-btn dismiss-btn" onclick="dismissItem('${item.path}')">❌ Dismiss (False Positive)</button>
          <button class="action-btn confirm-btn" onclick="confirmItem('${item.path}')">✓ Confirm Issue</button>
        </div>
      </div>
    `).join('')}
  </div>
  ` : ''}

  ${results.pass.length > 0 ? `
  <div class="section pass" id="section-pass">
    <h2>🟢 Passed (${results.pass.length})</h2>
    ${results.pass.slice(0, 50).map(item => `
      <div class="item">
        <div class="item-path">${item.path}</div>
        <div class="item-issue">
          ${item.redirected ? `✓ Redirected to ${item.redirected} - ` : ''}
          ${Math.round(item.matchRate * 100)}% heading match
        </div>
        <div class="item-links">
          <a href="${item.oldUrl}" target="_blank">Open Old Site</a>
          <a href="${item.newUrl}" target="_blank">Open New Site</a>
        </div>
      </div>
    `).join('')}
    ${results.pass.length > 50 ? `<p style="text-align:center;color:#666;margin-top:12px;">... and ${results.pass.length - 50} more</p>` : ''}
  </div>
  ` : ''}

  <script>
    // Toggle section visibility and scroll to it
    function toggleSection(type) {
      const section = document.getElementById('section-' + type);
      const stat = document.querySelector('.stat.' + type);
      if (!section) return;

      const isHidden = section.style.display === 'none';

      if (isHidden) {
        // Show and scroll to it
        section.style.display = 'block';
        stat.classList.remove('inactive');
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        // If visible, first check if we should scroll or hide
        const rect = section.getBoundingClientRect();
        const isInView = rect.top >= 0 && rect.top <= window.innerHeight / 2;

        if (isInView) {
          // Already in view, so hide it
          section.style.display = 'none';
          stat.classList.add('inactive');
        } else {
          // Not in view, scroll to it
          section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }
    }

    // LocalStorage key for storing item states
    const STORAGE_KEY = 'migration-report-states';

    // Load states from localStorage
    function loadStates() {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : {};
    }

    // Save states to localStorage
    function saveStates(states) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(states));
    }

    // Dismiss an item (mark as false positive)
    function dismissItem(path) {
      const states = loadStates();
      states[path] = 'dismissed';
      saveStates(states);
      updateItemDisplay(path, 'dismissed');
    }

    // Confirm an item (mark as real issue)
    function confirmItem(path) {
      const states = loadStates();
      states[path] = 'confirmed';
      saveStates(states);
      updateItemDisplay(path, 'confirmed');
    }

    // Clear all states (reset everything)
    function clearAllStates() {
      if (!confirm('Clear all dismissed/confirmed states? This cannot be undone.')) return;
      localStorage.removeItem(STORAGE_KEY);
      document.querySelectorAll('.item').forEach(item => {
        item.classList.remove('dismissed', 'confirmed');
      });
      applyFilter('all');
    }

    // Update item visual state
    function updateItemDisplay(path, state) {
      const item = document.querySelector(\`.item[data-path="\${path}"]\`);
      if (!item) return;

      item.classList.remove('dismissed', 'confirmed');
      if (state) {
        item.classList.add(state);
      }
    }

    // Apply filters
    function applyFilter(filter) {
      const states = loadStates();
      const items = document.querySelectorAll('.section.warning .item');

      items.forEach(item => {
        const path = item.dataset.path;
        const state = states[path] || 'active';

        let show = false;
        if (filter === 'all') show = true;
        else if (filter === 'active') show = !states[path];
        else if (filter === 'dismissed') show = state === 'dismissed';
        else if (filter === 'confirmed') show = state === 'confirmed';

        item.style.display = show ? 'block' : 'none';
      });

      // Update filter button states
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.filter === filter) {
          btn.classList.add('active');
        }
      });
    }

    // Initialize on page load
    document.addEventListener('DOMContentLoaded', () => {
      const states = loadStates();

      // Apply saved states to items
      Object.keys(states).forEach(path => {
        updateItemDisplay(path, states[path]);
      });

      // Setup filter buttons
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          applyFilter(btn.dataset.filter);
        });
      });

      // Default filter: show all
      applyFilter('all');
    });
  </script>
</body>
</html>`;

  return html;
}

// Generate final HTML report
function generateReport() {
  const html = generateReportHTML(false);
  const filename = `migration-report-${Date.now()}.html`;
  fs.writeFileSync(filename, html);
  console.log(`\nReport generated: ${filename}`);
  return filename;
}

// Generate redirects file
function generateRedirects() {
  const timestamp = new Date().toLocaleString();

  // Section 1: Verified Redirects (from passed pages that redirected)
  const verifiedRedirects = results.pass
    .filter(item => item.redirected)
    .map(item => ({
      from: item.path,
      to: item.redirected,
      status: 'verified',
      matchRate: item.matchRate
    }));

  // Section 2: Needs Review (from warnings with wrong redirects)
  const reviewRedirects = results.warnings
    .filter(item => item.issue === 'wrong-redirect')
    .map(item => ({
      from: item.path,
      to: item.redirectedTo,
      status: 'review',
      oldH1: item.oldH1,
      newH1: item.newH1
    }));

  // Section 3: Missing Redirects (404s)
  const missingRedirects = results.critical
    .filter(item => item.issue === '404')
    .map(item => ({
      from: item.path,
      to: null,
      status: 'missing'
    }));

  const mdx = `---
title: Migration Redirects
description: Auto-generated redirect suggestions from migration analysis
generated: ${timestamp}
---

# Migration Redirects

Auto-generated based on analysis of \`${OLD_SITE}\` → \`${NEW_SITE}\`

## Summary

- ✅ ${verifiedRedirects.length} Verified Redirects (working correctly)
- ⚠️ ${reviewRedirects.length} Redirects Need Review (heading mismatch)
- ❌ ${missingRedirects.length} Missing Redirects (404s - need destinations)

---

## ✅ Verified Redirects

These redirects are working correctly (content matches, headings match).

\`\`\`
${verifiedRedirects.map(r =>
  `${r.from} → ${r.to}  # ${Math.round(r.matchRate * 100)}% match`
).join('\n') || '# None'}
\`\`\`

---

## ⚠️ Redirects Needing Review

These redirects exist but headings don't match - verify they're correct.

${reviewRedirects.map(r => `
### \`${r.from}\` → \`${r.to}\`

- **Old heading:** "${r.oldH1}"
- **New heading:** "${r.newH1}"
- **Action:** Review if this is the correct destination

\`\`\`
${r.from} → ${r.to}
\`\`\`
`).join('\n') || '*None*'}

---

## ❌ Missing Redirects (404s)

These pages don't exist on the new site. Add redirects or create the pages.

\`\`\`
${missingRedirects.map(r =>
  `${r.from} → [DESTINATION_NEEDED]`
).join('\n') || '# None'}
\`\`\`

---

## Implementation

### For Fern:

Add these to your \`fern.config.yml\` or redirects configuration:

\`\`\`yaml
redirects:
${verifiedRedirects.map(r => `  - source: ${r.from}
    destination: ${r.to}`).join('\n')}
\`\`\`

### For Vercel/Netlify:

Add to \`vercel.json\` or \`_redirects\`:

\`\`\`json
{
  "redirects": [
${verifiedRedirects.map(r => `    { "source": "${r.from}", "destination": "${r.to}", "permanent": true }`).join(',\n')}
  ]
}
\`\`\`
`;

  const filename = `redirects-${Date.now()}.mdx`;
  fs.writeFileSync(filename, mdx);
  console.log(`\n${colors.green}Redirects file generated: ${filename}${colors.reset}`);
  return filename;
}

// Process pages in batches
async function processBatch(browser, paths, total) {
  const promises = paths.map(path => analyzePage(browser, path, total));
  await Promise.all(promises);
}

// Main function
async function main() {
  console.log('Migration Analysis Tool\n');
  console.log(`Old Site: ${OLD_SITE}`);
  console.log(`New Site: ${NEW_SITE}`);
  console.log(`Heading Selectors: ${CUSTOM_SELECTORS}`);
  console.log(`Concurrency: ${CONCURRENCY} pages at a time`);
  console.log(`Mode: ${FULL_SCAN ? 'Full scan (--full)' : 'Incremental (skipping cached passes)'}\n`);

  try {
    // Fetch sitemap
    let paths = await fetchSitemap(OLD_SITE);

    // Load cache and filter if not full scan
    const cache = loadCache();
    if (!FULL_SCAN && cache.size > 0) {
      const before = paths.length;
      paths = paths.filter(p => !cache.has(p));
      console.log(`${colors.yellow}Skipping ${before - paths.length} cached passed pages${colors.reset}`);
      console.log(`${colors.yellow}Analyzing ${paths.length} remaining pages${colors.reset}`);
      console.log(`${colors.yellow}Use --full flag to force full rescan${colors.reset}\n`);
    }

    if (paths.length === 0) {
      console.log(`${colors.green}All pages already passed! Use --full to rescan.${colors.reset}`);
      return;
    }

    // Launch browser in headless mode
    console.log('Launching browser (headless mode)...\n');
    const browser = await puppeteer.launch({
      headless: true,
      defaultViewport: { width: 1280, height: 800 }
    });

    console.log(`Starting analysis of ${paths.length} pages...\n`);

    // Create initial live report
    writeLiveReport();
    console.log(`${colors.green}Live report available: ${LIVE_REPORT}${colors.reset}`);
    console.log('Open it in your browser to see results as they come in.\n');

    // Process pages in batches for concurrency control
    for (let i = 0; i < paths.length; i += CONCURRENCY) {
      const batch = paths.slice(i, i + CONCURRENCY);
      await processBatch(browser, batch, paths.length);
    }

    await browser.close();

    // Generate report
    console.log('\n' + '='.repeat(50));
    console.log('Analysis Complete!\n');
    console.log(`${colors.red}Critical: ${results.critical.length}${colors.reset}`);
    console.log(`${colors.yellow}Warnings: ${results.warnings.length}${colors.reset}`);
    console.log(`${colors.green}Pass: ${results.pass.length}${colors.reset}`);
    console.log('='.repeat(50) + '\n');

    const reportFile = generateReport();
    generateRedirects();
    generateLLMOutput();
    saveCache();

    // Remove live report, final is ready
    try { fs.unlinkSync(LIVE_REPORT); } catch (e) {}

    // Try to open report automatically
    const { exec } = require('child_process');
    exec(`open ${reportFile}`);

  } catch (error) {
    console.error(`${colors.red}ERROR: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

main();

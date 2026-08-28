#!/usr/bin/env node

'use strict';

// This command is intentionally local-only. It performs one interactive-style
// browser login, then stores only the resulting refresh token in Secret Manager.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const puppeteer = require('puppeteer-core');
const { authenticator } = require('otplib');

const DEFAULT_PROJECT_ID = 'reservation-bot-8e993';
const REFRESH_TOKEN_SECRET = 'GYM_REFRESH_TOKEN';
const SPORTS_PORTAL_ORIGIN = 'https://tilburguniversity.sports.delcom.nl';
const LOGIN_URL = `${SPORTS_PORTAL_ORIGIN}/pages/login`;
const AUTH_TIMEOUT_MS = 45_000;
const TOKEN_TIMEOUT_MS = 60_000;
const MOBILE_VIEWPORT = {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true
};

function printUsage() {
    console.log([
        'Usage: node scripts/bootstrap-refresh-token.js [options]',
        '',
        'Options:',
        `  --project <id>   Google Cloud project (default: ${DEFAULT_PROJECT_ID})`,
        '  --chrome <path>  Local Chrome/Chromium executable',
        '  --headed         Show the browser window while logging in',
        '  --help           Show this help'
    ].join('\n'));
}

function parseArguments(argv) {
    const options = {
        projectId: DEFAULT_PROJECT_ID,
        chromePath: null,
        headed: false,
        help: false
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === '--help' || argument === '-h') {
            options.help = true;
        } else if (argument === '--headed') {
            options.headed = true;
        } else if (argument === '--project' || argument === '--chrome') {
            const value = argv[index + 1];
            if (!value || value.startsWith('--')) {
                throw new Error(`${argument} requires a value.`);
            }
            index += 1;
            if (argument === '--project') options.projectId = value;
            else options.chromePath = value;
        } else if (argument.startsWith('--project=')) {
            options.projectId = argument.slice('--project='.length);
        } else if (argument.startsWith('--chrome=')) {
            options.chromePath = argument.slice('--chrome='.length);
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }

    if (!options.projectId.trim()) throw new Error('The Google Cloud project ID cannot be empty.');
    return options;
}

function redactSensitiveText(value) {
    return String(value ?? '')
        .replace(/https?:\/\/[^\s"'<>]+/g, rawUrl => sanitizeUrl(rawUrl))
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/(["']?(?:accessToken|access_token|refreshToken|refresh_token|password|otc)["']?\s*[:=]\s*)["']?[^\s,"'}]+/gi, '$1[redacted]')
        .replace(/\b[A-Za-z0-9_-]{80,}\b/g, '[redacted]')
        .trim();
}

function sanitizeUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        return `${url.origin}${url.pathname}`;
    } catch {
        return '[invalid-url]';
    }
}

function runGcloud(args, { input, allowFailure = false } = {}) {
    const result = spawnSync('gcloud', args, {
        encoding: 'utf8',
        input,
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe']
    });

    if (result.error) {
        if (result.error.code === 'ENOENT') {
            throw new Error('gcloud was not found. Install the Google Cloud CLI and authenticate it first.');
        }
        throw new Error(`Could not start gcloud: ${redactSensitiveText(result.error.message)}`);
    }

    const commandResult = {
        status: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? ''
    };

    if (commandResult.status !== 0 && !allowFailure) {
        const detail = redactSensitiveText(commandResult.stderr) || 'no error detail returned';
        throw new Error(`gcloud command failed: ${detail}`);
    }

    return commandResult;
}

function projectFlag(projectId) {
    return `--project=${projectId}`;
}

function readSecret(projectId, secretName, version = 'latest') {
    const result = runGcloud([
        'secrets',
        'versions',
        'access',
        String(version),
        `--secret=${secretName}`,
        projectFlag(projectId),
        '--verbosity=error'
    ]);

    if (!result.stdout.length) throw new Error(`Secret ${secretName} is empty.`);
    return result.stdout;
}

function readLoginSecrets(projectId) {
    console.log('Reading existing login secrets through the authenticated gcloud CLI...');
    const username = readSecret(projectId, 'GYM_USERNAME').trim();
    const password = readSecret(projectId, 'GYM_PASSWORD');
    const totpSecret = readSecret(projectId, 'TOTP_SECRET').trim();

    if (!username || !password || !totpSecret) {
        throw new Error('One or more login secrets are empty.');
    }
    if (!username.includes('@')) {
        throw new Error('GYM_USERNAME must contain the full university email/UPN.');
    }

    return { username, password, totpSecret };
}

function resolveChromeExecutable(explicitPath) {
    const candidates = [
        explicitPath,
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.CHROME_PATH,
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        path.join(os.homedir(), 'Applications/Chromium.app/Contents/MacOS/Chromium'),
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        process.env.PROGRAMFILES
            ? path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')
            : null,
        process.env['PROGRAMFILES(X86)']
            ? path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe')
            : null
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // Try the next known local browser location.
        }
    }

    throw new Error(
        'No local Chrome/Chromium executable was found. Pass one with --chrome or PUPPETEER_EXECUTABLE_PATH.'
    );
}

function setupSafeBrowserDiagnostics(page) {
    page.on('pageerror', error => {
        console.warn(`Browser page error: ${redactSensitiveText(error.message)}`);
    });

    page.on('requestfailed', request => {
        console.warn(
            `Browser request failed: ${request.method()} ${sanitizeUrl(request.url())} ` +
            `(${redactSensitiveText(request.failure()?.errorText || 'unknown failure')})`
        );
    });
}

async function findVisibleElement(page, selector) {
    const elements = await page.$$(selector);

    for (const element of elements) {
        let visible = false;
        try {
            visible = await element.evaluate(node => {
                const style = window.getComputedStyle(node);
                const rect = node.getBoundingClientRect();
                return node.getAttribute('aria-hidden') !== 'true' &&
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    rect.width > 0 &&
                    rect.height > 0;
            });
        } catch {
            // Navigation can replace the execution context while checking visibility.
        }

        if (visible) {
            for (const otherElement of elements) {
                if (otherElement !== element) await otherElement.dispose().catch(() => {});
            }
            return element;
        }

        await element.dispose().catch(() => {});
    }

    return null;
}

async function waitForVisibleElement(page, selector, timeout = 30_000) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
        try {
            const element = await findVisibleElement(page, selector);
            if (element) return element;
        } catch (error) {
            if (page.isClosed()) throw error;
        }
        await sleep(100);
    }

    throw new Error(`Timed out waiting for visible selector: ${selector}`);
}

async function clearAndType(page, selector, value) {
    const element = await waitForVisibleElement(page, selector, AUTH_TIMEOUT_MS);
    await element.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await element.type(String(value), { delay: 15 });
}

async function clickVisibleAndWaitForNavigation(page, selector) {
    const element = await waitForVisibleElement(page, selector, AUTH_TIMEOUT_MS);
    const navigation = page.waitForNavigation({
        waitUntil: 'domcontentloaded',
        timeout: AUTH_TIMEOUT_MS
    });
    await Promise.all([navigation, element.click()]);
}

async function dismissCookieDialog(page) {
    let declineButton;
    try {
        declineButton = await waitForVisibleElement(
            page,
            '[data-test-id="cookie-decline-all"]',
            3_000
        );
    } catch (error) {
        if (!error.message.includes('Timed out waiting for visible selector')) throw error;
        return;
    }

    await declineButton.click();
    await page.waitForFunction(selector => {
        return Array.from(document.querySelectorAll(selector)).every(element => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display === 'none' ||
                style.visibility === 'hidden' ||
                rect.width === 0 ||
                rect.height === 0;
        });
    }, { timeout: 10_000 }, '[data-test-id="cookie-decline-all"]');
}

async function submitInstitution(page) {
    const institution = await waitForVisibleElement(page, '[data-title="Tilburg University"]');
    const navigation = page.waitForNavigation({
        waitUntil: 'domcontentloaded',
        timeout: AUTH_TIMEOUT_MS
    });

    await Promise.all([
        navigation,
        institution.evaluate(element => {
            const form = element.querySelector('form');
            if (!form) throw new Error('The Tilburg University login form was not found.');
            form.requestSubmit();
        })
    ]);
}

async function waitForSafeTotpWindow() {
    const remaining = authenticator.timeRemaining();
    if (remaining >= 5) return;

    const waitMs = (remaining + 1) * 1_000;
    console.log('Waiting briefly for a fresh one-time-password window...');
    await sleep(waitMs);
}

async function waitForOptionalAuthButtonOrPortal(page, selector, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    const startingOrigin = new URL(page.url()).origin;

    while (Date.now() < deadline) {
        const currentOrigin = new URL(page.url()).origin;
        if (currentOrigin === SPORTS_PORTAL_ORIGIN) return { state: 'portal' };
        if (currentOrigin !== startingOrigin) return { state: 'changed' };

        const element = await findVisibleElement(page, selector).catch(error => {
            if (page.isClosed()) throw error;
            return null;
        });
        if (element) return { state: 'button', element };
        await sleep(100);
    }

    throw new Error(`Authentication stalled at ${sanitizeUrl(page.url())}`);
}

async function clickAuthButtonAndWaitForNavigation(page, element) {
    const navigation = page.waitForNavigation({
        waitUntil: 'domcontentloaded',
        timeout: AUTH_TIMEOUT_MS
    });

    try {
        await Promise.all([navigation, element.click()]);
    } catch (error) {
        if (new URL(page.url()).origin === SPORTS_PORTAL_ORIGIN) return;
        throw error;
    }
}

async function finishOptionalAuthentication(page) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const currentUrl = new URL(page.url());
        if (currentUrl.origin === SPORTS_PORTAL_ORIGIN) return;

        if (currentUrl.hostname === 'login.microsoftonline.com') {
            const result = await waitForOptionalAuthButtonOrPortal(page, '#idSIButton9');
            if (result.state === 'portal') return;
            if (result.state === 'changed') continue;
            console.log('Completing optional Microsoft confirmation...');
            await clickAuthButtonAndWaitForNavigation(page, result.element);
            continue;
        }

        if (currentUrl.hostname.endsWith('surfconext.nl')) {
            const result = await waitForOptionalAuthButtonOrPortal(
                page,
                'button[type="submit"], input[type="submit"]'
            );
            if (result.state === 'portal') return;
            if (result.state === 'changed') continue;
            console.log('Completing optional SURFconext consent...');
            await clickAuthButtonAndWaitForNavigation(page, result.element);
            continue;
        }

        throw new Error(`Unexpected authentication page: ${sanitizeUrl(page.url())}`);
    }

    throw new Error(`Authentication did not return to the sports portal: ${sanitizeUrl(page.url())}`);
}

async function loginAndExtractRefreshToken({ username, password, totpSecret, chromePath, headed }) {
    console.log(`Launching local Chrome in ${headed ? 'headed' : 'headless'} mode...`);
    const browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: headed ? false : true,
        defaultViewport: MOBILE_VIEWPORT,
        args: ['--disable-dev-shm-usage'],
        protocolTimeout: 60_000
    });

    let browserContext;
    try {
        browserContext = await browser.createBrowserContext();
        const page = await browserContext.newPage();
        await page.emulateTimezone('Europe/Amsterdam');
        setupSafeBrowserDiagnostics(page);

        console.log('Opening the Tilburg University Sports Centre login...');
        await page.goto(LOGIN_URL, {
            waitUntil: 'networkidle2',
            timeout: AUTH_TIMEOUT_MS
        });
        await dismissCookieDialog(page);

        await clickVisibleAndWaitForNavigation(page, '[data-test-id="oidc-login-button"]');
        await submitInstitution(page);

        await clearAndType(page, 'input[name="loginfmt"]', username);
        await clickVisibleAndWaitForNavigation(page, '#idSIButton9');

        await clearAndType(
            page,
            'input[name="password"], input[name="passwd"], input[type="password"]',
            password
        );
        await clickVisibleAndWaitForNavigation(page, 'input[type="submit"]');

        await waitForSafeTotpWindow();
        await clearAndType(page, 'input[name="otc"]', authenticator.generate(totpSecret));
        await clickVisibleAndWaitForNavigation(page, '#idSubmit_SAOTCC_Continue');

        await finishOptionalAuthentication(page);
        console.log('Authentication returned to the sports portal; waiting for its token state...');

        await page.waitForFunction(origin => {
            if (location.origin !== origin) return false;
            try {
                const authState = JSON.parse(localStorage.getItem('delcom_auth') || 'null');
                return typeof authState?.tokenResponse?.refreshToken === 'string' &&
                    authState.tokenResponse.refreshToken.length > 20;
            } catch {
                return false;
            }
        }, { timeout: TOKEN_TIMEOUT_MS, polling: 100 }, SPORTS_PORTAL_ORIGIN);

        const refreshToken = await page.evaluate(() => {
            const authState = JSON.parse(localStorage.getItem('delcom_auth') || 'null');
            return authState?.tokenResponse?.refreshToken ?? null;
        });

        if (typeof refreshToken !== 'string' || refreshToken.length < 20) {
            throw new Error('The portal did not store a usable refresh token.');
        }

        return refreshToken;
    } finally {
        if (browserContext) await browserContext.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

function ensureRefreshTokenSecret(projectId) {
    const description = runGcloud([
        'secrets',
        'describe',
        REFRESH_TOKEN_SECRET,
        projectFlag(projectId),
        '--format=value(name)',
        '--verbosity=error'
    ], { allowFailure: true });

    if (description.status === 0) return;

    const detail = `${description.stderr}\n${description.stdout}`;
    if (!/NOT_FOUND|not found|does not exist/i.test(detail)) {
        throw new Error(
            `Could not inspect ${REFRESH_TOKEN_SECRET}: ` +
            (redactSensitiveText(description.stderr) || 'unknown gcloud error')
        );
    }

    console.log(`Creating Secret Manager secret ${REFRESH_TOKEN_SECRET}...`);
    runGcloud([
        'secrets',
        'create',
        REFRESH_TOKEN_SECRET,
        projectFlag(projectId),
        '--replication-policy=automatic',
        '--format=value(name)',
        '--verbosity=error'
    ]);
}

function parseJsonOutput(output, operation) {
    try {
        return output.trim() ? JSON.parse(output) : null;
    } catch {
        throw new Error(`${operation} returned malformed JSON.`);
    }
}

function versionIdFromName(name) {
    const match = String(name ?? '').match(/(?:^|\/)(\d+)$/);
    return match ? match[1] : null;
}

function listLiveVersions(projectId) {
    const result = runGcloud([
        'secrets',
        'versions',
        'list',
        REFRESH_TOKEN_SECRET,
        projectFlag(projectId),
        '--format=json(name,state,createTime)',
        '--verbosity=error'
    ]);
    const versions = parseJsonOutput(result.stdout, 'Secret version listing') ?? [];

    if (!Array.isArray(versions)) throw new Error('Secret version listing did not return an array.');
    return versions.map(version => ({
        id: versionIdFromName(version.name),
        name: version.name,
        state: version.state ?? null,
        createTime: version.createTime ?? null
    })).filter(version => version.id && version.state !== 'DESTROYED');
}

function addRefreshTokenVersion(projectId, refreshToken) {
    const previousVersions = listLiveVersions(projectId);
    console.log(`Adding a new ${REFRESH_TOKEN_SECRET} version over stdin...`);

    const result = runGcloud([
        'secrets',
        'versions',
        'add',
        REFRESH_TOKEN_SECRET,
        projectFlag(projectId),
        '--data-file=-',
        '--format=json(name)',
        '--verbosity=error'
    ], { input: refreshToken });

    const addResponse = parseJsonOutput(result.stdout, 'Secret version creation');
    let createdVersionId = versionIdFromName(addResponse?.name);
    const liveVersions = listLiveVersions(projectId);

    if (!createdVersionId) {
        const previousIds = new Set(previousVersions.map(version => version.id));
        const newVersions = liveVersions.filter(version => !previousIds.has(version.id));
        if (newVersions.length !== 1) {
            throw new Error('Could not safely identify the newly-created secret version; no old versions were destroyed.');
        }
        createdVersionId = newVersions[0].id;
    }

    if (!liveVersions.some(version =>
        version.id === createdVersionId && version.state === 'ENABLED'
    )) {
        throw new Error('The newly-created refresh-token version is not enabled.');
    }

    return { createdVersionId, liveVersions };
}

function tokensMatch(first, second) {
    const firstDigest = crypto.createHash('sha256').update(first, 'utf8').digest();
    const secondDigest = crypto.createHash('sha256').update(second, 'utf8').digest();
    return crypto.timingSafeEqual(firstDigest, secondDigest);
}

function validateStoredRefreshToken(projectId, versionId, expectedToken) {
    const versionValue = readSecret(projectId, REFRESH_TOKEN_SECRET, versionId);
    const latestValue = readSecret(projectId, REFRESH_TOKEN_SECRET, 'latest');

    if (!tokensMatch(versionValue, expectedToken) || !tokensMatch(latestValue, expectedToken)) {
        throw new Error('Refresh-token read-back verification failed; no old versions were destroyed.');
    }
}

function destroySupersededVersions(projectId, createdVersionId, liveVersions) {
    const createdNumericId = Number(createdVersionId);
    const superseded = liveVersions.filter(version =>
        Number.isSafeInteger(Number(version.id)) && Number(version.id) < createdNumericId
    );

    for (const version of superseded) {
        runGcloud([
            'secrets',
            'versions',
            'destroy',
            version.id,
            `--secret=${REFRESH_TOKEN_SECRET}`,
            projectFlag(projectId),
            '--quiet',
            '--format=none',
            '--verbosity=error'
        ]);
    }

    const remainingLive = listLiveVersions(projectId);
    if (remainingLive.length !== 1 || remainingLive[0].id !== createdVersionId) {
        throw new Error('Refresh token was stored, but superseded live versions could not all be destroyed.');
    }

    return superseded.length;
}

function getTokenExpiry(refreshToken) {
    try {
        const parts = refreshToken.split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (!Number.isFinite(payload.exp)) return null;
        return new Date(payload.exp * 1_000);
    } catch {
        return null;
    }
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        printUsage();
        return;
    }

    const chromePath = resolveChromeExecutable(options.chromePath);
    const loginSecrets = readLoginSecrets(options.projectId);
    const refreshToken = await loginAndExtractRefreshToken({
        ...loginSecrets,
        chromePath,
        headed: options.headed
    });

    const expiry = getTokenExpiry(refreshToken);
    console.log(
        expiry
            ? `Refresh token acquired; token expiry is ${expiry.toISOString()}.`
            : 'Refresh token acquired; it uses an opaque or non-JWT format.'
    );

    ensureRefreshTokenSecret(options.projectId);
    const { createdVersionId, liveVersions } = addRefreshTokenVersion(
        options.projectId,
        refreshToken
    );

    validateStoredRefreshToken(options.projectId, createdVersionId, refreshToken);
    console.log(`Verified ${REFRESH_TOKEN_SECRET} version ${createdVersionId} by safe read-back comparison.`);

    const destroyedCount = destroySupersededVersions(
        options.projectId,
        createdVersionId,
        liveVersions
    );
    console.log(
        `Bootstrap complete. Version ${createdVersionId} is the only enabled ${REFRESH_TOKEN_SECRET} version` +
        `; destroyed ${destroyedCount} superseded version${destroyedCount === 1 ? '' : 's'}.`
    );
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

if (require.main === module) {
    main().catch(error => {
        console.error(`Bootstrap failed: ${redactSensitiveText(error.message)}`);
        process.exitCode = 1;
    });
}

module.exports = {
    parseArguments,
    resolveChromeExecutable,
    sanitizeUrl,
    versionIdFromName
};

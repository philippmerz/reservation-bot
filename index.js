const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const { authenticator } = require("otplib");
const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
const { Storage } = require('@google-cloud/storage');

process.env.TZ = 'Europe/Amsterdam';

const storage = new Storage();
const BUCKET_NAME = 'reservation-bot-8e993.firebasestorage.app';
const SPORTS_PORTAL_ORIGIN = 'https://tilburguniversity.sports.delcom.nl';
const LOGIN_URL = `${SPORTS_PORTAL_ORIGIN}/pages/login`;
const ACTIVITIES_URL = `${SPORTS_PORTAL_ORIGIN}/bookings/activities`;
const AUTH_TIMEOUT_MS = 45_000;
const PORTAL_READY_TIMEOUT_MS = 60_000;

// ============================================================================
// RESERVATION CONFIGURATION
// ============================================================================
// Each reservation will be made at 8:00 AM exactly 7 days before the slot.
// dayOfWeek: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
// ============================================================================
const RESERVATIONS = [
    { category: 'CATEGORY', timeslot: '20:15', dayOfWeek: 1 },  // mon 
];

const RESERVATION_OPENS_AT_HOUR = 8;
const RESERVATION_OPENS_AT_MINUTE = 0;
const DAYS_IN_ADVANCE = 7;

// Run the whole session at a common mobile viewport (iPhone 14/15 logical size)
const MOBILE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function uploadArtifact(filePath, destFileName, mimeType) {
    console.log(`[STORAGE] Starting upload of ${destFileName} from ${filePath}`);

    await storage.bucket(BUCKET_NAME).upload(filePath, {
        destination: `debug_logs/${destFileName}`, // Uploads to a 'debug_logs' folder
        metadata: { contentType: mimeType },
    });
    console.log(`[STORAGE] Successfully uploaded: gs://${BUCKET_NAME}/debug_logs/${destFileName}`);
}

setGlobalOptions({ maxInstances: 1, concurrency: 1 });

// Initialize Secret Manager client
const client = new SecretManagerServiceClient();

async function accessSecret(secretName) {
    const [version] = await client.accessSecretVersion({
        name: `projects/576703361007/secrets/${secretName}/versions/latest`
    });
    return version.payload.data.toString("utf8");
}

exports.yourWeeklyBot = onSchedule({
    schedule: "59 7 * * *",  // Run daily at 7:59 AM to be ready for 8:00 AM reservations
    timeZone: "Europe/Amsterdam",
    memory: "1GiB",
    timeoutSeconds: 600
}, async (event) => {
    const todaysReservations = getReservationsForToday();
    
    if (todaysReservations.length === 0) {
        console.log('No reservations to make today.');
        return;
    }

    console.log(`Found ${todaysReservations.length} reservation(s) to make today:`, 
        todaysReservations.map(r => `${r.category} at ${r.timeslot}`));

    let browser;
    let page;

    try {
        const TOTP_SECRET = await accessSecret("TOTP_SECRET");
        const GYM_USERNAME = await accessSecret("GYM_USERNAME");
        const GYM_PASSWORD = await accessSecret("GYM_PASSWORD");

        browser = await launchBrowser();
        page = await browser.newPage();
        await page.emulateTimezone('Europe/Amsterdam');
        setupNetworkLogging(page);

        await loginToSportsPortal(page, GYM_USERNAME, GYM_PASSWORD, TOTP_SECRET);
        
        // Wait once for reservations to open, then book all slots
        await waitUntilReservationsOpen();
        
        for (const reservation of todaysReservations) {
            await makeReservation(page, reservation);
        }

        console.log('All reservations completed successfully.');
    } catch (error) {
        if (page) {
            await captureFailureScreenshot(page, error);
        } else {
            console.error('Bot failed before a browser page was created:', sanitizeLogText(error.message));
        }
        throw error;
    } finally {
        if (browser) {
            await browser.close().catch(closeError => {
                console.error('Could not close browser cleanly:', sanitizeLogText(closeError.message));
            });
        }
    }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getReservationsForToday() {
    const today = new Date();
    const targetDayOfWeek = getTargetDayOfWeek(today);
    
    return RESERVATIONS.filter(r => r.dayOfWeek === targetDayOfWeek);
}

function getTargetDayOfWeek(today) {
    // Reservations open 7 days in advance at 8:00 AM
    // So today we're booking for (today + 7 days)
    const targetDate = new Date(today);
    targetDate.setDate(targetDate.getDate() + DAYS_IN_ADVANCE);
    return targetDate.getDay();
}

function getReservationDateString() {
    const now = new Date();
    const targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() + DAYS_IN_ADVANCE);
    return targetDate.toISOString().split('T')[0]; // YYYY-MM-DD
}

async function launchBrowser() {
    // @sparticuz/chromium ships --single-process, which makes Page.captureScreenshot
    // hang (browser and renderer share one thread). We have 1GiB, so run multi-process.
    const args = [
        ...chromium.args.filter(arg => arg !== '--single-process'),
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
    ];

    return puppeteer.launch({
        args,
        defaultViewport: MOBILE_VIEWPORT,
        executablePath: await chromium.executablePath(),
        headless: true,
        ignoreHTTPSErrors: true,
        protocolTimeout: 60_000  // default is 180s; fail fast instead of burning the function timeout
    });
}

function setupNetworkLogging(page) {
    page.on('response', response => {
        const status = response.status();
        const url = sanitizeUrl(response.url());
        const headers = response.headers();

        if (status >= 300 && status < 400) {
            console.warn(`[NETWORK:REDIRECT] Status ${status} | From: ${url} | To: ${sanitizeUrl(headers.location, response.url())}`);
        } else if (url.includes('login.microsoftonline.com') && status !== 200) {
            console.error(`[NETWORK:MSFT_ERROR] Status ${status} | URL: ${url}`);
        } else if (status >= 400) {
            console.error(`[NETWORK:HTTP_ERROR] Status ${status} | URL: ${url}`);
        }
    });
}

async function loginToSportsPortal(page, username, password, totpSecret) {
    console.log('Logging in to sports portal...');

    const normalizedUsername = String(username).trim();
    if (!normalizedUsername.includes('@')) {
        throw new Error('GYM_USERNAME must be the full university email/UPN required by Microsoft sign-in.');
    }

    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: AUTH_TIMEOUT_MS });
    await dismissCookieDialog(page);

    await clickVisibleAndWaitForNavigation(page, '[data-test-id="oidc-login-button"]');
    await submitVisibleInstitutionAndWaitForNavigation(page);

    await clearAndType(page, 'input[name="loginfmt"]', normalizedUsername);
    await clickVisibleAndWaitForNavigation(page, '#idSIButton9');

    // Tilburg's ADFS form uses name="password". The fallback covers Microsoft's
    // current name="passwd" field if the identity flow changes again.
    await clearAndType(page, 'input[name="password"], input[name="passwd"], input[type="password"]', password);
    await clickVisibleAndWaitForNavigation(page, 'input[type="submit"]');

    await clearAndType(page, 'input[name="otc"]', authenticator.generate(String(totpSecret).trim()));
    await clickVisibleAndWaitForNavigation(page, '#idSubmit_SAOTCC_Continue');

    await finishOptionalAuthentication(page);
    await waitForPortalReady(page);

    console.log('Login successful. Current URL:', sanitizeUrl(page.url()));
}

async function dismissCookieDialog(page) {
    let declineButton;
    try {
        declineButton = await waitForVisibleElement(page, '[data-test-id="cookie-decline-all"]', 3_000);
    } catch (error) {
        if (error.code !== 'VISIBLE_SELECTOR_TIMEOUT') throw error;
        console.log('No cookie dialog shown.');
        return;
    }

    await declineButton.click();
    await page.waitForFunction(selector => {
        const elements = Array.from(document.querySelectorAll(selector));
        return elements.every(element => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display === 'none' || style.visibility === 'hidden' || rect.width === 0 || rect.height === 0;
        });
    }, { timeout: 10_000 }, '[data-test-id="cookie-decline-all"]');

    // Dismissing the dialog can rerender the login controls.
    await waitForVisibleElement(page, '[data-test-id="oidc-login-button"]');
    console.log('Cookie dialog dismissed.');
}

async function submitVisibleInstitutionAndWaitForNavigation(page) {
    const institution = await waitForVisibleElement(page, '[data-title="Tilburg University"]');
    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: AUTH_TIMEOUT_MS });

    await Promise.all([
        navigation,
        institution.evaluate(element => {
            const form = element.querySelector('form');
            if (!form) throw new Error('Tilburg University login form was not found.');
            form.requestSubmit();
        })
    ]);
}

async function clickVisibleAndWaitForNavigation(page, selector) {
    const element = await waitForVisibleElement(page, selector, AUTH_TIMEOUT_MS);
    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: AUTH_TIMEOUT_MS });
    await Promise.all([navigation, element.click()]);
}

async function finishOptionalAuthentication(page) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const currentUrl = new URL(page.url());
        if (currentUrl.origin === SPORTS_PORTAL_ORIGIN) return;

        if (currentUrl.hostname === 'login.microsoftonline.com') {
            const result = await waitForOptionalAuthButtonOrPortal(page, '#idSIButton9');
            if (result.state === 'portal') return;
            if (result.state === 'changed') continue;
            console.log('Completing optional Microsoft confirmation.');
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
            console.log('Completing optional SURFconext consent.');
            await clickAuthButtonAndWaitForNavigation(page, result.element);
            continue;
        }

        throw new Error(`Unexpected authentication page: ${sanitizeUrl(page.url())}`);
    }

    throw new Error(`Authentication did not return to the sports portal: ${sanitizeUrl(page.url())}`);
}

async function waitForOptionalAuthButtonOrPortal(page, selector, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    const startingOrigin = new URL(page.url()).origin;

    while (Date.now() < deadline) {
        const currentOrigin = new URL(page.url()).origin;
        if (currentOrigin === SPORTS_PORTAL_ORIGIN) return { state: 'portal' };
        if (currentOrigin !== startingOrigin) return { state: 'changed' };

        try {
            const element = await findVisibleElement(page, selector);
            if (element) return { state: 'button', element };
        } catch (error) {
            if (page.isClosed()) throw error;
        }
        await sleep(100);
    }

    throw new Error(`Authentication stalled at ${sanitizeUrl(page.url())}`);
}

async function clickAuthButtonAndWaitForNavigation(page, element) {
    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: AUTH_TIMEOUT_MS });
    try {
        await Promise.all([navigation, element.click()]);
    } catch (error) {
        if (new URL(page.url()).origin === SPORTS_PORTAL_ORIGIN) return;
        throw error;
    }
}

async function waitForPortalReady(page) {
    await page.waitForFunction((origin, markerSelector) => {
        const marker = document.querySelector(markerSelector);
        if (!marker || location.origin !== origin) return false;
        const style = window.getComputedStyle(marker);
        const rect = marker.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }, {
        timeout: PORTAL_READY_TIMEOUT_MS,
        polling: 100
    }, SPORTS_PORTAL_ORIGIN, '[data-test-id="open-tag-selection-filter"]');
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
            // The page may have navigated while inspecting the element.
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
            // Execution contexts are briefly unavailable during navigation.
        }
        await sleep(100);
    }

    const error = new Error(`Timed out waiting for visible selector: ${selector}`);
    error.code = 'VISIBLE_SELECTOR_TIMEOUT';
    throw error;
}

async function makeReservation(page, reservation) {
    const { category, timeslot } = reservation;
    console.log(`\nMaking reservation: ${category} at ${timeslot}`);

    const dateStr = getReservationDateString();
    await ensureActivitiesPage(page);
    await applyFilters(page, category, dateStr);
    const dateHeader = await openReservationDetails(page, category, timeslot, dateStr);
    await confirmReservation(page);

    console.log(`Successfully booked: ${category} at ${timeslot} on ${dateStr} (${dateHeader})`);
}

async function ensureActivitiesPage(page) {
    const modalCloseSelector = '[data-test-id="secondary-button-close-modal"], [data-test-id="button-close-modal"], [data-test-id="details-cancel-button"]';
    const closeButton = await findVisibleElement(page, modalCloseSelector).catch(() => null);
    if (closeButton) {
        await closeButton.click();
        await page.waitForFunction(selector => !Array.from(document.querySelectorAll(selector)).some(button => {
            const style = window.getComputedStyle(button);
            const rect = button.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        }), { timeout: 5_000 }, modalCloseSelector);
    }

    const filterButton = await findVisibleElement(page, '[data-test-id="open-tag-selection-filter"]').catch(() => null);
    if (filterButton) {
        await filterButton.dispose().catch(() => {});
        return;
    }

    await page.goto(ACTIVITIES_URL, { waitUntil: 'networkidle2', timeout: AUTH_TIMEOUT_MS });
    await waitForPortalReady(page);
}

async function openReservationDetails(page, category, timeslot, dateStr) {
    const expectedDateHeaders = getExpectedDateHeaders(dateStr);

    try {
        await page.waitForFunction(expectedHeaders => {
            const header = document.querySelector('#activitiesList > h2.date-header');
            const normalizedHeader = header?.textContent
                ?.toUpperCase()
                .replace(/[.,]/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            return Boolean(normalizedHeader && expectedHeaders.includes(normalizedHeader));
        }, { timeout: 15_000, polling: 100 }, expectedDateHeaders);
    } catch {
        const renderedHeader = await page.$eval('#activitiesList > h2.date-header', element =>
            element.textContent.trim().replace(/\s+/g, ' ')).catch(() => 'none');
        throw new Error(`Activity list did not update to ${dateStr}; first rendered date section is ${renderedHeader}.`);
    }

    const result = await page.evaluate(({ categoryName, time, expectedHeaders }) => {
        const list = document.querySelector('#activitiesList');
        if (!list) return { found: false, dateHeader: null };

        const children = Array.from(list.children);
        const firstHeaderIndex = children.findIndex(element => element.matches('h2.date-header'));
        if (firstHeaderIndex < 0) return { found: false, dateHeader: null };

        const nextHeaderIndex = children.findIndex((element, index) =>
            index > firstHeaderIndex && element.matches('h2.date-header'));
        const endIndex = nextHeaderIndex < 0 ? children.length : nextHeaderIndex;
        const dateHeader = children[firstHeaderIndex].textContent.trim().replace(/\s+/g, ' ');
        const normalizedDateHeader = dateHeader.toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
        if (!expectedHeaders.includes(normalizedDateHeader)) return { found: false, dateHeader };

        for (const card of children.slice(firstHeaderIndex + 1, endIndex)) {
            const timeElement = card.querySelector?.('[data-test-id="activities-list-item-start-time"]');
            const categoryElement = card.querySelector?.('[data-test-id="activities-list-item-resource-product-translation"]');
            if (timeElement?.textContent?.trim() === time && categoryElement?.textContent?.trim() === categoryName) {
                timeElement.click();
                return { found: true, dateHeader };
            }
        }

        return { found: false, dateHeader };
    }, { categoryName: category, time: timeslot, expectedHeaders: expectedDateHeaders });

    if (!result.found) {
        throw new Error(`No ${timeslot} slot found for ${dateStr} in the first rendered date section (${result.dateHeader || 'unknown date'}).`);
    }

    await waitForVisibleElement(page, '[data-test-id="details-book-button"]', 15_000);
    return result.dateHeader;
}

function getExpectedDateHeaders(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid reservation date: ${dateStr}`);

    const options = { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' };
    const englishWeekdays = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const englishMonths = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const candidates = [
        new Intl.DateTimeFormat('nl-NL', options).format(date),
        new Intl.DateTimeFormat('en-GB', options).format(date),
        new Intl.DateTimeFormat('en-US', options).format(date),
        `${englishWeekdays[date.getUTCDay()]} ${date.getUTCDate()} ${englishMonths[date.getUTCMonth()]}`
    ];

    return [...new Set(candidates.map(value => value
        .toUpperCase()
        .replace(/[.,]/g, '')
        .replace(/\s+/g, ' ')
        .trim()))];
}

async function confirmReservation(page) {
    const bookButton = await waitForVisibleElement(page, '[data-test-id="details-book-button"]', 5_000);
    const canBook = await bookButton.evaluate(button =>
        !button.disabled && button.getAttribute('aria-disabled') !== 'true');
    if (!canBook) throw new Error('The selected slot is not bookable.');

    const participationResponse = page.waitForResponse(response => {
        try {
            const url = new URL(response.url());
            return response.request().method() === 'POST' && url.pathname.endsWith('/participations');
        } catch {
            return false;
        }
    }, { timeout: 20_000 });

    const [response] = await Promise.all([participationResponse, bookButton.click()]);
    if (response.status() < 200 || response.status() >= 300) {
        throw new Error(`Reservation request failed with HTTP ${response.status()}.`);
    }

    const outcomeHandle = await page.waitForFunction(() => {
        const isVisible = element => {
            if (!element) return false;
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };

        if (isVisible(document.querySelector('[data-test-id="booking-success"]'))) return 'success';
        if (isVisible(document.querySelector('.modal-footer .modal-alert.alert-danger[role="alert"]'))) return 'error';
        if (isVisible(document.querySelector('[data-test-id="error-message-on-resource-selection"]'))) return 'error';
        return false;
    }, { timeout: 15_000, polling: 100 });

    const outcome = await outcomeHandle.jsonValue();
    await outcomeHandle.dispose();
    if (outcome !== 'success') throw new Error('The sports portal rejected the reservation.');

    const closeButton = await waitForVisibleElement(
        page,
        '[data-test-id="secondary-button-close-modal"], [data-test-id="button-close-modal"]',
        5_000
    );
    await closeButton.click();
    await page.waitForFunction(() => !document.querySelector('[data-test-id="booking-success"]'), { timeout: 5_000 });
}

async function applyFilters(page, category, dateStr) {
    const openFilterButton = await waitForVisibleElement(page, '[data-test-id="open-tag-selection-filter"]');
    await openFilterButton.click();
    await clearAndType(page, '[data-test-id="tag-filter-input"]', category);

    const tagSelection = await page.evaluate(cat => {
        const labels = document.querySelectorAll('[data-test-id="selectable-tag-description"]');
        const targetLabel = Array.from(labels).find(element => element.textContent.trim() === cat);
        const showButton = document.querySelector('[data-test-id="discovery-area-show-button"]');
        if (!targetLabel || !showButton) {
            return { tagFound: Boolean(targetLabel), showButtonFound: Boolean(showButton) };
        }

        targetLabel.click();
        showButton.click();
        return { tagFound: true, showButtonFound: true };
    }, category);

    if (!tagSelection.tagFound) throw new Error(`Reservation category not found: ${category}`);
    if (!tagSelection.showButtonFound) throw new Error('Filter confirmation button not found.');

    await page.waitForNetworkIdle({ timeout: 15_000 });

    const dateWasSet = await page.evaluate(date => {
        const input = document.querySelector('input[type="date"]');
        if (!input) return false;
        input.value = date;
        ['input', 'change'].forEach(eventName => {
            input.dispatchEvent(new Event(eventName, { bubbles: true }));
        });
        return input.value === date;
    }, dateStr);

    if (!dateWasSet) throw new Error(`Could not set reservation date to ${dateStr}.`);
    await page.waitForNetworkIdle({ timeout: 15_000 });
    await waitForVisibleElement(page, '#activitiesList > h2.date-header', 15_000);
    console.log(`Filters applied: ${category}, ${dateStr}`);
}

async function clearAndType(page, selector, text) {
    const input = await waitForVisibleElement(page, selector);
    await input.click({ clickCount: 3 });
    await input.type(String(text));
}

async function waitUntilReservationsOpen() {
    const target = new Date();
    target.setHours(RESERVATION_OPENS_AT_HOUR, RESERVATION_OPENS_AT_MINUTE, 0, 0);
    
    const now = Date.now();
    const delay = target.getTime() - now;

    if (delay <= 0) {
        console.log('Reservation window already open. Proceeding immediately.');
        return;
    }

    console.log(`Waiting ${Math.round(delay / 1000)}s until reservations open at ${target.toLocaleTimeString()}...`);
    await sleep(delay);
    console.log('Reservation window is now open!');
}

async function captureFailureScreenshot(page, error) {
    console.error('Error during reservation:', sanitizeLogText(error.message));
    if (error.stack) console.error(sanitizeLogText(error.stack));

    const timestamp = Date.now();
    const screenshotPath = `/tmp/failure-${timestamp}.png`;

    // Never let a screenshot problem replace the actual failure in the logs
    try {
        await page.screenshot({ path: screenshotPath, optimizeForSpeed: true });
        await uploadArtifact(screenshotPath, `screenshot-${timestamp}.png`, 'image/png');
    } catch (screenshotError) {
        console.error('Could not capture failure screenshot:', sanitizeLogText(screenshotError.message));
    }
}

function sanitizeUrl(rawUrl, baseUrl) {
    if (!rawUrl) return '(none)';
    try {
        const url = new URL(rawUrl, baseUrl);
        return `${url.origin}${url.pathname}`;
    } catch {
        return '[invalid URL]';
    }
}

function sanitizeLogText(value) {
    return String(value).replace(/https?:\/\/[^\s"'<>]+/g, rawUrl => sanitizeUrl(rawUrl));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

// ============================================================================
// RESERVATION CONFIGURATION
// ============================================================================
// Each reservation will be made at 8:00 AM exactly 7 days before the slot.
// dayOfWeek: 0 = Sunday, 1 = Monday, ..., 6 = Saturday
// ============================================================================
const RESERVATIONS = [
    { category: 'Sauna', timeslot: '20:15', dayOfWeek: 1 },  // mon 

];

const RESERVATION_OPENS_AT_HOUR = 8;
const RESERVATION_OPENS_AT_MINUTE = 0;
const DAYS_IN_ADVANCE = 7;

async function uploadArtifact(filePath, destFileName, mimeType) {
    console.log(`[STORAGE] Starting upload of ${destFileName} from ${filePath}`);

    await storage.bucket(BUCKET_NAME).upload(filePath, {
        destination: `debug_logs/${destFileName}`, // Uploads to a 'debug_logs' folder
        metadata: { contentType: mimeType },
    });
    console.log(`[STORAGE] Successfully uploaded: gs://${BUCKET_NAME}/debug_logs/${destFileName}`);
}

setGlobalOptions({ maxInstances: 1 });

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

    const TOTP_SECRET = await accessSecret("TOTP_SECRET");
    const GYM_USERNAME = await accessSecret("GYM_USERNAME");
    const GYM_PASSWORD = await accessSecret("GYM_PASSWORD");

    const browser = await launchBrowser();
    const page = await browser.newPage();
    await page.emulateTimezone('Europe/Amsterdam');
    setupNetworkLogging(page);

    try {
        await loginToSportsPortal(page, GYM_USERNAME, GYM_PASSWORD, TOTP_SECRET);
        
        // Wait once for reservations to open, then book all slots
        await waitUntilReservationsOpen();
        
        for (const reservation of todaysReservations) {
            await makeReservation(page, reservation);
        }

        console.log('All reservations completed successfully.');
    } catch (error) {
        await captureFailureScreenshot(page, error);
    } finally {
        await browser.close();
    }
})

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
    return puppeteer.launch({
        args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: true,
        ignoreHTTPSErrors: true
    });
}

function setupNetworkLogging(page) {
    page.on('response', response => {
        const status = response.status();
        const url = response.url();
        const headers = response.headers();

        if (status >= 300 && status < 400) {
            console.warn(`[NETWORK:REDIRECT] Status ${status} | From: ${url} | To: ${headers.location}`);
        } else if (url.includes('login.microsoftonline.com') && status !== 200) {
            console.error(`[NETWORK:MSFT_ERROR] Status ${status} | URL: ${url}`);
        } else if (status >= 400) {
            console.error(`[NETWORK:HTTP_ERROR] Status ${status} | URL: ${url}`);
        }
    });
}

async function loginToSportsPortal(page, username, password, totpSecret) {
    console.log('Logging in to sports portal...');
    
    await page.goto('https://tilburguniversity.sports.delcom.nl/pages/login', { waitUntil: 'networkidle2' });
    await page.click('[data-test-id="oidc-login-button"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    
    await page.click('[data-title="Tilburg University"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    
    await page.type('input[name="loginfmt"]', username);
    await page.click('input[type="submit"]');

    await page.waitForSelector('input[name="password"]', { visible: true });
    await page.type('input[name="password"]', password);
    await page.click('input[type="submit"]');

    await page.waitForSelector('input[name="otc"]', { visible: true });
    await page.type('input[name="otc"]', authenticator.generate(totpSecret));
    await page.click('input[type="submit"]');
    
    await page.waitForNavigation({ waitUntil: 'networkidle2' });

    // Handle optional consent step
    await page.click('button[type="submit"]')
        .then(() => page.waitForNavigation({ waitUntil: 'networkidle2' }))
        .catch(() => console.log('No consent step needed'));

    console.log('Login successful. Current URL:', page.url());
}

async function makeReservation(page, reservation) {
    const { category, timeslot } = reservation;
    console.log(`\nMaking reservation: ${category} at ${timeslot}`);

    // Set the date to 7 days from now
    const dateStr = getReservationDateString();

    // Navigate to reservation page and apply filters
    await applyFilters(page, category, dateStr);

    // Select the timeslot
    const slotSelector = 'div[data-test-id="bookable-slot-list-item"]';
    await page.waitForSelector(slotSelector, { timeout: 10000 });
    
    await page.evaluate((time) => {
        const slots = document.querySelectorAll('div[data-test-id="bookable-slot-list-item"]');
        for (const slot of slots) {
            const timeElement = slot.querySelector('p[data-test-id="bookable-slot-start-time"] strong');
            if (timeElement?.textContent?.trim() === time) {
                timeElement.click();
                break;
            }
        }
    }, timeslot);
    await page.waitForNetworkIdle({ timeout: 15000 });

    // Click the book button
    await page.waitForSelector('button[data-test-id="details-book-button"]', { visible: true, timeout: 5000 });
    await page.click('button[data-test-id="details-book-button"]');
    await page.waitForNetworkIdle({ timeout: 15000 });

    console.log(`Successfully booked: ${category} at ${timeslot} on ${dateStr}`);
}

async function applyFilters(page, category, dateStr) {
    await page.waitForSelector('#tag-filterinput', { visible: true });
    await clearAndType(page, '#tag-filterinput', category);

    await page.evaluate((cat) => {
        const labels = document.querySelectorAll('label');
        const targetLabel = Array.from(labels).find(el => el.textContent.trim() === cat);
        if (targetLabel) targetLabel.click();
    }, category);

    await sleep(2000);

    await page.evaluate((date) => {
        const input = document.querySelector('input[type="date"]');
        input.value = date;
        ['input', 'change'].forEach(event => {
            input.dispatchEvent(new Event(event, { bubbles: true }));
        });
    }, dateStr);
    
    await sleep(1000);
    console.log(`Filters applied: ${category}, ${dateStr}`);
}

async function clearAndType(page, selector, text) {
    await page.click(selector, { clickCount: 3 }); // Select all existing text
    await page.type(selector, text);
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
    console.error("Error during reservation:", error.message);

    const timestamp = Date.now();
    const screenshotPath = `/tmp/failure-${timestamp}.png`;
    
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await uploadArtifact(screenshotPath, `screenshot-${timestamp}.png`, 'image/png');

    console.error('Full error:', error);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
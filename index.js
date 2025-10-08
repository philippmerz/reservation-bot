const {onSchedule} = require("firebase-functions/v2/scheduler");
const {setGlobalOptions} = require("firebase-functions");
const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const {authenticator} = require("otplib"); // Your OTP library
const {SecretManagerServiceClient} = require("@google-cloud/secret-manager");
const {Storage} = require('@google-cloud/storage');

const storage = new Storage();
const BUCKET_NAME = 'reservation-bot-8e993.firebasestorage.app';

async function uploadArtifact(filePath, destFileName, mimeType) {
    console.log(`[STORAGE] Starting upload of ${destFileName} from ${filePath}`);

    await storage.bucket(BUCKET_NAME).upload(filePath, {
        destination: `debug_logs/${destFileName}`, // Uploads to a 'debug_logs' folder
        metadata: {contentType: mimeType},
    });
    console.log(`[STORAGE] Successfully uploaded: gs://${BUCKET_NAME}/debug_logs/${destFileName}`);
}

setGlobalOptions({maxInstances: 1});

// Initialize Secret Manager client
const client = new SecretManagerServiceClient();

async function accessSecret(secretName) {
    const [version] = await client.accessSecretVersion({
        name: `projects/576703361007/secrets/${secretName}/versions/latest`
    });
    return version.payload.data.toString("utf8");
}

// Export your scheduled function
exports.yourWeeklyBot = onSchedule({
    schedule: "0 6 * * 1",
    timeZone: "UTC",
    memory: "1GiB",
    timeoutSeconds: 600
}, async (event) => {
    const TOTP_SECRET = await accessSecret("TOTP_SECRET");
    const GYM_USERNAME = await accessSecret("GYM_USERNAME");
    const GYM_PASSWORD = await accessSecret("GYM_PASSWORD");

    const CATEGORY = 'Sauna';
    const TIMESLOT = '18:15';
    const DEV = false;

    // Launch headless Chrome
    const browser = await puppeteer.launch({
        args: [...chromium.args, "--no-sandbox", "--disable-setuid-sandbox"],
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: !DEV, devtools: DEV,
        ignoreHTTPSErrors: true
    });
    const page = await browser.newPage();

    try {

        // Login
        await page.goto('https://tilburguniversity.sports.delcom.nl/pages/login', {waitUntil: 'networkidle2'});
        await page.click('[data-test-id="oidc-login-button"]');
        await page.waitForNavigation({waitUntil: 'networkidle2'});
        await page.click('[data-title="Tilburg University"]');
        await page.waitForNavigation({waitUntil: 'networkidle2'});
        await page.type('input[name="loginfmt"]', GYM_USERNAME);
        await page.click('input[type="submit"]');

        await page.waitForSelector('input[name="password"]', {visible: true});
        await page.type('input[name="password"]', GYM_PASSWORD);
        await page.click('input[type="submit"]');

        await page.waitForSelector('input[name="otc"]', {visible: true});
        console.log('before', Date.now());
        await page.type('input[name="otc"]', authenticator.generate(TOTP_SECRET));
        await page.click('input[type="submit"]');
        console.log('after', Date.now());
        page.on('response', response => {
            const status = response.status();
            const url = response.url();
            const headers = response.headers();

            if (status >= 300 && status < 400) {
                // Log the entire redirect chain and the 'Location' header
                console.warn(`[NETWORK:REDIRECT] Status ${status} | From: ${url} | To: ${headers.location}`);
            } else if (url.includes('login.microsoftonline.com') && status !== 200) {
                // Highlight status codes other than 200 on the target domain
                console.error(`[NETWORK:MSFT_ERROR] Status ${status} | URL: ${url}`);
            } else if (status >= 400) {
                // Log all other client/server errors
                console.error(`[NETWORK:HTTP_ERROR] Status ${status} | URL: ${url}`);
            }
        });
        await page.waitForNavigation({waitUntil: 'networkidle2'});

        // log current url
        const currentUrl = page.url();
        console.error(`Current URL at error time: ${currentUrl}`);


        await page.click('button[type="submit"]').then(async () => {
                await page.waitForNavigation({waitUntil: 'networkidle2'})
            }
        ).catch(() => console.log('No consent step'));

        // Reserve
        await page.waitForSelector('#tag-filterinput', {visible: true});
        await page.type('#tag-filterinput', CATEGORY);

        await page.evaluate((category) => {
            const labels = document.querySelectorAll('label');
            const targetLabel = Array.from(labels).find(el => el.textContent.trim() === category);
            if (targetLabel)
                targetLabel.click();
        }, CATEGORY);

        await new Promise(resolve => setTimeout(resolve, 5000))
        const now = new Date();
        const nextWeek = new Date(now);
        nextWeek.setDate(nextWeek.getDate() + 7);
        const dateStr = nextWeek.toISOString().split('T')[0]; // YYYY-MM-DD

        await page.evaluate((dateStr) => {
            const input = document.querySelector('input[type="date"]')
            input.value = dateStr;
            ['input', 'change'].forEach(event => {
                input.dispatchEvent(new Event(event, {bubbles: true}));
            });
        }, dateStr)
        console.log('Date set to:', dateStr);

        const slotSelector = 'div[data-test-id="bookable-slot-list-item"] p[data-test-id="bookable-slot-start-time"]';
        await page.waitForSelector(slotSelector, {timeout: 10000});
        await page.evaluate((timeslot) => {
            const slots = document.querySelectorAll('div[data-test-id="bookable-slot-list-item"]');
            for (const slot of slots) {
                const time = slot.querySelector('p[data-test-id="bookable-slot-start-time"] strong');
                if (time?.textContent?.trim() === timeslot) {
                    console.log(time)
                    time.click();
                }
            }
        }, TIMESLOT);
        await page.waitForNetworkIdle({timeout: 15000})

        await page.waitForSelector('button[data-test-id="details-book-button"]', {visible: true, timeout: 5000});
        await page.click('button[data-test-id="details-book-button"]');
        await page.waitForNetworkIdle({timeout: 15000})

    } catch (error) {
        console.error("Navigation or Timeout Error:", error.message);

        const timestamp = Date.now();

        const screenshotPath = `/tmp/failure-${timestamp}.png`;
        await page.screenshot({path: screenshotPath, fullPage: true});
        await uploadArtifact(screenshotPath, `screenshot-${timestamp}.png`, 'image/png');

        console.error('Error:', error);
    } finally {
        await browser.close();
    }
})

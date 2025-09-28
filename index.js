const puppeteer = require('puppeteer');
const {authenticator} = require('otplib');

const CATEGORY = 'Fitness';
const TIMESLOT = '10:00';
const DEV = false;

(async () => {
    const browser = await puppeteer.launch({args: ['--no-sandbox'], headless: !DEV, devtools: DEV});
    const page = await browser.newPage();

    try {
        // Login
        await page.goto('https://tilburguniversity.sports.delcom.nl/pages/login', {waitUntil: 'networkidle2'});
        await page.click('[data-test-id="oidc-login-button"]');
        await page.waitForNavigation({waitUntil: 'networkidle2'});
        await page.click('[data-title="Tilburg University"]');
        await page.waitForNavigation({waitUntil: 'networkidle2'});
        await page.type('input[name="loginfmt"]', process.env.GYM_USERNAME);
        await page.click('input[type="submit"]');

        await page.waitForSelector('input[name="password"]', {visible: true});
        await page.type('input[name="password"]', process.env.GYM_PASSWORD);
        await page.click('input[type="submit"]');

        await page.waitForSelector('input[name="otc"]', {visible: true});
        await page.type('input[name="otc"]', authenticator.generate(process.env.TOTP_SECRET));
        await page.click('input[type="submit"]');
        await page.waitForNavigation({waitUntil: 'networkidle2'});

        await page.click('button[type="submit"]').then(async () => {
                await page.waitForNavigation({waitUntil: 'networkidle2'})
            }
        ).catch(() => console.log('No consent step'));

        // Reserve
        await page.waitForSelector('#tag-filterinput', {visible: true});
        await page.type('#tag-filterinput', CATEGORY);

        await page.evaluate((category) => {
            const labels = document.querySelectorAll('label');
            const saunaLabel = Array.from(labels).find(el => el.textContent.trim() === category);
            if (saunaLabel)
                saunaLabel.click();
        }, CATEGORY);

        await new Promise(resolve => setTimeout(resolve, 5000))
        const now = new Date();
        const nextMonday = new Date(now);
        nextMonday.setDate(nextMonday.getDate() + (((1 + 7 - nextMonday.getDay()) % 7) || 7));
        const dateStr = nextMonday.toISOString().split('T')[0]; // YYYY-MM-DD

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
        console.error('Error:', error);
    } finally {
        await browser.close();
    }
})
();
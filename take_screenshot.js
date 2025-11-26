const playwright = require('playwright');

(async () => {
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  await page.goto('https://8080-i05fg3osdbz0ztjj1dh63-dfc00ec5.sandbox.novita.ai', {
    waitUntil: 'networkidle',
    timeout: 30000
  });
  await page.screenshot({ path: 'screenshot.png', fullPage: true });
  console.log('Screenshot saved to screenshot.png');
  await browser.close();
})();

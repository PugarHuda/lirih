import { test, expect } from '@playwright/test';
import { injectWallet } from './wallet';

// The write path, in a real browser, against real Sepolia. This SPENDS GAS, so
// it is opt-in:
//
//   WALLET_KEY=0x… npx playwright test donate.spec
//
// Without WALLET_KEY it skips, because a test suite that silently drains a
// faucet wallet on every run is a worse problem than an untested write path.
//
// What it is for: the four transactions before a donation, and the donation
// itself, are where this project's real bugs lived. setOperator was granted an
// hour from the BROWSER's clock while the contract compares against
// block.timestamp — a slow clock meant an authorisation that had already expired
// and a `contribute` that failed two steps later with nothing pointing at the
// cause. Read-only assertions cannot reach that. Only actually doing it can.

const KEY = process.env.WALLET_KEY;
const RPC = process.env.NEXT_PUBLIC_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const BASE = process.env.BASE ?? 'https://lirih.vercel.app';

test.describe('donor path with a signing wallet', () => {
  test.skip(!KEY, 'set WALLET_KEY to run — this spends real Sepolia gas');
  // Five transactions, each waiting for its receipt, plus two gateway round
  // trips. The default timeout is nowhere near enough and a timeout here would
  // read as a product failure rather than a slow chain.
  test.setTimeout(15 * 60_000);

  test('mints, wraps, authorises and donates — all of it on-chain', async ({ page }) => {
    const address = await injectWallet(page, KEY!, RPC);
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));

    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });

    // Only meaningful against an OPEN round; against a closed one the buttons
    // are correctly disabled and there is nothing to exercise.
    const results = page.locator('h2', { hasText: 'Results' });
    await expect(results).toContainText(/(Contribution|Tallied|Allocated|Settled)/, { timeout: 30_000 });
    const phase = (await results.textContent())!.match(/(Contribution|Tallied|Allocated|Settled)/)![1];
    test.skip(phase !== 'Contribution', `round is ${phase}; nothing to donate to`);

    // Small on purpose: this is proving the path works, not moving weight.
    await page.getByLabel(/Amount/).fill('1');

    await page.getByRole('button', { name: /Faucet \+ wrap/ }).click();
    // The last of the four is the one that used to be granted against the
    // browser's clock. If it expires before `contribute` lands, the failure
    // appears two steps later and looks like something else entirely.
    await expect(page.getByText('ready to donate')).toBeVisible({ timeout: 8 * 60_000 });

    await page.getByRole('button', { name: /Donate \(encrypted\)/ }).click();
    await expect(page.getByText(/your amount is encrypted on-chain/)).toBeVisible({ timeout: 6 * 60_000 });

    // No Snap in this browser, so the EOA holds the viewing role — and the page
    // has to SAY so rather than let the strongest claim in the project pass
    // silently. This is the assertion that would have caught a page which
    // quietly downgraded and still called itself coercion-resistant.
    await expect(page.getByText(/Snap not installed/)).toBeVisible();
    await expect(page.getByText(/not coercion-resistant/)).toBeVisible();

    // Five transactions, five links. The list is how a donor checks what their
    // wallet actually did.
    const links = page.locator('ul.steps li a');
    await expect(links).toHaveCount(5);

    // And the donation is readable by its own donor, and by nobody else.
    await page.getByRole('button', { name: 'Decrypt my contribution' }).click();
    await expect(page.getByText(/Your contribution to project/)).toBeVisible({ timeout: 3 * 60_000 });

    expect(problems, 'no unhandled errors during the write path').toEqual([]);
    console.log(`donated from ${address}`);
  });
});

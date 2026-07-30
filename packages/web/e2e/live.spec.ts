import { test, expect, type Page } from '@playwright/test';

// Browser tests against the DEPLOYED page and the LIVE Sepolia round.
//
// This is the gap that stayed open longest in this project: `tsc` was clean,
// `next build` was clean, and neither catches what a browser does. The bug that
// proved it was a barrel import pulling in `ethers` — a peer dependency with an
// exports map that only exposes ".", so the deep import resolved at type-check
// time and threw `Module not found` at runtime. Everything below would have
// failed on that, and nothing else did.
//
// No wallet here. Everything asserted is what a visitor sees BEFORE connecting,
// which is also the part that has to be right for anyone to get as far as
// connecting: the page reads chain state, decides what is possible, and says so.
// Signing is MetaMask's, and mocking it would only test the mock.
//
//   BASE=https://lirih.vercel.app npx playwright test        (deployed)
//   BASE=http://localhost:3000    npx playwright test        (local dev)

const BASE = process.env.BASE ?? 'https://lirih.vercel.app';

/// The app is a dashboard: panels live behind sidebar nav rather than one long
/// scroll, so a test that wants a panel has to open it the way a visitor would.
async function open(page: Page, label: string) {
  const item = page.locator('nav.sidenav').getByRole('button', { name: label });
  await item.click();
  // React may not have hydrated when the click lands, in which case nothing
  // happens and the assertion that follows fails 30s later against the wrong
  // panel. Waiting for aria-current to move proves the switch actually took.
  await expect(item).toHaveAttribute('aria-current', 'page', { timeout: 30_000 });
}

/// Fail on the failures a page hides. An unhandled rejection or a React error
/// leaves the UI looking merely empty, which is exactly how the swallowed
/// `refresh().catch(() => {})` bug presented before it was found.
function watchForCrashes(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  return problems;
}

test('renders, and reads the live round from chain', async ({ page }) => {
  const problems = watchForCrashes(page);
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await open(page, 'Results');

  // The phase comes from an eth_call against the configured round. If the RPC,
  // the address or the ABI were wrong this stays undefined forever — which is a
  // far more likely failure than a rendering one, and invisible to a build.
  // The phase renders as a pill next to the heading — text, not a colour, so
  // it survives a restyle and is readable to a screen reader.
  const results = page.locator('h2', { hasText: 'Results' });
  await expect(results).toContainText(/(Contribution|Tallied|Allocated|Settled)/, {
    timeout: 30_000,
  });

  // Project names are stored ON-CHAIN precisely so a passing test cannot be
  // satisfied by a hardcoded label map in the frontend. Scoped to the results
  // TABLE: the picker lists the same names, and matching either would let a
  // hardcoded option satisfy an assertion about chain state.
  const table = page.locator('table');
  await expect(table.getByText('Clean Water Initiative')).toBeVisible();
  await expect(table.getByText('Open Source Maintainers')).toBeVisible();

  expect(problems, 'page must load with no errors').toEqual([]);
});

test('gates the donor path on the round phase, and never spends gas it cannot use', async ({ page }) => {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await open(page, 'Results');
  const results = page.locator('h2', { hasText: 'Results' });
  await expect(results).toContainText(/(Contribution|Tallied|Allocated|Settled)/, { timeout: 30_000 });

  const phase = (await results.textContent())!.match(/(Contribution|Tallied|Allocated|Settled)/)![1];
  await open(page, 'Donate');
  const faucet = page.getByRole('button', { name: /Faucet \+ wrap/ });
  const donate = page.getByRole('button', { name: /Donate \(encrypted\)/ });
  const closed = page.getByText(/This round is closed to new donations/);

  if (phase === 'Contribution') {
    // Open: both donor steps must be reachable, and so must the pool top-up,
    // which is the button that makes "the matching pool can be crowdfunded" a
    // thing a visitor can do rather than a sentence in the README.
    await expect(faucet).toBeEnabled();
    await expect(donate).toBeEnabled();
    await expect(page.getByRole('button', { name: /Fund the matching pool/ })).toBeVisible();
    await expect(closed).toHaveCount(0);
  } else {
    // Closed: the whole point of the phase read. Before it existed, a visitor
    // could run mint -> approve -> wrap -> setOperator — four real transactions,
    // real gas — and only then hit a raw WrongPhase revert on the fifth.
    await expect(faucet).toBeDisabled();
    await expect(donate).toBeDisabled();
    await expect(closed).toBeVisible();
  }
});

test('warns before a donation exceeds the matching-weight cap', async ({ page }) => {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });

  // Under the cap: no warning, or it would be noise on every normal donation.
  await expect(page.getByText(/matching weight is capped/i)).toHaveCount(0);

  // Over it: the sqrt input is clamped at 1e24, so weight stops growing while
  // the money still moves. A donor who is not told reads that as a bug.
  await page.getByLabel(/Amount/).fill('2000000');
  await expect(page.getByText(/matching weight is capped at 1,000,000 mUSDC/i)).toBeVisible();
});

test('lets anyone push the round forward, exactly when that is possible', async ({ page }) => {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await open(page, 'Results');
  const results = page.locator('h2', { hasText: 'Results' });
  await expect(results).toContainText(/(Contribution|Tallied|Allocated|Settled)/, { timeout: 30_000 });
  const phase = (await results.textContent())!.match(/(Contribution|Tallied|Allocated|Settled)/)![1];

  const panel = page.getByText('Advance the round — anyone can do this');
  if (phase === 'Settled') {
    await expect(panel).toHaveCount(0); // nothing left to advance
    return;
  }

  // The permissionless pipeline is the answer to "what if the organiser walks
  // away", so it has to be visible, not just present in the contract.
  await expect(panel).toBeVisible();
  const advance = page.getByRole('button', { name: /Finalize tally|Compute allocations|Reveal & settle/ });
  await expect(advance).toBeVisible();
  // Before the deadline the contract would revert DeadlineNotReached, so the
  // page must refuse rather than offer a transaction that cannot succeed.
  if (phase === 'Contribution') await expect(advance).toBeDisabled();
});

test('the landing page stands on its own, and its numbers come from chain', async ({ page }) => {
  const problems = watchForCrashes(page);
  await page.goto(BASE, { waitUntil: 'networkidle' });

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  // The headline figures are read from a settled deployment rather than typed
  // into the page. A landing page that hardcodes its own metrics is a
  // screenshot, and this project's entire argument is that you can check it.
  await expect(page.locator('.stat, table').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('—', { exact: true })).toHaveCount(0, { timeout: 30_000 });

  // The one job of a landing page is to get you into the app.
  await page.getByRole('button', { name: 'Open the app' }).first().click();
  await expect(page).toHaveURL(/\/app$/);

  expect(problems, 'landing must load with no errors').toEqual([]);
});

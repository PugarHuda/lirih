import type { Page } from '@playwright/test';
import { Wallet, JsonRpcProvider } from 'ethers';

// A real signing wallet injected as `window.ethereum`, so a browser test can do
// the things that actually cost gas.
//
// Everything else in this suite deliberately stops at the wallet boundary, and
// that leaves the most important half untested: the four transactions before a
// donation, and the donation itself. Those are where this project's real bugs
// lived — setOperator granted against the BROWSER's clock and expiring before it
// was mined; an encryption path whose proof was bound to the wrong identity. No
// amount of read-only assertion reaches either.
//
// This is not a mock of MetaMask. It is an EIP-1193 provider backed by an ethers
// Wallet: the transactions are signed for real, broadcast for real, and mined on
// real Sepolia. What it does not reproduce is MetaMask's UI and its own RPC
// restrictions — notably that `eth_signTypedData_v4` is blocked for Snaps, which
// is the constraint that put the viewing key in the Snap in the first place. So
// this closes the write path, not the Snap path; loading the Snap in Flask is
// still a human's job.

const SEPOLIA_HEX = '0xaa36a7';

export async function injectWallet(page: Page, privateKey: string, rpcUrl: string) {
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);

  await page.exposeFunction('__walletRequest', async (req: { method: string; params?: any[] }) => {
    const { method, params = [] } = req;
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [wallet.address];
      case 'eth_chainId':
        return SEPOLIA_HEX;
      // The page's chain guard offers to switch networks. We are already on
      // Sepolia, so acknowledge and change nothing.
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        return null;
      // Snap methods are deliberately unimplemented: a test that pretended a
      // Snap was installed would assert the strongest claim in the project
      // against something that is not a Snap. The page falls back to the EOA
      // viewer and labels the donation as not coercion-resistant, which is the
      // truthful outcome for a browser with no Snap.
      case 'wallet_requestSnaps':
      case 'wallet_invokeSnap':
        throw new Error('no Snap in this browser');
      case 'eth_sendTransaction': {
        const t = params[0];
        const sent = await wallet.sendTransaction({
          to: t.to,
          data: t.data,
          value: t.value ? BigInt(t.value) : undefined,
          // Let ethers estimate. The app never sets a gas limit, and guessing one
          // here would test the guess.
        });
        return sent.hash;
      }
      // Required by the Nox handle client to authenticate to the gateway. Note
      // the argument order: address first, then a JSON string.
      case 'eth_signTypedData_v4': {
        const typed = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1];
        const { EIP712Domain, ...types } = typed.types;
        return wallet.signTypedData(typed.domain, types, typed.message);
      }
      case 'personal_sign':
        return wallet.signMessage(
          typeof params[0] === 'string' && params[0].startsWith('0x')
            ? Buffer.from(params[0].slice(2), 'hex')
            : params[0],
        );
      default:
        return provider.send(method, params);
    }
  });

  // Installed before any page script runs, so the app sees a wallet on first
  // render rather than after a reload.
  await page.addInitScript(() => {
    const w = window as any;
    w.ethereum = {
      isMetaMask: true,
      request: (args: any) => w.__walletRequest(args),
      on: () => {},
      removeListener: () => {},
    };
  });

  return wallet.address as `0x${string}`;
}

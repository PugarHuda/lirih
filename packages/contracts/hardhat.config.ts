import { defineConfig } from 'hardhat/config';
import hardhatToolboxViemPlugin from '@nomicfoundation/hardhat-toolbox-viem';
import noxPlugin from '@iexec-nox/nox-hardhat-plugin';

// ponytail: Node built-in, no dotenv dependency. Absent .env is fine (CI/local
// edr runs need no key) — only the sepolia network reads these.
try { process.loadEnvFile(new URL('.env', import.meta.url)); } catch {}

// ponytail: single ephemeral-stack network for now; add an `http` Sepolia
// network with nox.noxComputeAddress once we deploy against the live gateway.
export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, noxPlugin],
  solidity: '0.8.35',
  networks: {
    default: {
      type: 'edr-simulated',
      chainType: 'op', // required by the Nox plugin
      allowUnlimitedContractSize: true,
    },
    sepolia: {
      type: 'http',
      chainType: 'op',
      url: process.env.SEPOLIA_RPC_URL ?? 'https://sepolia.drpc.org',
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      // Sepolia base fee sits under 1 gwei and the network is not congested, so
      // the tip only has to be non-zero to be included. The default priority fee
      // overpaid ~4x and burned the faucet budget; even 1 gwei roughly DOUBLED
      // the effective price against a ~0.95 gwei base. A contribute is 2.6M gas,
      // so this multiplier is the single biggest lever on total spend.
      // Raise it if transactions start sitting in the mempool.
      maxPriorityFeePerGas: 20_000_000n, // 0.02 gwei
      maxFeePerGas: 3_000_000_000n,      // 3 gwei ceiling (base can spike)
      // live Nox on Ethereum Sepolia — verified 2026-07-22
      nox: {
        noxComputeAddress: '0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF',
        handleGatewayUrl: 'https://gateway-testnets.noxprotocol.dev',
      },
    },
  },
});

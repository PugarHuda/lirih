import './globals.css';

export const metadata = {
  title: 'Lirih — confidential quadratic funding',
  description:
    'Donations encrypted end to end, quadratic-funding weights computed inside a TEE, ' +
    'and only the final per-project allocation ever decrypted. Live on Ethereum Sepolia.',
};

// Declared so the browser never flashes a light default before the stylesheet
// lands, and so native form controls render dark instead of system-white.
export const viewport = { themeColor: '#020617', colorScheme: 'dark' as const };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

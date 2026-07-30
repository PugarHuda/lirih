import './globals.css';

export const metadata = {
  title: 'Lirih — confidential quadratic funding',
  description:
    'Donations encrypted end to end, quadratic-funding weights computed inside a TEE, ' +
    'and only the final per-project allocation ever decrypted. Live on Ethereum Sepolia.',
};

// Declared so the browser chrome matches the cream canvas and native form
// controls render light rather than inheriting a dark system preference.
export const viewport = { themeColor: '#fffdf5', colorScheme: 'light' as const };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

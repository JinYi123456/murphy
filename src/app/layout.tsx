import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Instrument_Serif } from 'next/font/google';
import './globals.css';

const plex = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

const serif = Instrument_Serif({
  subsets: ['latin'],
  weight: ['400'],
  style: ['normal'],
  variable: '--font-instrument-serif',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'MURPHY - procedural fuzzing for high-hazard operations',
  description:
    'Software has fuzzing. Operating procedures have nothing. MURPHY runs thousands of error-prone simulated crews through a maintenance or transfer procedure against a physics twin of the plant, in the browser or batched on a GPU, and proves which edits actually reduce failure before anyone touches the real one.',
  openGraph: {
    title: 'MURPHY - fuzz the procedure, not the plant',
    description:
      'Human reliability analysis, a process twin and a batched Monte-Carlo kernel, closed with a paired-statistics repair loop.',
    // 1600x900, drawn by scripts/poster.py from a real fuzz run rather than
    // illustrated, so the picture cannot disagree with what the app produces
    images: ['/cover.png'],
  },
};

export const viewport: Viewport = {
  themeColor: '#07080a',
  width: 'device-width',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plex.variable} ${serif.variable}`}>
      <body>{children}</body>
    </html>
  );
}

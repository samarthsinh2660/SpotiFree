import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Spotifree',
  description: 'Your Spotify playlists, played from YouTube.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

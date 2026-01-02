import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'WebRTC Live Streaming Test',
  description: 'Test implementation for WebRTC live streaming',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}









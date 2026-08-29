import { Inter, Space_Grotesk, Space_Mono, Plus_Jakarta_Sans } from 'next/font/google';

import { DevTools } from '@/components/dev-tools';
import { GlobalSearch } from '@/components/global-search';
import { GlobalSettingsButton } from '@/components/global-settings-button';
import { ServiceWorkerRegistration } from '@/components/service-worker-registration';
import { ThemeInitScript } from '@/components/theme-init';
import { Toaster } from '@/components/ui/toaster';
import { UpdateBanner } from '@/components/update-banner';

import type { Metadata, Viewport } from 'next';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-space-grotesk',
});

const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
  variable: '--font-space-mono',
});

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-plus-jakarta',
});

export const metadata: Metadata = {
  title: 'Beads',
  description: 'Kanban interface for beads - git-backed distributed issue tracker',
  // Makes Chrome offer "Install app": installed, Beads Web gets its own window
  // and its own taskbar icon instead of being one tab among thirty.
  manifest: '/manifest.json',
  applicationName: 'Beads',
  appleWebApp: { capable: true, title: 'Beads', statusBarStyle: 'black-translucent' },
  icons: {
    icon: [
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: '/icons/icon-192.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${inter.variable} ${spaceGrotesk.variable} ${spaceMono.variable} ${plusJakartaSans.variable}`} suppressHydrationWarning>
      <head>
        <ThemeInitScript />
      </head>
      <body className="flex min-h-screen flex-col bg-background antialiased transition-colors duration-300">
        <div className="flex-1">{children}</div>
        <GlobalSearch />
        <GlobalSettingsButton />
        <ServiceWorkerRegistration />
        <UpdateBanner />
        <DevTools />
        <Toaster />
      </body>
    </html>
  );
}

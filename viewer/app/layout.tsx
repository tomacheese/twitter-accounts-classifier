import type { Metadata } from 'next'
import Script from 'next/script'
import './globals.css'
import { SiteNav } from './components/site-nav'

// Applied before hydration so the very first paint already matches the
// user's stored choice — falling back to OS preference — instead of
// flashing light mode first.
const THEME_INIT_SCRIPT = `
(function () {
  var stored = localStorage.getItem('theme')
  var isDark = stored ? stored === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  document.documentElement.classList.toggle('dark', isDark)
})()
`

export const metadata: Metadata = {
  title: 'Labeling Results Viewer',
  description: 'Dashboard for Twitter account labeling results',
}

/**
 * Root layout for the viewer app. Renders the shared navigation bar around every page.
 * @param props - the page content to render inside the layout
 * @returns the HTML document shell with navigation
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}): React.ReactElement {
  return (
    <html lang="en">
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
      </head>
      <body className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
        <SiteNav />
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      </body>
    </html>
  )
}

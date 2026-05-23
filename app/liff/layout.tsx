/**
 * LIFF sub-layout — server component.
 *
 * Adds two performance hints that are emitted into <head> before the JS
 * bundle arrives on the client:
 *
 *  1. preconnect to LINE CDN + LINE API — eliminates DNS + TLS handshake
 *     time (~100–250 ms on mobile) before the SDK and token verify calls.
 *
 *  2. preload the LIFF SDK script — the browser starts downloading the
 *     ~200 KB SDK immediately, so by the time React hydrates and the
 *     dynamic script tag is created it may already be in cache.
 */
export default function LiffLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Establish connections to LINE infrastructure early */}
      <link rel="preconnect" href="https://static.line-scdn.net" crossOrigin="anonymous" />
      <link rel="preconnect" href="https://api.line.me" crossOrigin="anonymous" />
      <link rel="dns-prefetch" href="https://static.line-scdn.net" />
      <link rel="dns-prefetch" href="https://api.line.me" />

      {/* Preload the LIFF SDK so it's in cache when the dynamic script tag fires */}
      <link
        rel="preload"
        href="https://static.line-scdn.net/liff/edge/2/sdk.js"
        as="script"
        crossOrigin="anonymous"
      />

      {children}
    </>
  );
}

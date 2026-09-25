import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  devIndicators: false,
  async headers() {
    return [
      {
        // The OAuth consent screen. Clickjacking is the specific attack these
        // defend against: framed inside an attacker's page, "Allow access" can
        // be positioned under an innocuous-looking button and clicked by a
        // signed-in user who never saw what they approved. `frame-ancestors`
        // is the modern control and `X-Frame-Options` covers the browsers that
        // still only honour the legacy header — both, because the cost is two
        // lines and the failure mode is silent.
        source: "/oauth/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // The URL carries `state` and `code_challenge`, and the page names
          // every organization and workspace the user belongs to.
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        // The embedded widget's sign-in popup, for the same reasons plus one more.
        // Clickjacking first: this page asks for an email address and is opened
        // from a page Compass does not control, so the operator of that page must
        // not be able to wrap it — the visitor's only assurance that they are
        // typing into Compass and not into the prototype is the address bar, and
        // framing takes that away.
        //
        // `Referrer-Policy` is load-bearing here rather than merely tidy. This URL
        // carries the handoff nonce, and knowing that nonce is momentarily enough
        // to claim a scoped visitor token (see lib/embed-visitor.ts). A referrer
        // header would hand it to any third party the page ever requested
        // something from.
        source: "/embed/signin",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        // The widget script. Cached, but only briefly, and the short ceiling is the
        // point rather than a compromise: this file is loaded by pages Compass does
        // not deploy and cannot redeploy, so a stale copy cannot be flushed by
        // shipping anything — the only lever is how long a browser is willing to
        // hold it. Five minutes lets a fix propagate on its own while still
        // absorbing the repeat views of a single review session. `must-revalidate`
        // rather than `immutable` because this URL carries no version or content
        // hash, so a cached copy has no way to notice it has been superseded.
        source: "/embed/widget.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, must-revalidate" },
          // Served to pages Compass does not control, so: don't let a browser
          // second-guess the type, and don't leak the embedding page's URL if the
          // script ever causes a subresource request.
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        // Vendored third-party libraries the widget loads at runtime. Cached far
        // harder than the widget itself, because these bytes are pinned to a
        // published release and verified by the sha256 recorded in each file's own
        // header — an upgrade arrives as a reviewed commit, not as a silent change
        // under the same path. Still not `immutable`, for the same reason as above:
        // there is no version in the URL.
        source: "/vendor/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;

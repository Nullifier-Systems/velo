import type { ButtonHTMLAttributes, PropsWithChildren } from "react";

type Props = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement> & { href?: string; outline?: boolean }>;

/**
 * Shared button — reuses existing `admin-secondary` (AdminDashboard.css:7)
 * for proper padding/font-weight. Outline variant keeps same size via
 * transparent bg + 1px border using existing vars. No new stylesheet.
 */
export default function OutlineButton({ children, href, outline, style, ...rest }: Props) {
  const base: Record<string, unknown> = { fontWeight: 500, fontSize: ".9rem", fontFamily: "var(--font-sans)" };
  const outlineStyle: Record<string, unknown> = outline ? { background: "transparent", color: "var(--ink-black)", border: "1px solid var(--perforation)" } : {};
  const mergedStyle = { ...base, ...outlineStyle, ...(style as Record<string, unknown> | undefined ?? {}) };
  if (href) {
    return (
      <a href={href} className="admin-secondary" style={{ textDecoration: "none", display: "inline-block", ...mergedStyle }}>
        {children}
      </a>
    );
  }
  return (
    <button className="admin-secondary" style={mergedStyle} {...rest}>
      {children}
    </button>
  );
}

import type { ButtonHTMLAttributes, PropsWithChildren } from "react";

type Props = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement> & { href?: string; outline?: boolean }>;

/**
 * Shared button — reuses existing `admin-secondary` (AdminDashboard.css:7)
 * for proper padding/font-weight. Outline variant keeps same size via
 * transparent bg + 1px border using existing vars. No new stylesheet.
 */
export default function OutlineButton({ children, href, outline, style, ...rest }: Props) {
  const base = { fontWeight: 500, fontSize: ".9rem", fontFamily: "var(--font-sans)" } as never;
  const outlineStyle = outline ? ({ background: "transparent", color: "var(--ink-black)", border: "1px solid var(--perforation)" } as never) : undefined;
  const mergedStyle = { ...base, ...outlineStyle, ...style } as never;
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

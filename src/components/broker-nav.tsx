'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/broker/deals', label: 'Deals' },
  { href: '/broker', label: 'Clients' },
  { href: '/broker/reports', label: 'Brokerage' },
  { href: '/settings/security', label: 'Security' },
  { href: '/settings/lenders', label: 'Lenders' },
  { href: '/settings/rules', label: 'Rules' },
  { href: '/settings/integrations', label: 'Integrations' },
  { href: '/settings/import', label: 'Import' },
];

export function BrokerNav() {
  const pathname = usePathname();

  return (
    // Seven destinations do not fit across a phone. The strip scrolls sideways
    // on its own instead of widening the document — before this, `Lenders`,
    // `Integrations` and `Import` were off-screen with no way to reach them.
    // The negative margin lets it bleed to the screen edge so the cut-off item
    // is visibly cut off, which is what tells you it scrolls.
    <div className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
      {LINKS.map((link) => {
        // /broker matches everything, so it is only "current" as an exact match.
        const active =
          link.href === '/broker' ? pathname === '/broker' : pathname.startsWith(link.href);

        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? 'page' : undefined}
            className={
              'shrink-0 whitespace-nowrap rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] font-semibold transition-colors ' +
              (active
                ? 'bg-[var(--color-accent-100)] text-[var(--color-accent-700)]'
                : 'text-[var(--color-ink-500)] hover:bg-[var(--color-canvas)] hover:text-[var(--color-ink-900)]')
            }
          >
            {link.label}
          </Link>
        );
      })}
    </div>
  );
}

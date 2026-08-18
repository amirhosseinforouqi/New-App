'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/broker/deals', label: 'Deals' },
  { href: '/broker', label: 'Clients' },
];

export function BrokerNav() {
  const pathname = usePathname();

  return (
    // The scroll strip is kept even though two links fit anywhere. It costs
    // nothing while the list is short, and it is what stopped the nav widening
    // the whole document on a phone the last time the list grew.
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

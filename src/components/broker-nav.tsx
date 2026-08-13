'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/broker/deals', label: 'Deals' },
  { href: '/broker', label: 'Clients' },
  { href: '/broker/reports', label: 'Brokerage' },
  { href: '/settings/security', label: 'Security' },
  { href: '/settings/integrations', label: 'Integrations' },
];

export function BrokerNav() {
  const pathname = usePathname();

  return (
    <div className="flex gap-1">
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
              'rounded-[var(--radius-control)] px-3 py-1.5 text-[13px] font-semibold transition-colors ' +
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

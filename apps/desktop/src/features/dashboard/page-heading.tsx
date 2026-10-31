import { ReactNode } from 'react';
import { formatDashboardPage } from './lib/formatters';
import type { DashboardPage } from './lib/navigation';

type PageHeadingProps = { page: DashboardPage; children?: ReactNode };

export const PageHeading = ({ page, children }: PageHeadingProps) => (
  <div className="w-full flex items-center gap-2 justify-between flex-wrap">
    <h1 className="text-3xl font-semibold">
      {formatDashboardPage(page).title}
    </h1>
    {children}
  </div>
);

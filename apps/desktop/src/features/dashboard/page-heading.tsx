import { formatDashboardPage } from './lib/formatters';
import type { DashboardPage } from './lib/navigation';

type PageHeadingProps = { page: DashboardPage };

export const PageHeading = ({ page }: PageHeadingProps) => (
  <h1 className="text-3xl font-semibold">{formatDashboardPage(page).title}</h1>
);

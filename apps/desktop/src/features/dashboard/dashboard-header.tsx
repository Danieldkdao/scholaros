import { SidebarTrigger } from '@scholaros/ui/components/sidebar';
import { ThemeSwitcher } from './theme-switcher';

export const DashboardHeader = () => {
  return (
    <header
      data-slot="dashboard-header"
      className="flex h-14 shrink-0 items-center gap-3 border-b px-4"
    >
      <SidebarTrigger />
      <div className="ml-auto flex items-center gap-2">
        <ThemeSwitcher />
      </div>
    </header>
  );
};

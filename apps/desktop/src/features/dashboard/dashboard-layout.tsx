import { Outlet } from '@tanstack/react-router';
import {
  SidebarInset,
  SidebarProvider,
} from '@scholaros/ui/components/sidebar';
import { DashboardHeader } from './dashboard-header';
import { DashboardSidebar } from './dashboard-sidebar';

export const DashboardLayout = () => (
  <SidebarProvider className="h-svh">
    <DashboardSidebar />
    <SidebarInset className="overflow-hidden">
      <DashboardHeader />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
        <Outlet />
      </div>
    </SidebarInset>
  </SidebarProvider>
);

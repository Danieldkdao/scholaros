import { Link, useRouterState } from '@tanstack/react-router';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@scholaros/ui/components/sidebar';
import logoMarkDark from '@scholaros/assets/images/logo-dark.png';
import logoMarkLight from '@scholaros/assets/images/logo-light.png';
import { Image } from '../../components/image';
import { formatDashboardPage } from './lib/formatters';
import {
  dashboardNavigation,
  dashboardPageForPath,
  dashboardPagePath,
} from './lib/navigation';
import { ProfileMenu } from './profile-menu';

export const DashboardSidebar = () => {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const activePage = dashboardPageForPath(pathname);
  return (
    <Sidebar collapsible="icon">
      {/* The branding button is pinned to the 32px icon box, so the breathing
          room lives on the header padding and eases with the rail width. */}
      <SidebarHeader className="transition-[padding] duration-200 ease-linear group-data-[collapsible=icon]:pt-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="ScholarOS"
              className="group-data-[collapsible=icon]:justify-center pl-0.5!"
              render={<Link to="/dashboard" activeOptions={{ exact: true }} />}
            >
              <Image
                src={{ light: logoMarkLight, dark: logoMarkDark }}
                alt="ScholarOS"
                className="size-10 shrink-0 object-contain"
              />
              <span className="text-2xl font-semibold group-data-[collapsible=icon]:hidden">
                ScholarOS
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {dashboardNavigation.map((page) => {
                const { title, Icon } = formatDashboardPage(page);
                const active = page === activePage;
                return (
                  <SidebarMenuItem key={page}>
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={title}
                      aria-current={active ? 'page' : undefined}
                      className="h-9 group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:justify-center"
                      render={
                        <Link
                          to={dashboardPagePath(page)}
                          activeOptions={{ exact: true }}
                        />
                      }
                    >
                      <Icon className="size-5!" />
                      <span className="text-lg group-data-[collapsible=icon]:hidden">
                        {title}
                      </span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <ProfileMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
};

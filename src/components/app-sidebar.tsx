"use client";

import { FolderKanban, LayoutDashboard, LogOut } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { signOut } from "@/app/auth/actions";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
} from "@/components/ui/sidebar";

type Props = {
  role: "admin" | "client";
  email: string;
};

export function AppSidebar({ role, email }: Props) {
  const pathname = usePathname();

  const item =
    role === "admin"
      ? {
          href: "/admin",
          label: "Admin",
          Icon: LayoutDashboard,
          active: pathname.startsWith("/admin"),
        }
      : {
          href: "/",
          label: "Projects",
          Icon: FolderKanban,
          active: pathname === "/" || pathname.startsWith("/projects"),
        };

  return (
    <Sidebar>
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-primary text-white">
            <LayoutDashboard className="size-4" aria-hidden="true" />
          </div>
          <span className="text-base font-medium">Client Portal</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={item.active}
                  render={<Link href={item.href} />}
                >
                  <item.Icon />
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-4">
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback>
              {email ? email.charAt(0).toUpperCase() : "?"}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 truncate text-sm" title={email}>
            {email}
          </span>
        </div>
        <form action={signOut}>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton type="submit">
                <LogOut />
                <span>Sign out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </form>
      </SidebarFooter>
    </Sidebar>
  );
}

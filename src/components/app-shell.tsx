/** Authored by: Mohit Singh */
import { type ReactNode } from "react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Search, Bell, Command } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NewCrawlDialog } from "@/components/new-crawl-dialog";

export function AppShell({
  children,
  title,
  subtitle,
  actions,
}: {
  children: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background bg-grid">
        <AppSidebar />
        <div className="flex flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/70 px-4 backdrop-blur-xl">
            <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
            <div className="hidden md:flex items-center gap-2 rounded-md border border-border bg-card/60 px-3 py-1.5 text-sm text-muted-foreground w-80">
              <Search className="h-3.5 w-3.5" />
              <span>Search businesses, jobs, fields…</span>
              <kbd className="ml-auto flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                <Command className="h-3 w-3" /> K
              </kbd>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="icon" className="text-muted-foreground">
                <Bell className="h-4 w-4" />
              </Button>
              <NewCrawlDialog />
            </div>
          </header>

          <div className="flex items-end justify-between gap-4 border-b border-border/60 px-6 pt-6 pb-5">
            <div>
              <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
              {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
            </div>
            {actions && <div className="flex items-center gap-2">{actions}</div>}
          </div>

          <main className="flex-1 p-6">{children}</main>
        </div>
      </div>
    </SidebarProvider>
  );
}

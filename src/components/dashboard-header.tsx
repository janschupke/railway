import { Container } from "lucide-react";
import { SignOutButton } from "./sign-out-button";
import { ThemeToggle } from "./ui/theme-toggle";

export function DashboardHeader({ name, email }: { name?: string; email?: string }) {
  return (
    <header className="border-border bg-surface border-b">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-4 px-6 py-3">
        <span className="flex items-center gap-2">
          <Container aria-hidden className="text-accent size-4" />
          <span className="font-display text-text font-semibold tracking-tight">
            Container Console
          </span>
        </span>

        <div className="flex items-center gap-3">
          <span className="text-text-muted hidden text-sm sm:inline">
            {name ?? email ?? "Signed in"}
          </span>
          <ThemeToggle />
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}

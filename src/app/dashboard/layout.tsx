import { ToastProvider } from "@/components/ui/toast";

/**
 * Scopes the toast system to the only routes that can raise one.
 *
 * It used to sit in the root layout, which meant the landing page and the 404 shipped
 * Radix Toast — ~35 kB raw, ~12 kB gzip — to render UI that has no actions in it.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}

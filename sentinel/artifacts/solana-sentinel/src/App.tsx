import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Redirect, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Shell } from '@/components/shell';
import { OwnerSessionProvider, useOwnerSession } from '@/lib/owner-session';
import LockPage from '@/pages/lock';
import NotFound from '@/pages/not-found';
import Dashboard from '@/pages/dashboard';
import Scanner from '@/pages/scanner';
import Positions from '@/pages/positions';
import Activity from '@/pages/activity';
import Strategy from '@/pages/strategy';
import Connections from '@/pages/connections';
import Setup from '@/pages/setup';

const queryClient = new QueryClient();
const base = import.meta.env.BASE_URL.replace(/\/$/, '');
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}
function PrivateRoutes() {
  const { session, error } = useOwnerSession();
  if (!session?.authenticated || error) return <LockPage />;
  return <Shell><Switch>
    <Route path="/"><Redirect to="/dashboard" /></Route>
    <Route path="/sign-in/*?"><Redirect to="/dashboard" /></Route>
    <Route path="/sign-up/*?"><Redirect to="/dashboard" /></Route>
    <Route path="/dashboard" component={Dashboard} />
    <Route path="/scanner" component={Scanner} />
    <Route path="/positions" component={Positions} />
    <Route path="/activity" component={Activity} />
    <Route path="/strategy" component={Strategy} />
    <Route path="/connections" component={Connections} />
    <Route path="/setup" component={Setup} />
    <Route component={NotFound} />
  </Switch></Shell>;
}
export default function App() {
  return <QueryClientProvider client={queryClient}><WouterRouter base={base}>
    <OwnerSessionProvider><TooltipProvider><RoutedErrorBoundary><PrivateRoutes /></RoutedErrorBoundary><Toaster /></TooltipProvider></OwnerSessionProvider>
  </WouterRouter></QueryClientProvider>;
}

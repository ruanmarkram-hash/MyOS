import { Route, Switch, Redirect, Router } from 'wouter-preact';
import { Sidebar } from '@/components/Sidebar';
import { CommandPalette } from '@/components/CommandPalette';
import { ToastStack } from '@/components/ToastStack';
import { Placeholder } from '@/pages/Placeholder';
import { HomeDashboard } from '@/pages/HomeDashboard';
import { MissionControl } from '@/pages/MissionControl';
import { ReviewInbox } from '@/pages/ReviewInbox';
import { Brain } from '@/pages/Brain';
import { Memories } from '@/pages/Memories';
import { HiveMind } from '@/pages/HiveMind';
import { Agents } from '@/pages/Agents';
import { RuntimeStack } from '@/pages/RuntimeStack';
import { Reliability } from '@/pages/Reliability';
import { Scheduled } from '@/pages/Scheduled';
import { Audit } from '@/pages/Audit';
import { Usage } from '@/pages/Usage';
import { Settings } from '@/pages/Settings';
import { Voices } from '@/pages/Voices';
import { Chat } from '@/pages/Chat';
import { WarRoom } from '@/pages/WarRoom';
import { Files } from '@/pages/Files';
import { DEFAULT_ROUTE } from '@/lib/routes';

export function App() {
  const routeBase = window.location.pathname === '/v2' || window.location.pathname.startsWith('/v2/')
    ? '/v2'
    : '';

  return (
    <Router base={routeBase}>
      <div class="app-shell flex h-[100dvh] bg-[var(--color-bg)] text-[var(--color-text)]">
        <Sidebar />
        <main class="app-main flex-1 min-w-0 overflow-hidden">
          <Switch>
            <Route path="/home"><HomeDashboard /></Route>
            <Route path="/review"><ReviewInbox /></Route>
            <Route path="/mission"><MissionControl /></Route>
            <Route path="/scheduled"><Scheduled /></Route>
            <Route path="/agents"><Agents /></Route>
            <Route path="/chat"><Chat /></Route>
            <Route path="/runtime"><RuntimeStack /></Route>
            <Route path="/reliability"><Reliability /></Route>
            <Route path="/brain"><Brain /></Route>
            <Route path="/memories"><Memories /></Route>
            <Route path="/hive"><HiveMind /></Route>
            <Route path="/usage"><Usage /></Route>
            <Route path="/audit"><Audit /></Route>
            <Route path="/warroom"><WarRoom /></Route>
            <Route path="/voices"><Voices /></Route>
            <Route path="/files"><Files /></Route>
            <Route path="/settings"><Settings /></Route>

            <Route path="/"><Redirect to={DEFAULT_ROUTE} /></Route>
            <Route>
              <Placeholder title="Not found" description="This page does not exist. Use ⌘K to jump somewhere." />
            </Route>
          </Switch>
        </main>
        <CommandPalette />
        <ToastStack />
      </div>
    </Router>
  );
}

import {
  Home, LayoutGrid, Users, MessageSquare,
  Brain, BrainCircuit, Network, Activity, ShieldCheck,
  Radio, Cpu, Siren,
  Mic, Settings, FileText, Inbox,
} from 'lucide-preact';
import type { ComponentChildren } from 'preact';

export type RouteSection = 'workspace' | 'intelligence' | 'collaborate' | 'configure';

export interface RouteDef {
  path: string;
  label: string;
  section: RouteSection;
  icon: typeof LayoutGrid;
  shortcut?: string;
}

// Single source of truth for the sidebar, command palette, and router.
export const ROUTES: RouteDef[] = [
  { path: '/home',       label: 'Home',            section: 'workspace',    icon: Home,          shortcut: 'g d' },
  { path: '/review',     label: 'Review Inbox',    section: 'workspace',    icon: Inbox,         shortcut: 'g i' },
  { path: '/mission',    label: 'Mission Control', section: 'workspace',    icon: LayoutGrid,    shortcut: 'g m' },
  { path: '/agents',     label: 'Agents',          section: 'workspace',    icon: Users,         shortcut: 'g a' },
  { path: '/chat',       label: 'Chat',            section: 'workspace',    icon: MessageSquare, shortcut: 'g c' },
  { path: '/runtime',    label: 'Runtime Stack',   section: 'workspace',    icon: Cpu,           shortcut: 'g r' },
  { path: '/reliability', label: 'Reliability',     section: 'workspace',    icon: Siren                    },

  { path: '/brain',      label: 'Brain',           section: 'intelligence', icon: BrainCircuit,  shortcut: 'g b' },
  { path: '/memories',   label: 'Memories',        section: 'intelligence', icon: Brain,         shortcut: 'g e' },
  { path: '/hive',       label: 'Hive Mind',       section: 'intelligence', icon: Network,       shortcut: 'g h' },
  { path: '/usage',      label: 'Usage',           section: 'intelligence', icon: Activity,      shortcut: 'g u' },
  { path: '/audit',      label: 'Audit',           section: 'intelligence', icon: ShieldCheck                   },

  { path: '/warroom',    label: 'War Room',        section: 'collaborate',  icon: Radio,         shortcut: 'g w' },

  { path: '/voices',     label: 'Voices',          section: 'configure',    icon: Mic                       },
  { path: '/files',      label: 'Files',           section: 'configure',    icon: FileText,      shortcut: 'g f' },
  { path: '/settings',   label: 'Settings',        section: 'configure',    icon: Settings                  },
];

export const SECTION_LABEL: Record<RouteSection, string> = {
  workspace:    'Workspace',
  intelligence: 'Intelligence',
  collaborate:  'Collaborate',
  configure:    'Configure',
};

export const DEFAULT_ROUTE = '/home';

// Lightly typed children helper for placeholder pages.
export type PageProps = { children?: ComponentChildren };

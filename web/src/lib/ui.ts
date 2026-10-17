import {
  BarChart3,
  Bell,
  Clock,
  Info,
  List,
  Puzzle,
  Table,
  Video,
  Zap,
  type LucideIcon,
} from "lucide-react";

export type UiIconName =
  | "chart"
  | "table"
  | "video"
  | "bell"
  | "clock"
  | "list"
  | "info"
  | "zap"
  | "puzzle";

const ICONS: Record<UiIconName, LucideIcon> = {
  chart: BarChart3,
  table: Table,
  video: Video,
  bell: Bell,
  clock: Clock,
  list: List,
  info: Info,
  zap: Zap,
  puzzle: Puzzle,
};

/** Mapea el nombre de icono declarado por el plugin (resto → genérico). */
export function uiIcon(name?: string): LucideIcon {
  if (name && name in ICONS) return ICONS[name as UiIconName];
  return Puzzle;
}

export interface UiTabListItem {
  plugin: string;
  displayName: string;
  id: string;
  label: string;
  icon?: string;
  description?: string;
}
